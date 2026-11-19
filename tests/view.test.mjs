// Exercise real view/event code with an in-memory GPUI builder. This does not replace native QA.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as model from "../mods/agent-sidebar/model.js";
import * as background from "../mods/agent-sidebar/background.js";
import * as folders from "../mods/agent-sidebar/folders.js";
import * as demos from "../mods/agent-sidebar/demo.js";

function setup(initial = {}, saved = {}) {
  const commands = [];
  const overlays = [];
  const execs = [];
  const hcs = [];
  const reads = [];
  let textFile = null;
  const notes = [];
  let hcResult = { code: 0, stdout: "", stderr: "" };
  let execResult = async () => ({ code: 0, stdout: "", stderr: "" });
  let agentList = [];
  let picked = null;
  let order;
  let scrollTo;
  const state = {
    machines: [{ name: null, layout: "ready" }, { name: "work", layout: "ready" }],
    agents: [], spaces: [], panes: [], focused: { terminal: "t1" },
    terminals: [
      { address: "t1", state: "live", status: "idle", title: "Local task", program: { name: "Claude", agent: true } },
      { address: "work/t1", state: "live", status: "blocked", title: "Remote task", program: { name: "Claude", agent: true } },
    ],
  };
  const el = () => {
    const data = { nodes: [], props: {} };
    let proxy;
    proxy = new Proxy(data, { get(target, key) {
      if (key in target) return target[key];
      return (...args) => {
        if (key === "child") data.nodes.push(args[0]);
        else if (key === "children") data.nodes.push(...args[0]);
        else if (key === "when") { if (args[0]) args[1](proxy); }
        else if (key === "on_action") (data.props.actions ??= {})[args[0]] = args[1];
        else data.props[key] = args.length === 1 ? args[0] : args;
        return proxy;
      };
    } });
    return proxy;
  };
  const input = { handlers: {}, text: "", on(event, callback) { this.handlers[event] = callback; }, value() { return this.text; }, set_value(v) { this.text = v; }, focus() {} };
  const timers = [];
  const sharedState = {};
  // Tasks started with cx.spawn run when a launcher test awaits h.settle(). The sidebar's own
  // never end, so its tests leave them queued.
  const tasks = [];
  const bound = [];
  const cx = { notify() {}, stop_propagation() {}, bind_keys(list) { bound.push(...list); return list.length; }, spawn(f) { tasks.push(f); }, focus_handle() { return { focus() {} }; }, timer: { every(ms) { timers.push(ms); } } };
  // Each view gets its own storage, as each Herdr mod copy does.
  const storage = { data: { ...saved }, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = String(v); } };
  const imports = {
    // svg's path is kept as props.src, so a test can tell glyphs apart.
    View: class {}, div: el, svg: path => el().src(path), image: el, h_flex: el, v_flex: el,
    InputState: { new: () => input }, Input: { new: el }, ScrollHandle: { new: () => ({ scroll_to_item(i) { scrollTo = i; } }) },
    ...Object.fromEntries(Object.keys(state).map(k => [k, () => state[k]])),
    focused: () => state.focused, theme: () => new Proxy({}, { get: () => "#aabbcc" }), settings: () => ({ zoom: 1 }),
    run: (name, args) => commands.push({ name, args }), setAgentOrder: addresses => { order = addresses; }, nextCommand: () => new Promise(() => {}),
    openOverlay: spec => overlays.push(spec), closeOverlay() {}, props: () => ({ ...initial, overlay: "popup" }), knownAgents: async () => agentList,
    home: () => "/Users/me", pickFolder: async () => picked, window: () => ({ platform: "macos" }),
    localStorage: storage, shared: key => sharedState[key], setShared: (key, value) => { sharedState[key] = value; },
    updates: () => ({ app: { ready: null } }),
    exec: (...args) => { execs.push(args); return execResult(...args); },
    hc: async args => { hcs.push(args); return hcResult; }, notify: note => { notes.push(note); return "n1"; },
    readTextFile: async path => { reads.push(path); return textFile; },
    ...model, ...background, ...folders, demo: demos.demo,
  };
  const launcherSource = readFileSync(new URL("../mods/agent-sidebar/launcher.js", import.meta.url), "utf8").replace(/^import [\s\S]*?;$/gm, "").replace(/export (function|const)/g, "$1");
  Object.assign(imports, new Function(...Object.keys(imports), `${launcherSource}\nreturn { initLauncher, renderLauncher, LAUNCHER };`)(...Object.values(imports)));
  const settingsSource = readFileSync(new URL("../mods/agent-sidebar/settings.js", import.meta.url), "utf8").replace(/^import [\s\S]*?;$/gm, "").replace(/export (function|const)/g, "$1");
  Object.assign(imports, new Function(...Object.keys(imports), `${settingsSource}\nreturn { initSettings, renderSettings, SETTINGS };`)(...Object.values(imports)));
  const source = readFileSync(new URL("../mods/agent-sidebar/main.js", import.meta.url), "utf8").replace(/^import [\s\S]*?;$/gm, "").replace("export default class", "return class");
  const View = new Function(...Object.keys(imports), source)(...Object.values(imports));
  delete globalThis.sessionLauncherKeys; // each test is a fresh app: its keymap is empty
  const view = new View();
  // GPUI init receives its own props; Herdr supplies overlay props through herdr.props().
  view.init({}, cx);
  const settle = async () => { while (tasks.length) await tasks.shift()(cx); };
  return { view, cx, input, state, commands, overlays, storage, timers, sharedState, execs, settle, hcs, notes, hcFails: stderr => { hcResult = { code: 1, stdout: "", stderr }; }, reads, file: text => { textFile = text; },
    answer: f => { execResult = f; }, agents: list => { agentList = list; }, pick: path => { picked = path; },
    order: () => order, scrollTo: () => scrollTo, bound };
}
// The svg glyphs under a node, by their file.
const glyphs = node => !node || typeof node !== "object" ? [] : [...(node.props.src ? [node] : []), ...node.nodes.flatMap(glyphs)];
function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.props?.id === id) return node;
  for (const child of node.nodes) { const match = find(child, id); if (match) return match; }
  return null;
}

test("there is no search field and no filters: Up, Down and Enter pick the correct remote agent", () => {
  const h = setup();
  let root = h.view.render();
  assert.deepEqual(ids(root).filter(id => /search|filter/.test(id)), []);
  assert.deepEqual(h.order(), ["t1", "work/t1"]);
  // Enter with nothing picked opens nothing.
  root.props.on_key_down({ key: "enter" }, h.cx);
  assert.deepEqual(h.commands, []);
  root.props.on_key_down({ key: "down" }, h.cx);
  root.props.on_key_down({ key: "down" }, h.cx);
  assert.equal(h.scrollTo(), 5); // two host headings, two section headings and the local row
  h.view.render().props.on_key_down({ key: "enter" }, h.cx);
  assert.deepEqual(h.commands, [{ name: "terminal.peek", args: { terminal: "work/t1" } }]);
  // Escape goes back to the session you are in.
  h.view.render().props.on_key_down({ key: "escape" }, h.cx);
  assert.equal(h.view.selected, null);
  assert.deepEqual(h.commands.at(-1), { name: "terminal.peek", args: { terminal: "t1" } });
});

test("folding updates the visible navigation order without losing agents", () => {
  const h = setup();
  let root = h.view.render();
  find(root, "host-local").props.on_click(null, h.cx);
  root = h.view.render();
  assert.deepEqual(h.order(), ["work/t1"]);
  assert.equal(find(root, "agent-t1"), null);
  find(root, "host-local").props.on_click(null, h.cx);
  h.view.render();
  assert.deepEqual(h.order(), ["t1", "work/t1"]);
});

test("narrow rail can expand and disconnected rows never issue navigation", () => {
  const h = setup();
  h.state.machines[1].layout = "unavailable";
  h.view.width = 76;
  let root = h.view.render();
  // Its sessions stay out of the rail until its mark is clicked.
  assert.equal(find(root, "agent-work/t1"), null);
  find(root, "host-remote:work").props.on_click(null, h.cx);
  root = h.view.render();
  find(root, "agent-work/t1").props.on_click();
  assert.deepEqual(h.commands, []);
  find(root, "expand-agents").props.on_click();
  assert.deepEqual(h.commands, [{ name: "layout.resize", args: { id: "sidebar", px: 320 } }]);
  // The rail has no footer: its expand control is at the top, before the host list.
  assert.equal(root.nodes.at(-1).props.id, "host-agent-list");
});

test("empty, all statuses, picture icons, parent agents and pin branches render", () => {
  const h = setup();
  h.state.terminals.push(...["working", "done", null].map((status, i) => ({ address: `t${i+2}`, state: "live", status, parent: "t1", program: { agent: true, icon: "test.png", tint: false }, labels: { "herdr.pinned": "true" } })));
  h.view.render();
  assert.equal(h.order().length, 5);
  h.state.terminals = [];
  h.view.render();
  assert.equal(h.order().length, 0);
  assert.doesNotThrow(() => h.view.render());
});

test("shells appear and navigate without entering Herdr's agent-only cycle", () => {
  const h = setup();
  h.state.terminals.push({ address: "work/shell", state: "live", program: { name: "zsh", shell: true }, cwd: "/work/app" });
  const root = h.view.render();
  find(root, "agent-work/shell").props.on_click();
  assert.deepEqual(h.commands, [{ name: "terminal.peek", args: { terminal: "work/shell" } }]);
  assert.deepEqual(h.order(), ["t1", "work/t1"]);
  assert.equal(h.view.visible.length, 3);
});

test("host add buttons stay available in the rail, target the host and do not fold it", () => {
  const h = setup();
  h.view.width = 76;
  let stopped = false;
  const root = h.view.render();
  find(root, "new-local").props.on_click(null, { stop_propagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(h.view.folded.size, 0);
  assert.deepEqual(h.overlays[0].props, { launcher: true, machine: null });
  find(root, "new-remote:work").props.on_click(null, h.cx);
  assert.deepEqual(h.overlays[1].props, { launcher: true, machine: "work" });
  // A session can't start on a machine that is connecting; one that is away has no + at all.
  h.state.machines[1].layout = "loading";
  find(h.view.render(), "new-remote:work").props.on_click(null, h.cx);
  assert.equal(h.overlays.length, 2);
  h.state.machines[1].layout = "unavailable";
  assert.equal(find(h.view.render(), "new-remote:work"), null);
});

test("launcher starts a shell on its host and guards against a disconnect after opening", () => {
  const h = setup({ launcher: true, machine: "work" });
  find(h.view.render(), "launch-shell").props.on_click();
  assert.deepEqual(h.commands, [{ name: "space.new", args: { machine: "work" } }]);
  h.state.machines[1].layout = "unavailable";
  find(h.view.render(), "launch-shell").props.on_click();
  assert.equal(h.commands.length, 1);
});

test("a host + opens the creation menu using Herdr overlay props, without rendering another sidebar", () => {
  const sidebar = setup();
  find(sidebar.view.render(), "new-remote:work").props.on_click(null, sidebar.cx);
  const popup = setup(sidebar.overlays[0].props);
  const menu = popup.view.render();
  assert.ok(find(menu, "session-launcher"));
  assert.ok(find(menu, "launch-shell"));
  assert.equal(find(menu, "agent-sidebar"), null);
  popup.view.loading = false;
  popup.view.choices = [{ key: "codex", name: "Codex", run: ["codex"], installed: true }];
  find(popup.view.render(), "launch-codex").props.on_click();
  assert.deepEqual(popup.commands, [{ name: "space.new", args: { machine: "work", name: "Codex", argv: ["codex"] } }]);
});

function text(node) {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  return node.nodes.map(text).join(" ");
}
const ids = node => !node || typeof node !== "object" ? [] : [node.props.id, ...node.nodes.flatMap(ids)].filter(Boolean);

test("each host lists its sessions under Needs you, Done, Working, Pinned and Idle, shells among them", () => {
  const h = setup();
  h.state.terminals = [
    { address: "t1", state: "live", status: "idle", program: { name: "Claude", agent: true }, title: "Idle task" },
    { address: "t2", state: "live", status: "working", program: { name: "Claude", agent: true }, title: "Busy task" },
    { address: "t3", state: "live", status: "done", program: { name: "Claude", agent: true }, title: "Done task" },
    { address: "t4", state: "live", status: "idle", program: { name: "Claude", agent: true }, title: "Kept task", labels: { "herdr.pinned": "true" } },
    { address: "t5", state: "live", program: { name: "zsh", shell: true }, cwd: "/code/app" },
    { address: "work/t1", state: "live", status: "blocked", program: { name: "Claude", agent: true }, title: "Remote task" },
  ];
  const root = h.view.render();
  const list = find(root, "host-agent-list").nodes.map(n => n.props.id);
  assert.deepEqual(list, [
    "host-local", "section-local:done", "agent-t3", "section-local:working", "agent-t2",
    "section-local:pinned", "agent-t4", "section-local:idle", "agent-t1", "agent-t5",
    "host-remote:work", "section-remote:work:blocked", "agent-work/t1", "add-machine",
  ]);
  assert.match(text(find(root, "section-remote:work:blocked")), /Needs you 1/);
  assert.match(text(find(root, "section-local:idle")), /Idle 2/);
});

test("folding a section hides its rows from navigation and is remembered by the next copy", () => {
  const h = setup();
  h.state.terminals.push({ address: "t2", state: "live", status: "working", program: { name: "Claude", agent: true }, title: "Busy" });
  h.state.focused = { terminal: "t2" }; // the session you are in stays in view (tested below)
  let root = h.view.render();
  find(root, "section-local:idle").props.on_click(null, h.cx);
  root = h.view.render();
  assert.equal(find(root, "agent-t1"), null);
  assert.ok(find(root, "section-local:idle"));
  assert.deepEqual(h.order(), ["t2", "work/t1"]);
  const next = setup({}, h.storage.data);
  next.state.terminals = h.state.terminals;
  next.state.focused = h.state.focused;
  next.view.render();
  assert.deepEqual(next.order(), ["t2", "work/t1"]);
});

test("a folded host summarizes what needs you, works and is done", () => {
  const h = setup();
  h.state.terminals.push({ address: "work/t2", state: "live", status: "working", program: { name: "Claude", agent: true } });
  let root = h.view.render();
  assert.equal(glyphs(find(root, "host-remote:work")).some(g => /attention/.test(g.props.src)), false); // open: no summary
  find(root, "host-remote:work").props.on_click(null, h.cx);
  root = h.view.render();
  const header = find(root, "host-remote:work");
  assert.equal(find(root, "agent-work/t1"), null);
  assert.deepEqual(header.nodes.map(n => n.props?.tooltip).filter(tip => /needs you|working|done/.test(tip ?? "")), ["1 needs you", "1 working"]);
});

test("sub-agents sit under their parent and lift it into their most urgent section", () => {
  const h = setup();
  h.state.terminals = [
    { address: "t1", state: "live", status: "idle", program: { name: "Claude", agent: true }, title: "Parent" },
    { address: "t2", state: "live", status: "blocked", parent: "t1", program: { name: "Claude", agent: true }, title: "Child" },
    { address: "t3", state: "live", status: "done", parent: "t1", program: { name: "Claude", agent: true }, title: "Finished child" },
  ];
  const root = h.view.render();
  assert.deepEqual(find(root, "host-agent-list").nodes.map(n => n.props.id).slice(0, 5),
    ["host-local", "section-local:blocked", "agent-t1", "agent-t2", "agent-t3"]);
  assert.ok(find(root, "agent-t2").props.pl > find(root, "agent-t1").props.pl);
});

test("hovering a row offers pin and unpin without opening the session", () => {
  const h = setup();
  let root = h.view.render();
  find(root, "agent-t1").props.on_hover(true, h.cx);
  root = h.view.render();
  let stopped = false;
  find(root, "pin-t1").props.on_click(null, { stop_propagation() { stopped = true; }, notify() {} });
  assert.equal(stopped, true);
  assert.deepEqual(h.commands, [{ name: "terminal.pin", args: { terminal: "t1", pinned: true } }]);
  assert.equal(find(h.view.render(), "pin-t1"), null);
});

test("agent rows show how long they have been in their state; shells do not", () => {
  const h = setup();
  const now = Date.now();
  h.state.terminals[0].status_ms = now - 4 * 60000;
  h.state.terminals.push({ address: "t9", state: "live", program: { name: "zsh", shell: true }, created_ms: now - 3600000 });
  const root = h.view.render();
  assert.match(text(find(root, "agent-t1")), /\b4m\b/);
  assert.doesNotMatch(text(find(root, "agent-t9")), /\dh|\dm/);
  assert.deepEqual(h.timers, [30000]);
});

test("no footer: Settings sits in the header and Add machine follows the hosts", () => {
  const h = setup();
  let root = h.view.render();
  const list = find(root, "host-agent-list");
  assert.equal(list.nodes.at(-1).props.id, "add-machine");
  assert.equal(root.nodes.at(-1), list); // the list is the last thing in the sidebar
  // The gear is the sidebar's own settings, in a window; Herdr's are inside it.
  find(root, "settings").props.on_click();
  find(root, "add-machine").props.on_click();
  assert.deepEqual(h.overlays, [{ mod: "agent-sidebar", kind: "dialog", width: 660, height: 520, props: { settings: true } }]);
  assert.deepEqual(h.commands, [{ name: "mod.open", args: { name: "machine-add" } }]);
});

test("the rail expands to the width Herdr's sidebar toggle remembered", () => {
  const h = setup();
  h.view.width = 76;
  h.sharedState["sidebar.width"] = 288;
  h.sharedState["sidebar.collapsed"] = true;
  const root = h.view.render();
  assert.ok(find(root, "add-machine") && find(root, "settings"));
  find(root, "expand-agents").props.on_click();
  assert.deepEqual(h.commands.at(-1), { name: "layout.resize", args: { id: "sidebar", px: 288 } });
  assert.equal(h.sharedState["sidebar.collapsed"], false);
});

test("an agent waiting on background work sits in Working with a pulsing mark that says why", () => {
  const h = setup();
  const now = Date.now();
  h.state.terminals = [
    { address: "t1", state: "live", status: "done", status_ms: now - 12 * 60000, title: "Fix login", program: { name: "Claude", agent: true }, foreground: { pid: 501 } },
    { address: "t2", state: "live", status: "working", title: "Port parser", program: { name: "Claude", agent: true }, foreground: { pid: 502 } },
  ];
  h.view.work = new Map([
    ["t1", { at: now, session: { status: "shell" }, goal: null, shells: [{ text: "npm test", started: now - 4 * 60000 }] }],
    ["t2", { at: now, session: { status: "busy" }, goal: { condition: "Port the parser", check: "" }, shells: [] }],
  ]);
  const root = h.view.render();
  const list = find(root, "host-agent-list").nodes.map(n => n.props.id);
  assert.deepEqual(list.slice(0, 4), ["host-local", "section-local:working", "agent-t1", "agent-t2"]);
  const t1 = find(root, "agent-t1");
  const mark = glyphs(t1).find(g => /terminal\.svg$/.test(g.props.src));
  assert.deepEqual(mark.props.loop, ["opacity", { from: 0.4, to: 1, period: 1600 }]);
  assert.match(t1.props.tooltip, /Working in the background · 12m\nShell: npm test · 4m/);
  // The goal flag shows beside a working agent; its mark stays the spinner.
  const t2 = find(root, "agent-t2");
  assert.equal(find(t2, "goal-t2").props.tooltip, "Goal: Port the parser");
  assert.ok(glyphs(t2).some(g => /spinner\.svg$/.test(g.props.src)));
  // Both count as working, and neither as done.
  assert.match(text(find(root, "section-local:working")), /Working 2/);
  assert.equal(find(root, "section-local:done"), null);
});

// Lets every pending exec answer and the view take it in.
const settle = () => new Promise(resolve => setImmediate(resolve));

test("each machine is asked on its own, with what it already read, and keeps its reading through failures", async () => {
  const h = setup();
  h.state.terminals = [
    { address: "t1", state: "live", status: "done", program: { name: "Claude", agent: true }, foreground: { pid: 501 } },
    { address: "work/t1", state: "live", status: "idle", program: { name: "Claude", agent: true }, foreground: { pid: 77 } },
    { address: "t2", state: "live", program: { name: "zsh", shell: true }, foreground: { pid: 600 } },
  ];
  h.view.render();
  assert.deepEqual([...h.view.stale], [null, "work"]); // the first statuses ask for a look at once
  const goal = JSON.stringify({ type: "attachment", attachment: { type: "goal_status", met: false, sentinel: true, condition: "Ship" } });
  h.answer(async (_cmd, _args, opts) => ({ code: 0, stderr: "", stdout: opts.on === "work"
    ? "P 77 1 01:00 claude\nP 78 77 00:30 /bin/zsh -c source /h/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'make' < /dev/null\n"
    : `P 501 1 01:00 claude\nS 501 {"sessionId":"s1","status":"idle"}\nL 501 s1\nZ s1 500\nG s1 *\nG s1 * ${goal}\n` }));
  let answers = 0;
  h.view.probe(() => answers++);
  await settle();
  assert.equal(answers, 2);
  assert.deepEqual(h.execs.map(([cmd, args, opts]) => [cmd, args[0], args.slice(3), opts.on]), [["sh", "-c", ["501"], null], ["sh", "-c", ["77"], "work"]]);
  assert.equal(h.execs[0][1][1], background.PROBE);
  assert.deepEqual(h.view.work.get("t1").goal, { condition: "Ship", check: "" });
  assert.deepEqual(h.view.work.get("work/t1").shells.map(s => s.text), ["make"]);
  assert.equal(h.view.changed, true);
  let rows = model.build({ terminals: h.state.terminals, machines: h.state.machines, work: h.view.work });
  assert.deepEqual(rows.filter(r => r.kind === "agent").map(r => [r.address, r.status, r.background.join()]), [["t1", "working", "goal"], ["work/t1", "working", "shell"]]);
  // Nothing is due yet: nobody is asked.
  h.view.probe(() => answers++);
  assert.equal(h.execs.length, 2);
  // Ten seconds on: each sends what it already read. A machine that can't be reached, or
  // whose script fails, keeps its last reading.
  for (const machine of [null, "work"]) h.view.asked.set(machine, Date.now() - background.PROBE_MS);
  h.answer(async (_cmd, _args, opts) => {
    if (opts.on === "work") throw new Error("unreachable");
    return { code: 1, stderr: "ps: failed", stdout: "" };
  });
  h.view.probe(() => answers++);
  await settle();
  assert.deepEqual(h.execs.slice(2).map(([, args]) => args.slice(3)), [["501", "s1=500"], ["77"]]);
  assert.deepEqual(h.view.work.get("t1").goal, { condition: "Ship", check: "" });
  assert.deepEqual(h.view.work.get("work/t1").shells.map(s => s.text), ["make"]);
  // A status change asks that machine again, once a second at most; an unchanged render does not.
  h.view.render();
  assert.deepEqual([...h.view.stale], []);
  h.state.terminals[0].status = "working";
  h.view.render();
  assert.deepEqual([...h.view.stale], [null]);
  h.view.probe(() => answers++);
  assert.equal(h.execs.length, 4); // asked under a second ago
  h.view.asked.set(null, Date.now() - 1000);
  // A machine that is slow to answer holds up no other, and is not asked twice meanwhile.
  h.answer(async (_cmd, _args, opts) => opts.on === "work" ? new Promise(() => {}) : { code: 0, stderr: "", stdout: "P 501 1 01:10 claude\nL 501 s1\nZ s1 500\n" });
  h.view.asked.set("work", 0);
  h.view.probe(() => answers++);
  await settle();
  assert.deepEqual(h.execs.slice(4).map(([, , opts]) => opts.on), [null, "work"]);
  assert.deepEqual([...h.view.asking], ["work"]);
  h.view.asked.set(null, 0);
  h.view.probe(() => answers++);
  await settle();
  assert.deepEqual(h.execs.slice(6).map(([, , opts]) => opts.on), [null]);
  // A machine whose agents are all gone is forgotten.
  h.state.terminals = h.state.terminals.filter(t => t.address !== "t1");
  h.view.render();
  h.view.probe(() => answers++);
  assert.equal(h.view.work.has("t1"), false);
  assert.equal(h.view.read.has(null), false);
  rows = model.build({ terminals: h.state.terminals, machines: h.state.machines, work: h.view.work });
  assert.ok(rows.length);
});

test("Claude Code's own sub-agents sit under their session, open it, and count as part of it", () => {
  const h = setup();
  const now = Date.now();
  h.state.terminals = [
    { address: "t1", state: "live", status: "idle", status_ms: now - 60000, title: "Release review", program: { name: "Claude", agent: true }, foreground: { pid: 501 } },
    { address: "work/t1", state: "live", status: "blocked", title: "Remote task", program: { name: "Claude", agent: true } },
  ];
  h.state.panes = [{ terminal: "t1", pane: "p1", tab: "tab1" }];
  h.view.work = new Map([["t1", { at: now, session: { status: "busy" }, goal: null, shells: [], subagents: [
    { id: "a1", type: "general-high", description: "Review the repo", background: true, started: now - 3 * 60000 },
  ] }]]);
  let root = h.view.render();
  const list = find(root, "host-agent-list").nodes.map(n => n.props.id);
  assert.deepEqual(list.slice(0, 4), ["host-local", "section-local:working", "agent-t1", "agent-t1#a1"]);
  const parent = find(root, "agent-t1");
  const sub = find(root, "agent-t1#a1");
  assert.ok(sub.props.pl > parent.props.pl);
  assert.match(parent.props.tooltip, /Sub-agent: Review the repo/);
  assert.match(sub.props.tooltip, /^Review the repo\nSub-agent, in the background · general-high\nLocal\nWorking · 3m/);
  assert.match(text(sub), /Review the repo general-high 3m/);
  // Counted as part of its session, and not a terminal for next/previous agent.
  assert.equal(text(find(root, "sessions-count")), "2");
  assert.match(text(find(root, "section-local:working")), /Working 1/);
  assert.match(text(find(root, "host-local")), /^\s*Local 1/);
  assert.deepEqual(h.order(), ["t1", "work/t1"]);
  // No pin on hover; a click opens the session.
  sub.props.on_hover(true, h.cx);
  root = h.view.render();
  assert.equal(find(root, "pin-t1#a1"), null);
  find(root, "agent-t1#a1").props.on_click();
  assert.deepEqual(h.commands, [{ name: "pane.focus", args: { pane: "p1" } }]);
});

// The launcher behind each +: a folder first, then what to start there.
function launcherSetup(machine = null) {
  const h = setup({ launcher: true, machine });
  h.state.spaces = [{ id: "s1", name: "api", machine: null, folder: "/Users/me/api", active: true, tabs: [{ id: "a1" }] }];
  h.state.panes = [{ pane: "p1", tab: "a1", terminal: "t1", cwd: "/Users/me/api/server" }];
  h.state.focused = { space: "s1", terminal: "t1", cwd: "/Users/me/api/server" };
  return h;
}
const folderPaths = root => ids(root).filter(id => /^folder-\d+$/.test(id)).map(id => find(root, id).props.tooltip);
const claude = { key: "claude", name: "Claude Code", run: ["claude"], installed: true, icon: null };

test("the launcher offers the folder in focus first and starts a shell there as a tab of its space", () => {
  const h = launcherSetup();
  const root = h.view.render();
  assert.deepEqual(folderPaths(root), ["~/api/server", "~/api", "~"]);
  assert.equal(find(root, "folder-0").props.aria_selected, true);
  assert.equal(find(root, "where-tab").props.aria_selected, true);
  find(root, "launch-shell").props.on_click();
  assert.deepEqual(h.commands, [{ name: "tab.new", args: { folder: "/Users/me/api/server", space: "s1" } }]);
  assert.deepEqual(h.sharedState["agent-sidebar.recent"], { "": ["/Users/me/api/server"] });
  assert.deepEqual(h.sharedState["agent-sidebar.last"], { "": "shell" });
});

test("the launcher's keys choose a folder and an agent; Enter starts the one last started", async () => {
  const h = launcherSetup();
  h.agents([claude, { key: "codex", name: "Codex", run: ["codex"], installed: false }]);
  await h.settle();
  // Its projects are looked for on its machine.
  assert.equal(h.execs[0][1][1].includes("$HOME/workspace"), true);
  assert.equal(h.execs[0][2].on, null);
  let root = h.view.render();
  assert.equal(find(root, "launch-codex"), null); // not installed
  root.props.on_key_down({ key: "down", keystroke: "down" }, h.cx);
  root = h.view.render();
  assert.equal(find(root, "folder-1").props.aria_selected, true);
  // A folder with no terminal of a space in it gets a new space unless the person asks.
  root.props.on_key_down({ key: "down", keystroke: "down" }, h.cx);
  root = h.view.render();
  assert.equal(find(root, "where-space").props.aria_selected, true);
  find(root, "where-tab").props.on_click(null, h.cx);
  root.props.on_key_down({ key: "2", keystroke: "cmd-2", modifiers: { platform: true } }, h.cx); // Herdr's: tab 2
  assert.deepEqual(h.commands, []);
  root.props.on_key_down({ key: "2", keystroke: "alt-2", modifiers: { alt: true } }, h.cx);
  assert.deepEqual(h.commands, [{ name: "tab.new", args: { name: "Claude Code", argv: ["claude"], folder: "/Users/me", space: "s1" } }]);

  const again = launcherSetup();
  again.sharedState["agent-sidebar.last"] = h.sharedState["agent-sidebar.last"];
  again.sharedState["agent-sidebar.agents"] = h.sharedState["agent-sidebar.agents"];
  again.view.init({}, again.cx); // a new popup, opened with what the last one kept
  root = again.view.render();
  // The last answer about agents shows at once, and the one started last takes Enter.
  assert.match(text(find(root, "launch-claude")), /↵/);
  assert.deepEqual(folderPaths(root), ["~/api/server", "~/api", "~"]); // Home was recorded only as "~"
  again.input.handlers.submit();
  assert.deepEqual(again.commands[0], { name: "tab.new", args: { name: "Claude Code", argv: ["claude"], folder: "/Users/me/api/server", space: "s1" } });
});

test("a typed path lists the folders inside it on that machine, and / goes into the one chosen", async () => {
  const h = launcherSetup("work");
  h.answer(async (_cmd, args) => args[1].includes("cd \"$d\"")
    ? { code: 0, stdout: `/home/me\n${args[3] === "~/src" ? "/home/me/src\nweb\napi\n" : "/home/me/src/api\n"}`, stderr: "" }
    : { code: 1, stdout: "", stderr: "" });
  const type = value => { h.input.text = value; h.input.handlers.change(null, h.cx); };
  type("~/src/");
  assert.match(text(h.view.render()), /Looking/);
  await h.settle();
  const listed = () => h.execs.filter(([, args]) => args[1].includes("cd \"$d\"")).map(([, args, opts]) => [args[3], opts.on]);
  assert.deepEqual(listed(), [["~/src", "work"]]);
  let root = h.view.render();
  assert.deepEqual(folderPaths(root), ["~/src", "~/src/web", "~/src/api"]);
  // Typing on inside the same folder filters without asking again.
  type("~/src/a");
  root = h.view.render();
  assert.deepEqual(folderPaths(root), ["~/src/api"]);
  // "/" after part of a name completes it.
  type("~/src/a/");
  assert.equal(h.input.text, "~/src/api/");
  await h.settle();
  assert.deepEqual(listed(), [["~/src", "work"], ["~/src/api", "work"]]);
  root = h.view.render();
  assert.deepEqual(folderPaths(root), ["~/src/api"]);
  find(root, "launch-shell").props.on_click();
  // No space of that machine: a new space there.
  assert.deepEqual(h.commands, [{ name: "space.new", args: { folder: "/home/me/src/api", machine: "work" } }]);
});

test("/ after a search goes into the folder chosen; after the folder itself it is just typed", () => {
  const h = launcherSetup();
  const type = value => { h.input.text = value; h.input.handlers.change(null, h.cx); };
  type("api");
  h.view.render();
  type("api/");
  assert.equal(h.input.text, "~/api/"); // the exact name ranks first
  type("~");
  type("~/");
  assert.equal(h.input.text, "~/");
});

test("Option-Up and Option-Down move Enter's program through the list and back; it shows which", async () => {
  const h = launcherSetup();
  h.agents([claude, { key: "codex", name: "Codex", run: ["codex"], installed: true }]);
  await h.settle();
  const step = up => h.view.render().props.on_key_down({ key: up ? "up" : "down", keystroke: up ? "alt-up" : "alt-down", modifiers: { alt: true } }, h.cx);
  let root = h.view.render();
  assert.equal(find(root, "launch-shell").props.aria_selected, true); // nothing started yet: a shell
  step(false);
  step(false);
  root = h.view.render();
  assert.equal(find(root, "launch-codex").props.aria_selected, true);
  assert.match(text(find(root, "launch-codex")), /↵/);
  assert.equal(find(root, "folder-0").props.aria_selected, true); // the folder stays
  step(false); // wraps
  step(true); // and back
  h.input.handlers.submit();
  assert.deepEqual(h.commands, [{ name: "tab.new", args: { name: "Codex", argv: ["codex"], folder: "/Users/me/api/server", space: "s1" } }]);
});

test("Tab moves the launcher to the next ready machine and back; what is typed searches there", async () => {
  const h = launcherSetup();
  h.state.machines.push({ name: "gone", layout: "unavailable" }, { name: "lab", layout: "ready" });
  const asked = [];
  h.answer(async (_cmd, args, opts) => {
    if (args[1].includes("cd \"$d\"")) {
      asked.push([args[3], opts.on]);
      return { code: 0, stdout: `/home/me\n/home/me/src\n${opts.on ?? "local"}-app\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  });
  await h.settle();
  // The window's own ⇥ binding would take the key first: the launcher binds it in its context.
  assert.deepEqual(h.bound.filter(k => k.context === "SessionLauncher").map(k => k.keystroke), ["tab", "shift-tab"]);
  const tab = shift => {
    const root = h.view.render();
    assert.equal(root.props.key_context, "SessionLauncher");
    const binding = h.bound.find(k => k.keystroke === (shift ? "shift-tab" : "tab"));
    root.props.actions[binding.action](null, h.cx);
  };
  let root = h.view.render();
  // Only ready machines are tabs; the one shown is selected.
  assert.deepEqual(ids(find(root, "launcher-machines")).filter(id => id.startsWith("machine-")), ["machine-local", "machine-work", "machine-lab"]);
  assert.equal(find(root, "machine-local").props.aria_selected, true);
  assert.match(text(root), /⇥ machine/);
  h.input.text = "~/src/";
  h.input.handlers.change(null, h.cx);
  await h.settle();
  tab(false);
  root = h.view.render();
  assert.equal(h.view.machine, "work");
  assert.equal(find(root, "machine-work").props.aria_selected, true);
  assert.equal(find(root, "launcher-browse"), null); // the system's picker is this computer's
  await h.settle();
  // The typed path is listed again, on that machine.
  assert.deepEqual(asked, [["~/src", null], ["~/src", "work"]]);
  root = h.view.render();
  assert.deepEqual(folderPaths(root), ["~/src", "~/src/work-app"]);
  find(root, "folder-1").props.on_click(null, h.cx);
  find(h.view.render(), "launch-shell").props.on_click();
  assert.deepEqual(h.commands, [{ name: "space.new", args: { folder: "/home/me/src/work-app", machine: "work" } }]);
  tab(false); // skips the unavailable one
  assert.equal(h.view.machine, "lab");
  tab(false); // wraps
  assert.equal(h.view.machine, null);
  tab(true); // and back
  assert.equal(h.view.machine, "lab");
});

test("a click on a machine in the header moves the launcher there; a late answer from the last one is kept, not shown", async () => {
  const h = launcherSetup();
  h.agents([claude]);
  // Each machine's projects: this computer's scan answers only after the move.
  h.answer(async (_cmd, args, opts) => args[1].includes("$HOME/workspace")
    ? { code: 0, stdout: opts.on ? "/home/me\n/home/me/workspace/remote-app\n" : "/Users/me\n/Users/me/workspace/local-app\n", stderr: "" }
    : { code: 1, stdout: "", stderr: "" });
  find(h.view.render(), "machine-work").props.on_click(null, h.cx);
  let root = h.view.render();
  assert.equal(h.view.machine, "work");
  assert.equal(find(root, "machine-work").props.aria_selected, true);
  assert.equal(find(root, "machine-work").props.on_click, undefined); // already there
  await h.settle();
  root = h.view.render();
  assert.ok(folderPaths(root).includes("~/workspace/remote-app"));
  assert.ok(!folderPaths(root).some(path => path.includes("local-app")));
  assert.ok(find(root, "launch-claude"));
  // Both answers are kept for the next launcher, each under its machine.
  assert.deepEqual(Object.keys(h.sharedState["agent-sidebar.scan"] ?? {}).sort(), ["", "work"]);
  // Back on this computer, its own answer shows at once.
  find(root, "machine-local").props.on_click(null, h.cx);
  assert.ok(folderPaths(h.view.render()).includes("~/workspace/local-app"));
});

test("with one machine the launcher shows it plainly, without tabs", () => {
  const h = launcherSetup();
  h.state.machines = [{ name: null, layout: "ready" }];
  const root = h.view.render();
  assert.equal(find(root, "launcher-machines"), null);
  assert.match(text(root), /Local/);
  assert.doesNotMatch(text(root), /LOCAL/);
  assert.doesNotMatch(text(root), /⇥ machine/);
});

test("a typed folder that is not there says so and starts nothing", async () => {
  const h = launcherSetup();
  h.answer(async () => ({ code: 3, stdout: "", stderr: "" }));
  h.input.text = "/nope/";
  h.input.handlers.change(null, h.cx);
  await h.settle();
  const root = h.view.render();
  assert.match(text(root), /No folder \/nope on Local/);
  find(root, "launch-shell").props.on_click();
  assert.deepEqual(h.commands, []);
});

test("Browse closes the popup for the system's picker; the sidebar reopens the launcher with the folder", async () => {
  const h = launcherSetup();
  find(h.view.render(), "launcher-browse").props.on_click(null, h.cx);
  assert.deepEqual(h.commands, [{ name: "agent-sidebar.browse", args: undefined }]);
  assert.equal(find(launcherSetup("work").view.render(), "launcher-browse"), null); // this computer's picker only

  const sidebar = setup();
  sidebar.pick("/Users/me/picked");
  await sidebar.view.browse();
  assert.deepEqual(sidebar.overlays[0].props, { launcher: true, machine: null, folder: "/Users/me/picked", tag: "Picked" });
  assert.equal(sidebar.overlays[0].kind, "dialog");
  const picked = setup(sidebar.overlays[0].props);
  assert.deepEqual(text(find(picked.view.render(), "folder-0")).trim().split(/\s+/), ["picked", "~", "Picked"]);
});

test("hovering a session offers a new session in its folder", () => {
  const h = setup();
  h.state.terminals[0].cwd = "/Users/me/api";
  find(h.view.render(), "agent-t1").props.on_hover(true, h.cx);
  find(h.view.render(), "here-t1").props.on_click(null, h.cx);
  assert.deepEqual(h.overlays[0].props, { launcher: true, machine: null, folder: "/Users/me/api", tag: "This session" });
  assert.deepEqual(h.commands, []); // the session itself is not opened
});

test("idle sessions under Idle carry no ring: the heading says it", () => {
  const h = setup();
  const root = h.view.render();
  const row = find(root, "agent-t1");
  assert.equal(row.nodes.at(-1).nodes.length, 0);
  // Elsewhere the mark stays.
  assert.ok(glyphs(find(root, "agent-work/t1")).length || find(root, "agent-work/t1").nodes.at(-1).nodes.length);
});

test("✕ takes two deliberate clicks: a stray or double click never closes a session", () => {
  const h = setup();
  h.state.panes = [{ pane: "p1", tab: "a1", terminal: "t1", cwd: "/x" }];
  const click = id => find(h.view.render(), id).props.on_click(null, h.cx);
  find(h.view.render(), "agent-t1").props.on_hover(true, h.cx);
  click("close-t1");
  assert.deepEqual(h.commands, []);
  let root = h.view.render();
  assert.match(text(find(root, "close-t1")), /Close/);
  assert.equal(find(root, "pin-t1"), null); // the armed Close takes their room
  click("close-t1"); // as fast as a double click
  assert.deepEqual(h.commands, []);
  h.view.armed.at -= 1000;
  click("close-t1");
  assert.deepEqual(h.commands, [{ name: "pane.close", args: { pane: "p1" } }]);
  // Leaving the row disarms it; so does waiting.
  h.state.terminals.push({ address: "t9", state: "live", status: "working", title: "Busy", program: { name: "Claude", agent: true } });
  find(h.view.render(), "agent-t9").props.on_hover(true, h.cx);
  click("close-t9");
  find(h.view.render(), "agent-t9").props.on_hover(false, h.cx);
  find(h.view.render(), "agent-t9").props.on_hover(true, h.cx);
  click("close-t9");
  h.view.armed.at -= 5000;
  click("close-t9");
  assert.equal(h.commands.length, 1);
  assert.deepEqual(model.closeAction({ available: true, address: "t9", background: [] }), { name: "terminal.kill", args: { terminal: "t9" } });
});

test("a closed session goes at once, never jumping elsewhere while Herdr still lists its terminal", () => {
  const h = setup();
  h.state.terminals.push({ address: "t2", state: "live", status: "idle", title: "Other task", program: { name: "Claude", agent: true } });
  h.state.panes = [{ pane: "p1", tab: "a1", terminal: "t1", cwd: "/x" }, { pane: "p2", tab: "a1", terminal: "t2", cwd: "/y" }];
  const click = id => find(h.view.render(), id).props.on_click(null, h.cx);
  find(h.view.render(), "agent-t1").props.on_hover(true, h.cx);
  click("close-t1");
  h.view.armed.at -= 1000;
  click("close-t1");
  assert.deepEqual(h.commands, [{ name: "pane.close", args: { pane: "p1" } }]);
  // Herdr has dropped the pane but still lists the terminal: the row is gone already.
  h.state.panes = h.state.panes.filter(pane => pane.pane !== "p1");
  assert.equal(find(h.view.render(), "agent-t1"), null);
  assert.ok(find(h.view.render(), "agent-t2"));
  // Its pane closed elsewhere (⌘W): gone at the first render without it, too.
  h.state.panes = [];
  assert.equal(find(h.view.render(), "agent-t2"), null);
  // Still listed long after (parked, not closed): it comes back.
  for (const [address] of h.view.leaving) h.view.leaving.set(address, Date.now() - model.LEAVE_MS - 1);
  const root = h.view.render();
  assert.ok(find(root, "agent-t1"));
  assert.ok(find(root, "agent-t2"));
  assert.equal(h.view.leaving.size, 0);
});

test("a sub-agent inside a session, or one on a machine that is away, has no ✕", () => {
  assert.equal(model.closeAction({ available: true, inner: true, background: [] }), null);
  assert.equal(model.closeAction({ available: false, background: [] }), null);
});

test("the session you are in stays in view when its section is folded", () => {
  const h = setup(); // t1 is idle and focused
  h.state.terminals.push({ address: "t2", state: "live", status: "idle", title: "Other", program: { name: "Claude", agent: true } });
  find(h.view.render(), "section-local:idle").props.on_click(null, h.cx);
  const root = h.view.render();
  assert.ok(find(root, "agent-t1"));
  assert.equal(find(root, "agent-t2"), null);
});

test("with only this computer there is no host heading, and its + moves to the title bar", () => {
  // Folded while a second machine was connected: that must not hide every session now.
  const h = setup({}, { folded: JSON.stringify(["local"]) });
  h.state.machines = [{ name: null, layout: "ready" }];
  h.state.terminals = h.state.terminals.filter(row => row.address === "t1");
  let root = h.view.render();
  const list = find(root, "host-agent-list");
  assert.equal(find(list, "host-local"), null);
  assert.match(list.nodes[0].props.id, /^section-local:/);
  assert.equal(list.nodes[1].props.id, "agent-t1");
  assert.deepEqual(h.order(), ["t1"]);
  assert.equal(list.props.accessibility_label, "Sessions grouped by status");
  assert.doesNotMatch(h.view.tip(h.view.rows[0], Date.now()), /^Local$/m);
  find(root, "new-local").props.on_click(null, h.cx);
  assert.equal(h.overlays.at(-1).props.machine, null);
  // The rail keeps a + of its own at the top of the list.
  h.view.width = 76;
  root = h.view.render();
  assert.equal(find(root, "host-local"), null);
  assert.ok(find(find(root, "host-agent-list").nodes[0], "new-local"));
  // A second machine brings the headings back.
  h.state.machines.push({ name: "work", layout: "ready" });
  h.view.width = 320;
  root = h.view.render();
  assert.ok(find(root, "host-local"));
  assert.ok(find(root, "host-remote:work"));
});

test("sessions of one status in the same folder get a folder heading; a lone one names its folder", () => {
  const h = setup();
  h.state.machines = [{ name: null, layout: "ready" }];
  h.state.terminals = [
    { address: "t1", state: "live", status: "idle", title: "Fix login", program: { name: "Claude", agent: true }, cwd: "/Users/me/api", status_ms: 300 },
    { address: "t2", state: "live", status: "idle", title: "Docs", program: { name: "Claude", agent: true }, cwd: "/Users/me/web", status_ms: 200 },
    { address: "t3", state: "live", status: "idle", title: "Tests", program: { name: "Claude", agent: true }, cwd: "/Users/me/api", status_ms: 100 },
    { address: "t4", state: "live", status: "working", title: "Build", program: { name: "Claude", agent: true }, cwd: "/Users/me/api" },
  ];
  const root = h.view.render();
  assert.deepEqual(find(root, "host-agent-list").nodes.map(n => n.props.id).filter(id => id !== "clean-up"), [
    "section-local:working", "agent-t4",
    "section-local:idle", "folder-local:idle:/Users/me/api", "agent-t1", "agent-t3", "agent-t2", "add-machine",
  ]);
  assert.match(text(find(root, "folder-local:idle:/Users/me/api")), /api 2/);
  // Under the heading the folder isn't repeated, and the rows sit further in.
  assert.doesNotMatch(text(find(root, "agent-t1")), /api/);
  assert.ok(find(root, "agent-t1").props.pl > find(root, "agent-t2").props.pl);
  // Alone in its status, a session names its folder beside its title.
  assert.match(text(find(root, "agent-t2")), /web/);
  assert.match(text(find(root, "agent-t4")), /api/);
  // Navigation follows the list as shown.
  assert.deepEqual(h.order(), ["t4", "t1", "t3", "t2"]);
});

test("expanded, sessions in one folder still sit together, under no heading: each row names it", () => {
  const h = setup();
  h.state.machines = [{ name: null, layout: "ready" }];
  h.state.terminals = [
    { address: "t1", state: "live", status: "idle", title: "Fix login", program: { name: "Claude", agent: true }, cwd: "/Users/me/api", status_ms: 300 },
    { address: "t2", state: "live", status: "idle", title: "Docs", program: { name: "Claude", agent: true }, cwd: "/Users/me/web", status_ms: 200 },
    { address: "t3", state: "live", status: "idle", title: "Tests", program: { name: "Claude", agent: true }, cwd: "/Users/me/api", status_ms: 100 },
  ];
  h.sharedState["agent-sidebar.density"] = "expanded";
  const root = h.view.render();
  assert.deepEqual(find(root, "host-agent-list").nodes.map(n => n.props.id).filter(id => id !== "clean-up"), [
    "section-local:idle", "agent-t1", "agent-t3", "agent-t2", "add-machine",
  ]);
  assert.match(text(find(root, "agent-t1")), /~\/api/);
  assert.equal(find(root, "agent-t1").props.pl, find(root, "agent-t2").props.pl, "no heading, no indent");
});

test("the expanded view gives each session a second line with its folder and branch, for every copy", () => {
  const h = setup();
  h.state.machines = [{ name: null, layout: "ready" }];
  h.state.terminals = [{ address: "t1", state: "live", status: "idle", title: "Fix login", program: { name: "Claude", agent: true } }];
  h.state.panes = [{ pane: "p1", terminal: "t1", tab: "tb", cwd: "/Users/me/code/api", branch: "fix-login" }];
  let root = h.view.render();
  assert.equal(find(root, "agent-t1").props.h, 28);
  assert.doesNotMatch(text(find(root, "agent-t1")), /fix-login/);
  h.view.toggleDensity(); // a key bound to agent-sidebar.density, or the settings
  assert.equal(h.sharedState["agent-sidebar.density"], "expanded");
  root = h.view.render();
  assert.equal(find(root, "agent-t1").props.h, 40);
  assert.match(text(find(root, "agent-t1")), /~\/code\/api · fix-login/);
  // The rail is unchanged: icons only.
  h.view.width = 76;
  assert.equal(find(h.view.render(), "agent-t1").props.h, 28);
  h.view.width = 320;
  h.view.toggleDensity();
  assert.equal(h.sharedState["agent-sidebar.density"], "compact");
  assert.equal(find(h.view.render(), "agent-t1").props.h, 28);
});

test("opening a finished session keeps it under Done until you move to another one", () => {
  const h = setup();
  h.state.machines = [{ name: null, layout: "ready" }];
  h.state.focused = { terminal: "t2" };
  h.state.terminals = [
    { address: "t1", state: "live", status: "done", title: "Finished", program: { name: "Claude", agent: true } },
    { address: "t2", state: "live", status: "idle", title: "Other", program: { name: "Claude", agent: true } },
  ];
  let root = h.view.render();
  find(root, "agent-t1").props.on_click();
  // Herdr marks it seen as you open it.
  h.state.focused = { terminal: "t1" };
  h.state.terminals[0].status = "idle";
  root = h.view.render();
  assert.ok(find(find(root, "host-agent-list"), "section-local:done"));
  assert.equal(h.view.rows.find(r => r.address === "t1").status, "done");
  root = h.view.render(); // and stays while you read
  assert.equal(h.view.rows.find(r => r.address === "t1").status, "done");
  h.state.focused = { terminal: "t2" };
  root = h.view.render();
  assert.equal(find(root, "section-local:done"), null);
  assert.equal(h.view.rows.find(r => r.address === "t1").status, "idle");
});

const findStart = (node, prefix) => !node || typeof node !== "object" ? null
  : String(node.props?.id ?? "").startsWith(prefix) ? node : node.nodes.map(child => findStart(child, prefix)).find(Boolean) ?? null;

test("a status change fades its new mark in and tints news, once; the first render animates nothing", () => {
  const h = setup();
  h.state.machines = [{ name: null, layout: "ready" }];
  h.state.focused = null;
  h.state.terminals = [{ address: "t1", state: "live", status: "working", title: "Busy", program: { name: "Claude", agent: true } }];
  let root = h.view.render();
  assert.equal(findStart(root, "mark-t1-").props.opacity, 1);
  assert.equal(findStart(root, "tint-t1-"), null);
  // No accent stripe on the row.
  assert.equal(find(root, "agent-t1").props.border_l, undefined);
  h.state.terminals[0].status = "blocked";
  root = h.view.render();
  // Drawn at the start of its transition...
  assert.equal(findStart(root, "mark-t1-").props.opacity, 0);
  assert.equal(findStart(root, "tint-t1-").props.opacity, 1);
  assert.equal(findStart(root, "mark-t1-").props.transition[0], "left");
  // ...and at its end on the next frame.
  root = h.view.render();
  assert.equal(findStart(root, "mark-t1-").props.opacity, 1);
  assert.equal(findStart(root, "tint-t1-").props.opacity, 0);
  // Each change is its own element, so the transition starts from nothing, not the old mark.
  const id = findStart(root, "mark-t1-").props.id;
  assert.notEqual(id, "mark-t1-settled");
  // Going quiet moves the mark but tints nothing.
  h.state.terminals[0].status = "idle";
  root = h.view.render();
  assert.equal(findStart(root, "tint-t1-"), null);
});

test("rows that change place slide from the old one, and those they pass make room; a new grouping does not slide", () => {
  const h = setup();
  h.state.machines = [{ name: null, layout: "ready" }];
  h.state.focused = null;
  h.state.terminals = [
    { address: "t1", state: "live", status: "working", title: "First", program: { name: "Claude", agent: true } },
    { address: "t2", state: "live", status: "idle", title: "Second", program: { name: "Claude", agent: true } },
  ];
  let root = h.view.render();
  assert.equal(findStart(root, "slide-"), null);
  // Working · First, Idle · Second  →  Needs you · Second, Working · First
  h.state.terminals[1].status = "blocked";
  root = h.view.render();
  const second = findStart(root, "slide-row:t2-");
  const first = findStart(root, "slide-row:t1-");
  // Drawn where it was (section 22 + row 28 + section 22 below its new place), moving up...
  assert.equal(second.props.top, 22 + 28 + 22 - 22);
  assert.ok(find(second, "agent-t2"));
  // ...and the one it passed drawn where it was too, moving down.
  assert.equal(first.props.top, 22 - (22 + 28 + 22));
  assert.equal(second.props.transition[0], "top");
  assert.equal(findStart(root, "slide-section:local:blocked-").props.opacity, 0);
  root = h.view.render();
  assert.equal(findStart(root, "slide-row:t2-").props.top, 0);
  assert.equal(findStart(root, "slide-row:t1-").props.top, 0);
  // The new "Needs you" heading fades in where it lands rather than sliding.
  assert.equal(findStart(root, "slide-section:local:blocked-").props.opacity, 1);
  assert.equal(findStart(root, "slide-section:local:blocked-").props.top, undefined);
  // Grouping by space is another list, not a move: nothing slides.
  h.state.terminals[1].status = "idle";
  h.view.toggleGroup();
  root = h.view.render();
  assert.equal(findStart(root, "slide-"), null);
});

const reading = (model, effort) => ({ at: Date.now(), session: { status: "idle" }, goal: null, shells: [], subagents: [], model, effort });

test("a session says its model and effort in words: on the second line expanded, after the title compact", () => {
  const h = setup();
  h.state.machines = [{ name: null, layout: "ready" }];
  h.state.terminals = [
    { address: "t1", state: "live", status: "idle", title: "Fix login", program: { name: "Claude", agent: true } },
    { address: "t2", state: "live", status: "idle", title: "A title long enough to leave no room beside it", program: { name: "Claude", agent: true } },
    { address: "t3", state: "live", status: "idle", title: "No reading", program: { name: "Claude", agent: true } },
  ];
  h.state.panes = [{ pane: "p1", terminal: "t1", tab: "tb", cwd: "/Users/me/workspace/herdr/herdr-agents", branch: "main" }];
  h.view.work = new Map([["t1", reading("claude-opus-5-5", "xhigh")], ["t2", reading("claude-fable-5-2", "high")]]);
  h.view.width = 332;
  // Compact: family and effort when they fit beside the title, else only in the tooltip.
  let root = h.view.render();
  assert.equal(text(find(root, "uses-t1")), "Opus · xhigh");
  assert.equal(find(root, "uses-t1").props.tooltip, "Opus 5.5 · xhigh effort");
  assert.equal(find(root, "uses-t2"), null);
  assert.match(find(root, "agent-t2").props.tooltip, /\nFable 5\.2 · high effort\n/);
  assert.equal(find(root, "uses-t3"), null);
  assert.equal(find(root, "agent-t1").props.h, 28); // no taller for it
  // Expanded: always there, and the folder gives way from its start so the branch stays.
  h.sharedState["agent-sidebar.density"] = "expanded";
  root = h.view.render();
  assert.match(text(find(root, "agent-t1")), /…\/herdr-agents · main Opus · xhigh/);
  assert.equal(text(find(root, "uses-t2")), "Fable 5.2 · high");
  assert.equal(find(root, "uses-t3"), null);
  assert.equal(find(root, "agent-t1").props.h, 40);
  // Hovering makes room for the row's buttons in compact, not in expanded.
  h.sharedState["agent-sidebar.density"] = "compact";
  find(h.view.render(), "agent-t1").props.on_hover(true, h.cx);
  assert.equal(find(h.view.render(), "uses-t1"), null);
});

test("a machine that is away is one quiet line after the others, its sessions behind a click", () => {
  const h = setup();
  h.state.machines = [{ name: null, layout: "ready" }, { name: "attic", layout: "unavailable" }, { name: "work", layout: "ready" }];
  h.state.terminals.push({ address: "attic/t1", state: "live", status: "working", title: "Stale task", program: { name: "Claude", agent: true } });
  let root = h.view.render();
  const list = () => find(root, "host-agent-list").nodes.map(n => n.props.id);
  assert.deepEqual(list(), ["host-local", "section-local:idle", "agent-t1", "host-remote:work", "section-remote:work:blocked", "agent-work/t1", "host-remote:attic", "add-machine"]);
  const away = find(root, "host-remote:attic");
  assert.equal(away.props.h, 24);
  assert.ok(away.props.h < find(root, "host-remote:work").props.h);
  assert.match(text(away), /attic\s+Unavailable\s+1/);
  assert.equal(find(root, "new-remote:attic"), null);
  assert.deepEqual(h.order(), ["t1", "work/t1"]);
  // A click shows what it had, which still can't be opened; another hides it again.
  away.props.on_click(null, h.cx);
  root = h.view.render();
  assert.equal(list().length, 10); // its section heading and its session, fading in under it
  assert.ok(find(root, "section-remote:attic:working"));
  find(root, "agent-attic/t1").props.on_click();
  assert.deepEqual(h.commands, []);
  find(root, "host-remote:attic").props.on_click(null, h.cx);
  root = h.view.render();
  assert.equal(find(root, "agent-attic/t1"), null);
  // Back again, it is a host like any other, in its place by name.
  h.state.machines[1].layout = "ready";
  root = h.view.render();
  assert.deepEqual(ids(root).filter(id => /^host-(local|remote)/.test(id)), ["host-local", "host-remote:attic", "host-remote:work"]);
  assert.ok(find(root, "agent-attic/t1"));
});

test("grouped by space, each space is a heading with its sessions; every copy follows the choice", () => {
  const h = setup();
  h.state.machines = [{ name: null, layout: "ready" }];
  h.state.spaces = [{ id: "s1", name: "API", tabs: [{ id: "a1" }] }, { id: "s2", name: "Billing", tabs: [{ id: "b1" }] }];
  h.state.terminals = [
    { address: "t1", state: "live", status: "idle", title: "Fix login", program: { name: "Claude", agent: true } },
    { address: "t2", state: "live", status: "blocked", title: "Rotate keys", program: { name: "Claude", agent: true } },
    { address: "t3", state: "live", status: "working", title: "Add retries", program: { name: "Claude", agent: true } },
  ];
  h.state.panes = [{ pane: "p1", terminal: "t1", tab: "a1" }, { pane: "p2", terminal: "t2", tab: "b1" }, { pane: "p3", terminal: "t3", tab: "a1" }];
  h.sharedState["space.colors"] = { s2: "ansi5" };
  let root = h.view.render();
  assert.ok(find(root, "section-local:blocked"));
  h.view.toggleGroup(); // a key bound to agent-sidebar.group, or the settings
  assert.equal(h.sharedState["agent-sidebar.group"], "space");
  root = h.view.render();
  // What needs you leads; a space with nothing else left keeps its heading.
  assert.deepEqual(find(root, "host-agent-list").nodes.map(n => n.props.id),
    ["section-local:blocked", "agent-t2", "section-local:space:s1", "agent-t3", "agent-t1", "section-local:space:s2", "add-machine"]);
  assert.match(text(find(root, "section-local:space:s1")), /API\s+2/);
  assert.match(text(find(root, "section-local:space:s2")), /Billing\s+0/);
  // No heading names the status now, so an idle session carries its ring.
  assert.ok(find(root, "agent-t1").nodes.at(-1).nodes.length > 0);
  // Folded, a space says what it holds.
  find(root, "section-local:space:s1").props.on_click(null, h.cx);
  root = h.view.render();
  assert.equal(find(root, "agent-t3"), null);
  assert.deepEqual(find(root, "section-local:space:s1").nodes.map(n => n.props?.tooltip).filter(tip => /working|done|needs/.test(tip ?? "")), ["1 working"]);
  // Then projects, then status again.
  h.view.toggleGroup();
  assert.equal(h.sharedState["agent-sidebar.group"], "project");
  h.view.toggleGroup();
  assert.equal(h.sharedState["agent-sidebar.group"], "status");
  assert.ok(find(h.view.render(), "section-local:blocked"));
});

test("each reachable machine is asked once what it is, and its heading shows that kind's icon", async () => {
  const h = setup();
  h.state.machines.push({ name: "attic", layout: "unavailable" });
  const icon = id => glyphs(find(h.view.render(), id)).map(g => g.props.src.split("/").pop())[1]; // after the chevron
  assert.deepEqual([icon("host-local"), icon("host-remote:work")], ["computer.svg", "server.svg"]);
  h.answer(async (_cmd, args, opts) => ({ code: 0, stdout: args[1] === background.KIND ? (opts.on === "work" ? "desktop\n" : "laptop\n") : "", stderr: "" }));
  let answers = 0;
  h.view.askKinds(() => answers++);
  assert.deepEqual(h.execs.map(([, args, opts]) => [args[1] === background.KIND, opts.on]), [[true, null], [true, "work"]]); // not the one that is away
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(answers, 2);
  assert.deepEqual(h.sharedState["agent-sidebar.kinds"], { "": "laptop", work: "desktop" });
  assert.deepEqual([icon("host-local"), icon("host-remote:work")], ["laptop.svg", "computer.svg"]);
  assert.match(find(h.view.render(), "host-remote:work").props.tooltip, /work · desktop/);
  // Asked once: not again.
  h.view.askKinds(() => answers++);
  assert.equal(h.execs.length, 2);
  // One that gave no answer keeps its place's icon and is asked again a minute later.
  const next = setup();
  next.view.askKinds(() => {});
  await new Promise(resolve => setTimeout(resolve, 0));
  next.view.askKinds(() => {});
  assert.equal(next.execs.length, 2);
  for (const machine of [null, "work"]) next.view.kinds.set(machine, Date.now() - 61000);
  next.view.askKinds(() => {});
  assert.equal(next.execs.length, 4);
});

// Two spaces on this computer, one on "work"; t1 and t3 in API, t2 in Billing.
function spaced() {
  const h = setup();
  h.state.spaces = [{ id: "s1", name: "API", machine: null, tabs: [{ id: "a1" }] }, { id: "s2", name: "Billing", machine: null, tabs: [{ id: "b1" }] },
    { id: "work/s9", name: "Remote", machine: "work", tabs: [{ id: "work/r1" }] }];
  h.state.terminals = [
    { address: "t1", state: "live", status: "idle", title: "Fix login", program: { name: "Claude", agent: true } },
    { address: "t2", state: "live", status: "working", title: "Rotate keys", program: { name: "Claude", agent: true } },
    { address: "t3", state: "live", status: "working", title: "Add retries", program: { name: "Claude", agent: true } },
    { address: "work/t1", state: "live", status: "idle", title: "Remote task", program: { name: "Claude", agent: true } },
  ];
  h.state.panes = [{ pane: "p1", terminal: "t1", tab: "a1" }, { pane: "p2", terminal: "t2", tab: "b1" }, { pane: "p3", terminal: "t3", tab: "a1" }, { pane: "work/p1", terminal: "work/t1", tab: "work/r1" }];
  h.state.focused = null;
  h.sharedState["agent-sidebar.group"] = "space";
  return h;
}
const hover = (h, id) => { find(h.view.render(), id).props.on_hover(true, h.cx); return h.view.render(); };

test("a space heading starts a session there, renames, recolors and opens Herdr's own menu; a machine starts a new space", () => {
  const h = spaced();
  let root = hover(h, "section-local:space:s1");
  find(root, "space-new-local:space:s1").props.on_click(null, h.cx);
  assert.deepEqual(h.overlays[0].props, { launcher: true, machine: null, space: "s1" });
  find(hover(h, "section-local:space:s1"), "space-more-local:space:s1").props.on_click(null, h.cx);
  const menu = { mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: "s1" } } };
  assert.deepEqual(h.overlays[1], menu);
  root = h.view.render();
  find(root, "section-local:space:s1").props.on_mouse_down[1](); // the last one set: the left press
  assert.equal(h.overlays.length, 2);
  // Double-click renames (Herdr asks for the name) and leaves the fold as it was.
  find(root, "section-local:space:s1").props.on_click({ click_count: 1 }, h.cx);
  find(h.view.render(), "section-local:space:s1").props.on_click({ click_count: 2 }, h.cx);
  assert.deepEqual(h.commands, [{ name: "space.rename", args: { id: "s1" } }]);
  assert.ok(find(h.view.render(), "agent-t1"));
  // The dot cycles Herdr's own colors for the space.
  find(h.view.render(), "color-local:space:s1").props.on_click(null, h.cx);
  assert.deepEqual(h.sharedState["space.colors"], { s1: "ansi3" });
  find(h.view.render(), "color-local:space:s1").props.on_click(null, h.cx);
  assert.deepEqual(h.sharedState["space.colors"], { s1: "ansi4" });
  // No actions on "Needs you" or "No space".
  h.state.terminals[0].status = "blocked";
  assert.equal(find(hover(h, "section-local:blocked"), "space-new-local:blocked"), null);
  // Each machine's heading starts a new space there, only while grouped by space.
  find(h.view.render(), "new-space-remote:work").props.on_click(null, h.cx);
  assert.deepEqual(h.commands.at(-1), { name: "space.new", args: { machine: "work" } });
  h.sharedState["agent-sidebar.group"] = "status";
  assert.equal(find(h.view.render(), "new-space-remote:work"), null);
});

test("a space's + opens the launcher on that space, whatever folder is picked", () => {
  const h = setup({ launcher: true, machine: null, space: "s2" });
  h.state.spaces = [{ id: "s1", name: "API", machine: null, active: true, tabs: [] }, { id: "s2", name: "Billing", machine: null, tabs: [] }];
  h.state.focused = { space: "s1" };
  h.input.handlers.submit();
  assert.equal(h.commands.at(-1).name, "tab.new");
  assert.equal(h.commands.at(-1).args.space, "s2");
});

test("moving a session: its row's button, then a click on a space; its pane is parked, then it is labeled into the space", async () => {
  const h = spaced();
  h.sharedState["agent-sidebar.group"] = "status"; // choosing where shows the spaces anyway
  let root = hover(h, "agent-t1");
  find(root, "move-t1").props.on_click(null, h.cx);
  root = h.view.render();
  assert.match(text(find(root, "moving")), /Move Fix login to…/);
  // Its own space and another machine's are no destination; the other space says "Move here".
  assert.doesNotMatch(text(find(root, "section-local:space:s1")), /Move here/);
  assert.doesNotMatch(text(find(root, "section-remote:work:space:work/s9")), /Move here/);
  assert.match(text(find(root, "section-local:space:s2")), /Move here/);
  find(root, "section-local:space:s1").props.on_click({ click_count: 1 }, h.cx); // folds, moves nothing
  assert.deepEqual(h.commands, []);
  find(h.view.render(), "section-local:space:s2").props.on_click({ click_count: 1 }, h.cx);
  assert.deepEqual(h.commands, [{ name: "terminal.park", args: { terminal: "t1" } }]);
  assert.equal(h.view.moving, null);
  // Until its pane is gone nothing is labeled; the row stays, dimmed, and doesn't "leave".
  h.view.finishMoves();
  assert.equal(h.hcs.length, 0);
  h.state.panes = h.state.panes.filter(pane => pane.terminal !== "t1");
  root = h.view.render();
  assert.equal(find(root, "agent-t1").props.opacity, 0.5);
  h.view.finishMoves();
  assert.equal(h.hcs.length, 1);
  assert.deepEqual(h.hcs[0].slice(0, 3), ["label", "t1", "herdr.space=s2"]);
  assert.match(h.hcs[0][3], /^herdr\.tab=tb[0-9a-f]{32}$/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual([h.notes[0].title, h.notes[0].level], ["Moved Fix login to Billing", "success"]);
  assert.equal(h.view.pending.length, 0);
  // Escape, or Cancel, leaves a move without moving.
  find(hover(h, "agent-t3"), "move-t3").props.on_click(null, h.cx);
  h.view.render().props.on_key_down({ key: "escape" }, h.cx);
  assert.equal(h.view.moving, null);
  assert.equal(h.commands.length, 1);
  find(hover(h, "agent-t3"), "move-t3").props.on_click(null, h.cx);
  find(h.view.render(), "moving-cancel").props.on_click(null, h.cx);
  assert.equal(find(h.view.render(), "moving"), null);
  // A sub-agent inside a session, and a session on a machine with one space, have no button.
  assert.equal(find(hover(h, "agent-work/t1"), "move-work/t1"), null);
});

test("a move that can't finish says what state the session is in", async () => {
  const h = spaced();
  const start = address => { find(hover(h, `agent-${address}`), `move-${address}`).props.on_click(null, h.cx); find(h.view.render(), "section-local:space:s2").props.on_click({ click_count: 1 }, h.cx); };
  // Its pane never closes: given up after a while, nothing changed.
  start("t1");
  h.view.pending[0].at = Date.now() - 9000;
  h.view.finishMoves();
  assert.equal(h.hcs.length, 0);
  assert.deepEqual([h.notes[0].title, h.notes[0].body, h.notes[0].level], ["Could not move Fix login", "Its pane did not close. Nothing was changed.", "warning"]);
  // Parked, but the label fails: it runs on without a pane, and the toast says where it is.
  h.hcFails("no such terminal");
  start("t3");
  h.state.panes = h.state.panes.filter(pane => pane.terminal !== "t3");
  h.view.finishMoves();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(h.notes[1].body, /still running, without a pane: find it under No space\. no such terminal/);
  assert.ok(find(h.view.render(), "agent-t3")); // still listed
});

test("merging: a space's sessions all move to the space clicked next", () => {
  const h = spaced();
  find(hover(h, "section-local:space:s1"), "space-merge-local:space:s1").props.on_click(null, h.cx);
  const root = h.view.render();
  assert.match(text(find(root, "moving")), /Move all of API to…/);
  find(root, "section-local:space:s2").props.on_click({ click_count: 1 }, h.cx);
  assert.deepEqual(h.commands, [{ name: "terminal.park", args: { terminal: "t3" } }, { name: "terminal.park", args: { terminal: "t1" } }]);
  assert.deepEqual(h.view.pending.map(move => [move.address, move.space]), [["t3", "s2"], ["t1", "s2"]]);
});

test("dragging a session onto a space moves it; dragging a space onto another reorders; neither is a click", () => {
  const h = spaced();
  const press = (root, id) => { const down = find(root, id).props.on_mouse_down; (Array.isArray(down[0]) ? down[0] : down)[1](); };
  let root = h.view.render();
  find(root, "agent-t1").props.on_mouse_down[1]();
  find(root, "section-local:space:s2").props.on_mouse_move(null, h.cx);
  root = h.view.render();
  assert.match(text(find(root, "section-local:space:s2")), /Move here/); // the drag shows where it can go
  find(root, "section-local:space:s2").props.on_mouse_up[1](null, h.cx);
  assert.deepEqual(h.commands, [{ name: "terminal.park", args: { terminal: "t1" } }]);
  // The drop is no click, and it doesn't cost the row its next one.
  h.view.pending = [];
  root = h.view.render();
  find(root, "agent-t1").props.on_mouse_down[1]();
  find(root, "agent-t1").props.on_mouse_up[1](null, h.cx);
  find(root, "agent-t1").props.on_click();
  assert.deepEqual(h.commands.at(-1), { name: "pane.focus", args: { pane: "p1" } });
  h.commands.pop();
  // Dropped on a session of another space, it goes to that session's space.
  find(root, "agent-t3").props.on_mouse_down[1]();
  find(root, "agent-t2").props.on_mouse_move(null, h.cx);
  find(h.view.render(), "agent-t2").props.on_mouse_up[1](null, h.cx);
  assert.deepEqual([h.commands.at(-1), h.view.pending.map(move => [move.address, move.space])], [{ name: "terminal.park", args: { terminal: "t3" } }, [["t3", "s2"]]]);
  h.commands.pop();
  h.view.pending = [];
  // Dropped on a session of its own space, nothing moves and the move is over.
  root = h.view.render();
  find(root, "agent-t3").props.on_mouse_down[1]();
  find(root, "agent-t1").props.on_mouse_move(null, h.cx);
  find(h.view.render(), "agent-t1").props.on_mouse_up[1](null, h.cx);
  assert.equal(h.view.moving, null);
  assert.equal(h.commands.length, 1);
  // A press that left the row and came back opens nothing; a plain click still does.
  root = h.view.render();
  find(root, "agent-t3").props.on_mouse_down[1]();
  find(root, "agent-t2").props.on_mouse_move(null, h.cx);
  find(root, "agent-t3").props.on_mouse_move(null, h.cx);
  find(root, "agent-t3").props.on_mouse_up[1](null, h.cx);
  find(h.view.render(), "agent-t3").props.on_click();
  assert.equal(h.commands.length, 1);
  root = h.view.render();
  find(root, "agent-t3").props.on_mouse_down[1]();
  find(root, "agent-t3").props.on_mouse_up[1](null, h.cx);
  find(root, "agent-t3").props.on_click();
  assert.deepEqual(h.commands.at(-1), { name: "pane.focus", args: { pane: "p3" } });
  // A space dragged onto another takes its place, as in Herdr's own Spaces list.
  root = h.view.render();
  find(root, "section-local:space:s2").props.on_mouse_down[1]();
  find(root, "section-local:space:s1").props.on_mouse_move(null, h.cx);
  find(h.view.render(), "section-local:space:s1").props.on_mouse_up[1](null, h.cx);
  assert.deepEqual(h.commands.at(-1), { name: "space.move", args: { id: "s2", index: 1 } });
  void press;
});

test("a working session says what it is doing, one that needs you what it wants; effort has its level's color", () => {
  const h = setup();
  h.state.machines = [{ name: null, layout: "ready" }];
  h.state.terminals = [
    { address: "t1", state: "live", status: "working", title: "Fix login", program: { name: "Claude", agent: true } },
    { address: "t2", state: "live", status: "blocked", title: "Rotate keys", program: { name: "Claude", agent: true } },
    { address: "t3", state: "live", status: "idle", title: "Write notes", program: { name: "Claude", agent: true } },
  ];
  h.state.panes = ["t1", "t2", "t3"].map((terminal, i) => ({ pane: `p${i}`, terminal, tab: "tb", cwd: "/Users/me/code/api", branch: "main" }));
  const step = (tool, detail) => ({ tool, detail });
  h.view.work = new Map([
    ["t1", { ...reading("claude-opus-5-5", "xhigh"), context: 159200, activity: step("Bash", "Run the tests") }],
    ["t2", { ...reading("claude-fable-5-2", "low"), activity: step("AskUserQuestion", "Which database?") }],
    ["t3", { ...reading("claude-opus-5-5", "max"), context: 1240000, activity: step("Edit", "notes.md") }],
  ]);
  h.view.width = 400;
  h.sharedState["agent-sidebar.density"] = "expanded";
  let root = h.view.render();
  assert.match(text(find(root, "agent-t1")), /Fix login Bash · Run the tests Opus 5\.5 · xhigh · 159k/);
  assert.match(text(find(root, "agent-t2")), /Rotate keys Asks · Which database\? Fable 5\.2 · low/);
  // Its turn over, what it last did is not what it does: the folder is back.
  assert.match(text(find(root, "agent-t3")), /Write notes ~\/code\/api · main Opus 5\.5 · max · 1\.2M/);
  assert.match(find(root, "agent-t1").props.tooltip, /\nBash · Run the tests\nOpus 5\.5 · xhigh effort · 159k context\n/);
  assert.match(find(root, "agent-t1").props.tooltip, /\/Users\/me\/code\/api/); // the folder stays in the tooltip
  // A permission it waits on reads as what it wants.
  h.view.work.get("t2").activity = step("Bash", "Delete the build folder");
  assert.match(text(find(h.view.render(), "agent-t2")), /Wants Bash · Delete the build folder/);
  // Each level has its own color key, none of them a status color.
  for (const id of ["effort-t1", "effort-t2", "effort-t3"]) assert.ok(find(root, id).props.text_color);
  // Compact: after the title, where it fits.
  h.sharedState["agent-sidebar.density"] = "compact";
  assert.match(text(find(h.view.render(), "agent-t1")), /Fix login Opus · xhigh/);
  h.view.width = 460;
  assert.match(text(find(h.view.render(), "agent-t1")), /Fix login Bash · Run the tests Opus · xhigh/);
});

test("a message typed under a row is sent to that agent; never to a shell, or to one waiting on a dialog", async () => {
  const h = setup();
  h.state.terminals.push({ address: "t9", state: "live", program: { name: "zsh", shell: true }, cwd: "/Users/me" });
  let root = hover(h, "agent-t1");
  find(root, "reply-to-t1").props.on_click(null, h.cx);
  root = h.view.render();
  const list = find(root, "host-agent-list").nodes.map(n => n.props.id);
  assert.equal(list[list.indexOf("agent-t1") + 1], "reply-t1"); // the field sits under its row, only while writing
  h.input.text = "  continue with the plan  ";
  h.input.handlers.submit(null, h.cx);
  assert.deepEqual(h.hcs, [["send", "--", "t1", "continue with the plan"]]);
  // While writing, Enter and the arrows are the message's: nothing else opens or moves.
  find(hover(h, "agent-t1"), "reply-to-t1").props.on_click(null, h.cx);
  h.view.selected = "work/t1";
  for (const key of ["enter", "down", "up"]) h.view.render().props.on_key_down({ key }, h.cx);
  assert.deepEqual([h.commands, h.view.selected, h.view.replying], [[], "work/t1", "t1"]);
  h.view.render().props.on_key_down({ key: "escape" }, h.cx);
  h.view.selected = null;
  assert.equal(find(h.view.render(), "reply-t1"), null);
  // Escape leaves it unsent; an empty message sends nothing.
  find(hover(h, "agent-t1"), "reply-to-t1").props.on_click(null, h.cx);
  h.view.render().props.on_key_down({ key: "escape" }, h.cx);
  assert.equal(h.view.replying, null);
  assert.deepEqual(h.commands, []); // and Escape went no further
  find(hover(h, "agent-t1"), "reply-to-t1").props.on_click(null, h.cx);
  h.input.text = "   ";
  h.input.handlers.submit(null, h.cx);
  assert.equal(h.hcs.length, 1);
  // The remote agent is waiting on a dialog, where typing would answer it; a shell would run it.
  assert.equal(find(hover(h, "agent-work/t1"), "reply-to-work/t1"), null);
  assert.equal(find(hover(h, "agent-t9"), "reply-to-t9"), null);
  // A send that fails says so.
  h.hcFails("terminal is busy");
  find(hover(h, "agent-t1"), "reply-to-t1").props.on_click(null, h.cx);
  h.input.text = "hello";
  h.input.handlers.submit(null, h.cx);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual([h.notes[0].title, h.notes[0].body], ["Could not send to Local task", "terminal is busy"]);
});

test("Clean up closes sessions idle for over a day, on a second click, and only those", () => {
  const h = setup();
  const day = 24 * 3600 * 1000;
  const old = Date.now() - 2 * day;
  h.state.machines = [{ name: null, layout: "ready" }];
  const agent = (address, extra) => ({ address, state: "live", status: "idle", title: `Task ${address}`, program: { name: "Claude", agent: true }, status_ms: old, ...extra });
  h.state.terminals = [agent("t1"), agent("t2", { status: "done" }), agent("t3", { status_ms: Date.now() - 3600000 }), agent("t4", { labels: { "herdr.pinned": "true" } }),
    agent("t5", { status: "working" }), agent("t6"), { address: "t7", state: "live", program: { name: "zsh", shell: true }, created_ms: old }];
  h.state.focused = { terminal: "t6" };
  h.state.panes = [{ pane: "p1", terminal: "t1", tab: "tb" }];
  let root = h.view.render();
  assert.match(text(find(root, "clean-up")), /Close 2 sessions idle for over a day/);
  assert.equal(find(root, "clean-up").props.tooltip, "Task t2\nTask t1");
  find(root, "clean-up").props.on_click(null, h.cx);
  assert.deepEqual(h.commands, []);
  root = h.view.render();
  assert.match(text(find(root, "clean-up")), /Click again to close 2 sessions/);
  find(root, "clean-up").props.on_click(null, h.cx); // a double click: too soon
  assert.deepEqual(h.commands, []);
  h.view.armedClean = Date.now() - 1000;
  find(h.view.render(), "clean-up").props.on_click(null, h.cx);
  assert.deepEqual(h.commands, [{ name: "terminal.kill", args: { terminal: "t2" } }, { name: "pane.close", args: { pane: "p1" } }]);
  // Nothing that old: no row at all.
  h.state.terminals = [agent("t3", { status_ms: Date.now() })];
  assert.equal(find(h.view.render(), "clean-up"), null);
});

test("a Claude Code session that ended is kept to reopen: its terminal gone from a machine that answers", () => {
  const h = setup();
  h.view.work = new Map([["t1", { ...reading("claude-opus-5-5", "high"), id: "abc-123" }], ["work/t1", { ...reading("claude-opus-5-5", "high"), id: "def-456" }]]);
  h.state.panes = [{ pane: "p1", terminal: "t1", tab: "tb", cwd: "/Users/me/api" }];
  h.view.render();
  assert.equal(find(h.view.render(), "closed"), null);
  // A machine that is away, or a pane that is parked, ends nothing.
  h.state.machines[1].layout = "unavailable";
  h.state.terminals = h.state.terminals.filter(t => t.address !== "work/t1");
  h.state.panes = [];
  h.view.render();
  assert.equal(h.sharedState["agent-sidebar.closed"], undefined);
  // Its terminal gone from this computer: ended.
  h.state.terminals = [];
  let root = h.view.render();
  assert.deepEqual(h.sharedState["agent-sidebar.closed"].map(entry => [entry.title, entry.cwd, entry.machine, entry.session]), [["Local task", "/Users/me/api", null, "abc-123"]]);
  // Folded until asked for; a click reopens it where it worked, and takes it off the list.
  assert.match(text(find(root, "closed")), /Recently closed\s*1/);
  assert.equal(find(root, "closed-abc-123"), null);
  find(root, "closed").props.on_click(null, h.cx);
  root = h.view.render();
  find(root, "closed-abc-123").props.on_click(null, h.cx);
  assert.deepEqual(h.commands, [{ name: "space.new", args: { name: undefined, argv: ["claude", "--resume", "abc-123"], folder: "/Users/me/api", machine: "" } }]);
  assert.deepEqual(h.sharedState["agent-sidebar.closed"], []);
  assert.equal(find(h.view.render(), "closed"), null);
});

test("Organize asks Claude (Sonnet, low effort) once, shows what it would change, and moves nothing until Apply", async () => {
  const h = spaced();
  let asked;
  h.answer(async (cmd, args, opts) => {
    asked = { cmd, args, opts };
    const id = address => args.at(-1).match(new RegExp(`- (s\\d+): "${address}"`))[1];
    return { code: 0, stderr: "", stdout: JSON.stringify({ structured_output: { machines: [{ machine: "local", spaces: [{ name: "Billing", sessions: [id("Rotate keys"), id("Add retries")] }, { name: "Auth", sessions: [id("Fix login")] }] }] } }) };
  });
  let root = h.view.render();
  find(root, "organize").props.on_click(null, h.cx);
  assert.equal(h.view.plan, "asking");
  find(h.view.render(), "organize").props.on_click(null, h.cx); // not asked twice
  assert.equal(h.execs.length, 1);
  // Claude Code's print mode on this computer: Sonnet, low effort, no tools, nothing kept.
  assert.deepEqual([asked.cmd, asked.opts.on, asked.args.slice(3, 14)], ["sh", null, ["-p", "--model", "sonnet", "--effort", "low", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--output-format", "json"]]);
  assert.match(asked.args.at(-1), /Machine "local"\. Spaces now: "API", "Billing"/);
  await new Promise(resolve => setTimeout(resolve, 0));
  root = h.view.render();
  assert.equal(find(root, "host-agent-list").nodes[0].props.id, "plan");
  assert.match(text(find(root, "plan")), /Claude's suggestion, previewed below 1 session moves · 1 space renamed/);
  // The list is the spaces as they would be: the renamed one says what it was, and the session
  // that would move sits in its new space, highlighted, saying where from.
  assert.match(text(find(root, "section-local:space:s1")), /Auth\s+1\s+was API/);
  const under = id => { const list = find(root, "host-agent-list").nodes.map(n => n.props.id); return list.slice(list.indexOf(id) + 1).filter(x => x.startsWith("agent-") || x.startsWith("section-")); };
  assert.deepEqual(under("section-local:space:s2").slice(0, 2).sort(), ["agent-t2", "agent-t3"]);
  assert.equal(text(find(root, "moves-t3")), "from API");
  assert.equal(find(root, "moves-t2"), null);
  assert.equal(find(hover(h, "agent-t3"), "move-t3"), null); // a preview is looked at, not rearranged by hand
  // A click takes a move out, and another puts it back.
  find(h.view.render(), "agent-t3").props.on_click(null, h.cx);
  root = h.view.render();
  assert.deepEqual([text(find(root, "stays-t3")), find(root, "moves-t3")], ["stays", null]);
  assert.match(text(find(root, "plan")), /1 space renamed/);
  assert.doesNotMatch(text(find(root, "plan")), /moves/);
  find(root, "agent-t3").props.on_click(null, h.cx);
  root = h.view.render();
  assert.equal(text(find(root, "moves-t3")), "from API");
  assert.deepEqual(h.commands, []);
  find(root, "plan-apply").props.on_click(null, h.cx);
  assert.deepEqual(h.commands, [{ name: "space.rename", args: { id: "s1", name: "Auth" } }, { name: "terminal.park", args: { terminal: "t3" } }]);
  assert.equal(find(h.view.render(), "plan"), null);
  // While Claude is asked the banner says so; Cancel drops the answer when it comes.
  h.view.pending = [];
  find(h.view.render(), "organize").props.on_click(null, h.cx);
  root = h.view.render();
  assert.match(text(find(root, "plan")), /Asking Claude how to arrange them… Cancel/);
  find(root, "plan-dismiss").props.on_click(null, h.cx);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual([h.view.plan, find(h.view.render(), "plan")], [null, null]);
  // Dismiss changes nothing; a new space is named once Herdr shows it.
  h.answer(async (_cmd, args) => ({ code: 0, stderr: "", stdout: JSON.stringify({ result: JSON.stringify({ machines: [{ machine: "local", spaces: [{ name: "Billing", sessions: [args.at(-1).match(/- (s\d+): "Fix login"/)[1]] }, { name: "Keys", sessions: [args.at(-1).match(/- (s\d+): "Rotate keys"/)[1]] }] }] }) }) }));
  h.view.pending = [];
  find(h.view.render(), "organize").props.on_click(null, h.cx);
  await new Promise(resolve => setTimeout(resolve, 0));
  find(h.view.render(), "plan-dismiss").props.on_click(null, h.cx);
  assert.equal(h.commands.length, 2);
  find(h.view.render(), "organize").props.on_click(null, h.cx);
  await new Promise(resolve => setTimeout(resolve, 0));
  // The space that doesn't exist yet is in the preview, marked new; a move taken out is not applied.
  root = h.view.render();
  const made_ = h.view.plan.moves.find(move => move.created).to;
  assert.match(text(find(root, `section-local:space:${made_}`)), /Keys\s+1\s+new/);
  find(root, "agent-t1").props.on_click(null, h.cx);
  find(h.view.render(), "plan-apply").props.on_click(null, h.cx);
  assert.equal(h.view.pending.some(move => move.address === "t1"), false);
  const made = h.view.pending.find(move => move.address === "t2").space;
  assert.match(made, /^sp[0-9a-f]{32}$/);
  h.state.panes = h.state.panes.filter(pane => pane.terminal !== "t2");
  h.view.finishMoves();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(h.hcs.find(args => args[1] === "t2").slice(0, 3), ["label", "t2", `herdr.space=${made}`]);
  assert.equal(h.notes.length, 0); // one plan, no toast per session
  h.view.finishMoves();
  assert.notEqual(h.commands.at(-1).name, "space.rename"); // not shown yet: not named yet
  h.state.spaces.push({ id: made, name: "1", machine: null, tabs: [] });
  h.view.finishMoves();
  assert.deepEqual(h.commands.at(-1), { name: "space.rename", args: { id: made, name: "Keys" } });
  // No answer: said, and nothing shown.
  h.answer(async () => ({ code: 1, stderr: "claude: command not found", stdout: "" }));
  find(h.view.render(), "organize").props.on_click(null, h.cx);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual([h.view.plan, h.notes.at(-1).title, h.notes.at(-1).body], [null, "Could not organize the sessions", "claude: command not found"]);
});

test("grouped by space, sessions in one folder get no folder heading", () => {
  const h = spaced();
  for (const pane of h.state.panes) pane.cwd = "/Users/me/code/api";
  assert.deepEqual(ids(h.view.render()).filter(id => id.startsWith("folder-")), []);
  h.sharedState["agent-sidebar.group"] = "status";
  assert.ok(ids(h.view.render()).some(id => id.startsWith("folder-")));
});

test("grouped by project, spaces of one name on every machine are one heading, under no machine", () => {
  const h = spaced();
  h.state.machines.push({ name: "attic", layout: "unavailable" });
  h.state.spaces[2].name = "API"; // the remote space has this computer's space's name
  h.state.terminals.push({ address: "attic/t1", state: "live", status: "idle", title: "Stale", program: { name: "Claude", agent: true } });
  h.sharedState["agent-sidebar.group"] = "project";
  h.view.width = 400;
  const root = h.view.render();
  assert.deepEqual(find(root, "host-agent-list").nodes.map(n => n.props.id),
    ["section-all:project:api", "agent-t3", "agent-t1", "agent-work/t1", "section-all:project:billing", "agent-t2", "host-remote:attic", "add-machine"]);
  assert.match(text(find(root, "section-all:project:api")), /API\s*3/);
  // A session on another machine says which; the title bar starts one on this computer.
  assert.match(text(find(root, "agent-work/t1")), /Remote task\s+work/);
  assert.doesNotMatch(text(find(root, "agent-t1")), /work/);
  assert.ok(find(root, "new-local"));
  // A project is not a space: nothing to rename or move into there.
  assert.equal(find(hover(h, "section-all:project:api"), "space-new-all:project:api"), null);
});

test("a session's folder says what it changed and its pull request, asked of each machine at their own pace", async () => {
  const h = setup();
  h.state.panes = [{ pane: "p1", terminal: "t1", tab: "tb", cwd: "/Users/me/code/api/", branch: "fix-login" }, { pane: "work/p1", terminal: "work/t1", tab: "work/tb", cwd: "/srv/app", branch: "main" }];
  h.sharedState["agent-sidebar.density"] = "expanded";
  h.view.width = 420;
  h.view.render();
  h.answer(async (_cmd, args, opts) => {
    if (args[1] === background.CHANGES) return { code: 0, stderr: "", stdout: opts.on ? "D 1 \n" : "D 1  3 files changed, 120 insertions(+), 8 deletions(-)\n" };
    return { code: 0, stderr: "", stdout: 'R 1 {"number":42,"state":"OPEN","isDraft":true,"url":"https://github.com/me/api/pull/42"}\n' };
  });
  let answers = 0;
  h.view.askGit(() => answers++);
  // Changes from both machines; pull requests only where a branch is not the main one.
  assert.deepEqual(h.execs.map(([, args, opts]) => [args[1] === background.CHANGES ? "changes" : "pulls", opts.on, args.slice(3)]).sort((a, b) => String(a[1]).localeCompare(String(b[1])) || a[0].localeCompare(b[0])),
    [["changes", null, ["/Users/me/code/api"]], ["pulls", null, ["/Users/me/code/api"]], ["changes", "work", ["/srv/app"]]]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(answers, 3);
  const root = h.view.render();
  assert.equal(text(find(root, "git-t1")).replace(/\s+/g, " ").trim(), "+120 −8 #42");
  assert.equal(find(root, "git-work/t1"), null); // clean, and on main
  assert.match(find(root, "agent-t1").props.tooltip, /Uncommitted: \+120 −8 in 3 files\nPull request #42 · draft\nhttps:\/\/github\.com\/me\/api\/pull\/42/);
  // Not asked again until due: changes every half minute, pull requests every five.
  h.view.askGit(() => answers++);
  assert.equal(h.execs.length, 3);
  for (const state of h.view.git.values()) state.asked = Date.now() - 31000;
  h.view.askGit(() => answers++);
  assert.equal(h.execs.length, 5);
  assert.deepEqual(background.parsePulls('R 2 {"number":7,"state":"MERGED"}\nR 9 {"number":1}\nR 1 nonsense\n', ["/a", "/b"]), new Map([["/b", { number: 7, state: "merged", url: "" }]]));
});

test("a terminal an agent started stays with it; a narrow title bar keeps its buttons; projects have no folder headings", () => {
  const h = spaced();
  h.state.terminals.push({ address: "t8", state: "live", status: "working", title: "Helper", parent: "t1", program: { name: "Claude", agent: true }, labels: { "herdr.space": "s1" } });
  // No move button for it, and merging or organizing leaves it where it is.
  assert.equal(find(hover(h, "agent-t8"), "move-t8"), null);
  find(hover(h, "section-local:space:s1"), "space-merge-local:space:s1").props.on_click(null, h.cx);
  assert.equal(h.view.moving.addresses.includes("t8"), false);
  h.view.moving = null;
  assert.doesNotMatch(model.organizeBrief(h.view.rows, h.state.spaces).prompt, /Helper/);
  // Under 270 px the count goes and the title gives way; every button stays.
  h.state.machines = [{ name: null, layout: "ready" }];
  h.view.width = 250;
  let root = h.view.render();
  assert.equal(find(root, "sessions-count"), null);
  for (const id of ["new-space-local", "new-local", "organize", "settings"]) assert.ok(find(root, id), id);
  h.view.width = 320;
  assert.ok(find(h.view.render(), "sessions-count"));
  for (const pane of h.state.panes) pane.cwd = "/Users/me/code/api";
  h.sharedState["agent-sidebar.group"] = "project";
  assert.deepEqual(ids(h.view.render()).filter(id => id.startsWith("folder-")), []);
});

test("the gear's window is the sidebar's settings, in tabs: every choice is shared state, and Herdr's settings are a click further", () => {
  const h = setup({ settings: true });
  let root = h.view.render();
  assert.equal(root.props.id, "sidebar-settings");
  // The window says its own height, so the tab that scrolls has room.
  assert.deepEqual([root.props.h, find(root, "sidebar-settings-list").props.flex_1 !== undefined], [520, true]);
  // Four tabs, the first one shown; each says what it is about.
  const tabs = ["layout", "list", "sessions", "organize"];
  assert.deepEqual(tabs.map(tab => find(root, `tab-${tab}`).props.aria_selected), [true, false, false, false]);
  assert.match(text(find(root, "sidebar-settings-list")), /Layout How the list is arranged\./);
  // A control, wherever its tab is: the tab is opened first.
  const at = id => {
    for (const tab of tabs) {
      find(h.view.render(), `tab-${tab}`).props.on_click(null, h.cx);
      const node = find(h.view.render(), id);
      if (node) return node;
    }
    return null;
  };
  assert.deepEqual(tabs.map(tab => { find(h.view.render(), `tab-${tab}`).props.on_click(null, h.cx); return ids(find(h.view.render(), "sidebar-settings-list")).filter(id => /^set-[a-zA-Z]+$/.test(id)).length; }), [4, 8, 8, 4]);
  find(h.view.render(), "tab-layout").props.on_click(null, h.cx);
  root = h.view.render();
  // Rows and grouping, each one of a few.
  assert.equal(find(root, "set-density-compact").props.aria_selected, true);
  find(root, "set-density-expanded").props.on_click(null, h.cx);
  find(root, "set-group-project").props.on_click(null, h.cx);
  assert.deepEqual([h.sharedState["agent-sidebar.density"], h.sharedState["agent-sidebar.group"]], ["expanded", "project"]);
  assert.equal(at("set-group-project").props.aria_selected, true);
  // Every switch is there, on by default; a click turns it off, another back on.
  const keys = Object.keys(model.DEFAULTS).filter(key => typeof model.DEFAULTS[key] === "boolean");
  assert.equal(keys.length, 18);
  // Organize asks Claude Code or Codex, each with the families it has.
  assert.ok(at("set-organizeModel-sonnet") && !at("set-organizeCodex-terra"));
  at("set-organizeWith-codex").props.on_click(null, h.cx);
  assert.equal(at("set-organizeCodex-terra").props.aria_selected, true);
  at("set-organizeCodex-sol").props.on_click(null, h.cx);
  assert.deepEqual([h.sharedState["agent-sidebar.settings"].organizeWith, h.sharedState["agent-sidebar.settings"].organizeCodex], ["codex", "sol"]);
  at("set-organizeWith-claude").props.on_click(null, h.cx);
  for (const key of keys) {
    assert.equal(at(`set-${key}`).props.aria_selected, true, key);
    at(`set-${key}`).props.on_click(null, h.cx);
    assert.equal(h.sharedState["agent-sidebar.settings"][key], false, key);
    assert.equal(at(`set-${key}`).props.aria_selected, false, key);
  }
  at("set-model").props.on_click(null, h.cx);
  assert.equal(h.sharedState["agent-sidebar.settings"].model, true);
  // The ones of a few: how old is old, and what Organize asks.
  at("set-cleanupDays-7").props.on_click(null, h.cx);
  at("set-organizeModel-haiku").props.on_click(null, h.cx);
  at("set-organizeEffort-high").props.on_click(null, h.cx);
  assert.deepEqual(model.settingsOf(h.sharedState["agent-sidebar.settings"]).cleanupDays, 7);
  assert.deepEqual([h.sharedState["agent-sidebar.settings"].organizeModel, h.sharedState["agent-sidebar.settings"].organizeEffort], ["haiku", "high"]);
  // Reset is the defaults again; what is saved wrong is the default too.
  find(h.view.render(), "settings-reset").props.on_click(null, h.cx);
  assert.deepEqual([h.sharedState["agent-sidebar.settings"], h.sharedState["agent-sidebar.density"], h.sharedState["agent-sidebar.group"]], [{}, "compact", "status"]);
  assert.deepEqual(model.settingsOf({ model: "yes", cleanupDays: 2, organizeModel: "gpt", age: false }), { ...model.DEFAULTS, age: false });
  assert.deepEqual(model.settingsOf(undefined), model.DEFAULTS);
  // Herdr's own settings, and the way out.
  assert.match(text(at("organize-sends")), /to Anthropic\./);
  at("set-organizeWith-codex").props.on_click(null, h.cx);
  assert.match(text(find(h.view.render(), "organize-sends")), /to OpenAI\./);
  find(h.view.render(), "herdr-settings").props.on_click(null, h.cx);
  assert.deepEqual(h.commands, [{ name: "app.settings", args: undefined }]);
  assert.ok(find(h.view.render(), "settings-done") && find(h.view.render(), "settings-close"));
});

test("each setting changes what the sidebar shows, and what it asks the machines", async () => {
  const h = setup();
  const day = 24 * 3600 * 1000;
  h.state.machines.push({ name: "attic", layout: "unavailable" });
  h.state.terminals = [
    { address: "t1", state: "live", status: "working", title: "Fix login", program: { name: "Claude", agent: true }, status_ms: Date.now() - 300000 },
    { address: "t2", state: "live", status: "idle", title: "Old one", program: { name: "Claude", agent: true }, status_ms: Date.now() - 2 * day },
    { address: "t3", state: "live", status: "idle", title: "Other", program: { name: "Claude", agent: true }, status_ms: Date.now() - 600000 },
    { address: "t9", state: "live", program: { name: "zsh", shell: true }, cwd: "/Users/me" },
  ];
  h.state.panes = [{ pane: "p1", terminal: "t1", tab: "tb", cwd: "/Users/me/code/api", branch: "fix" }, { pane: "p2", terminal: "t2", tab: "tb", cwd: "/Users/me/code/api", branch: "fix" }, { pane: "p3", terminal: "t3", tab: "tb", cwd: "/Users/me/code/api", branch: "fix" }];
  h.state.focused = { terminal: "t3" };
  h.view.work = new Map([["t1", { ...reading("claude-opus-5-5", "xhigh"), context: 159000, activity: { tool: "Bash", detail: "Run the tests" },
    subagents: [{ id: "a1", type: "Explore", description: "Look around", background: false, started: Date.now() - 60000 }] }]]);
  h.view.git.set(null, { changes: new Map([["/Users/me/code/api", { files: 2, added: 12, removed: 3 }]]), pulls: new Map([["/Users/me/code/api", { number: 7, state: "open", url: "" }]]), asked: Date.now(), pulled: Date.now() });
  h.view.width = 460;
  h.sharedState["agent-sidebar.closed"] = [{ title: "Gone", cwd: "/w", machine: null, session: "zzz-1", at: Date.now() - 60000 }];
  const cfg = change => { h.sharedState["agent-sidebar.settings"] = change; return h.view.render(); };
  const has = (root, id) => Boolean(find(root, id));
  // Everything on, as it comes.
  let root = cfg({});
  assert.deepEqual(["agent-t1#a1", "agent-t9", "host-remote:attic", "add-machine", "closed", "clean-up", "organize", "uses-t1"].map(id => has(root, id)), Array(8).fill(true));
  assert.ok(ids(root).some(id => id.startsWith("folder-")));
  assert.match(text(find(root, "agent-t1")), /Fix login Bash · Run the tests Opus · xhigh 5m/);
  // Layout.
  root = cfg({ folders: false, subagents: false, shells: false, away: false });
  assert.deepEqual(["agent-t1#a1", "agent-t9", "host-remote:attic"].map(id => has(root, id)), [false, false, false]);
  assert.deepEqual(ids(root).filter(id => id.startsWith("folder-")), []);
  assert.equal(text(find(root, "sessions-count")), "3");
  assert.ok(has(root, "section-local:working")); // the hidden sub-agent still keeps its session in Working
  // On each session.
  root = cfg({ model: false });
  assert.equal(text(find(root, "uses-t1")), "xhigh");
  root = cfg({ effort: false });
  assert.equal(text(find(root, "uses-t1")), "Opus");
  assert.equal(has(cfg({ model: false, effort: false }), "uses-t1"), false);
  assert.doesNotMatch(text(find(cfg({ activity: false }), "agent-t1")), /Run the tests/);
  assert.doesNotMatch(text(find(cfg({ age: false }), "agent-t1")), /5m/);
  h.sharedState["agent-sidebar.density"] = "expanded";
  root = cfg({});
  assert.equal(text(find(root, "git-t3")).replace(/\s+/g, " ").trim(), "+12 −3 #7");
  assert.match(text(find(root, "uses-t1")), /159k/);
  assert.equal(text(find(cfg({ changes: false }), "git-t3")).trim(), "#7");
  assert.equal(text(find(cfg({ pulls: false }), "git-t3")).replace(/\s+/g, " ").trim(), "+12 −3");
  assert.equal(has(cfg({ changes: false, pulls: false }), "git-t3"), false);
  assert.doesNotMatch(text(find(cfg({ context: false }), "uses-t1")), /159k/);
  h.sharedState["agent-sidebar.density"] = "compact";
  // Under the list.
  root = cfg({ addMachine: false, closed: false, cleanup: false });
  assert.deepEqual(["add-machine", "closed", "clean-up"].map(id => has(root, id)), [false, false, false]);
  assert.equal(has(cfg({ cleanupDays: 3 }), "clean-up"), false); // two days is not old any more
  assert.match(text(find(cfg({ cleanupDays: 1 }), "clean-up")), /Close 1 session idle for over a day/);
  // Organize: its button, and what it asks.
  assert.equal(has(cfg({ organize: false }), "organize"), false);
  h.answer(async () => ({ code: 1, stderr: "no", stdout: "" }));
  find(cfg({ organizeModel: "haiku", organizeEffort: "high" }), "organize").props.on_click(null, h.cx);
  assert.deepEqual(h.execs.at(-1)[1].slice(3, 8), ["-p", "--model", "haiku", "--effort", "high"]);
  await new Promise(resolve => setTimeout(resolve, 0));
  // Changes and pull requests that are off are not asked for.
  h.execs.length = 0;
  for (const state of h.view.git.values()) Object.assign(state, { asked: 0, pulled: 0 });
  cfg({ changes: false, pulls: false });
  h.view.askGit(() => {});
  assert.equal(h.execs.length, 0);
  cfg({ pulls: false });
  h.view.askGit(() => {});
  assert.deepEqual(h.execs.map(([, args]) => args[1] === background.CHANGES), [true]);
  // No motion: a status change moves rows without a slide or a fade.
  cfg({ animations: false });
  h.state.terminals[2].status = "blocked";
  root = cfg({ animations: false });
  assert.equal(findStart(root, "slide-"), null);
  assert.equal(find(root, "tint-t3-" + [...h.view.fresh.values()][0]?.at), null);
});

test("Organize can ask Codex instead: the latest model of the family chosen, read from Codex's own list", async () => {
  const h = spaced();
  h.sharedState["agent-sidebar.settings"] = { organizeWith: "codex", organizeEffort: "medium" };
  h.file(JSON.stringify({ models: [{ slug: "gpt-6.1-terra", visibility: "list" }, { slug: "gpt-5.6-terra", visibility: "list" }, { slug: "gpt-6.2-sol", visibility: "list" }] }));
  let asked;
  h.answer(async (cmd, args, opts) => {
    asked = { cmd, args, opts };
    const id = title => args.at(-1).match(new RegExp(`- (s\\d+): "${title}"`))[1];
    return { code: 0, stderr: "", stdout: JSON.stringify({ machines: [{ machine: "local", spaces: [{ name: "Billing", sessions: [id("Rotate keys"), id("Add retries")] }, { name: "API", sessions: [id("Fix login")] }] }] }) };
  });
  let root = h.view.render();
  assert.match(find(root, "organize").props.tooltip, /with Codex \(latest terra, medium effort\)/);
  find(root, "organize").props.on_click(null, h.cx);
  assert.match(text(find(h.view.render(), "plan")), /Asking Codex how to arrange them…/);
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(h.reads, ["/Users/me/.codex/models_cache.json"]);
  // The schema first (the script writes it to a file), then the model, the effort and the question.
  assert.deepEqual([asked.cmd, asked.opts.on, asked.args[1].includes("codex exec"), JSON.parse(asked.args[3]).additionalProperties, asked.args.slice(4, 8)],
    ["sh", null, true, false, ["-m", "gpt-6.1-terra", "-c", 'model_reasoning_effort="medium"']]);
  assert.match(asked.args.at(-1), /^You organize a developer's terminal sessions[\s\S]*Machine "local"\. Spaces now: "API", "Billing"/);
  root = h.view.render();
  assert.match(text(find(root, "plan")), /Codex's suggestion, previewed below 1 session moves/);
  assert.equal(text(find(root, "moves-t3")), "from API");
  find(root, "plan-dismiss").props.on_click(null, h.cx);
  // "Auto" leaves the model to Codex, and reads nothing; a family Codex doesn't list does too.
  h.sharedState["agent-sidebar.settings"] = { organizeWith: "codex", organizeCodex: "auto" };
  find(h.view.render(), "organize").props.on_click(null, h.cx);
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual([h.reads.length, asked.args.slice(4, 6)], [1, ["-c", 'model_reasoning_effort="low"']]);
  find(h.view.render(), "plan-dismiss")?.props.on_click(null, h.cx);
  h.sharedState["agent-sidebar.settings"] = { organizeWith: "codex", organizeCodex: "astra" };
  find(h.view.render(), "organize").props.on_click(null, h.cx);
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual([h.reads.length, asked.args[4]], [2, "-c"]);
  // No answer names the one that was asked.
  find(h.view.render(), "plan-dismiss")?.props.on_click(null, h.cx);
  h.answer(async () => ({ code: 0, stderr: "", stdout: "" }));
  find(h.view.render(), "organize").props.on_click(null, h.cx);
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(h.notes.at(-1).body, /Codex gave no answer\. Is `codex` installed/);
});

test("the example copy shows example sessions, asks no machine anything, and holds nothing of anyone's", () => {
  const h = setup({ demo: true });
  h.view.width = 340;
  const root = h.view.render();
  const list = ids(root);
  for (const id of ["host-local", "host-remote:studio", "host-remote:attic", "section-local:blocked", "agent-t5#a1", "git-t2", "closed", "organize", "settings"]) assert.ok(list.includes(id), id);
  assert.match(text(find(root, "agent-t1")), /Rotate the API signing keys Asks · Rotate the staging keys too\?/);
  assert.match(text(find(root, "agent-studio/t1")), /Train the ranking model Bash · Train for 20 epochs Fable/);
  assert.match(text(find(root, "sessions-count")), /^11$/);
  // The app's own sessions are not in it, and nothing was run or read.
  assert.equal(list.includes("agent-work/t1"), false);
  assert.deepEqual([h.execs.length, h.hcs.length, h.reads.length, h.commands.length, h.view.demo], [0, 0, 0, 0, true]);
  const all = JSON.stringify([...demos.demo(0).work, demos.demo(0).terminals, demos.demo(0).panes, demos.demo(0).shared]);
  // Every folder in it is an example's: under /Users/me or /home/me.
  assert.deepEqual((all.match(/\/(?:Users|home)\/[^/"]+/g) ?? []).filter(home => !["/Users/me", "/home/me"].includes(home)), []);
});

test("each machine's heading says how busy it is, from herdr-stats here while it runs, and asks nothing when it can't show it", async () => {
  const h = setup();
  const GB = 2 ** 30;
  h.state.machines.push({ name: "attic", layout: "unavailable" });
  h.view.width = 372;
  const figures = (root, key) => text(find(root, `stats-${key}`)).replace(/\s+/g, " ").trim();
  let root = h.view.render();
  assert.equal(find(root, "stats-local"), null); // nothing read yet
  assert.deepEqual(h.view.headed, [null, "work"]); // not the one that is away
  h.file(JSON.stringify({ v: 1, t: Date.now(), cpu: { total: 0.18 }, mem: { used: 21.4 * GB, total: 32 * GB, pressure: 0.12 } }));
  h.answer(async (_cmd, args) => ({ code: 0, stderr: "", stdout: args[1] === background.STATS ? `U 86 ${28 * GB} ${32 * GB} 52\n` : "" }));
  let answers = 0;
  h.view.askStats(() => answers++);
  await settle();
  // This computer's come from herdr-stats' snapshot, running nothing; the other's are measured there.
  assert.deepEqual(h.reads, ["/Users/me/Library/Caches/herdr-stats/snapshot.json"]);
  assert.deepEqual(h.execs.map(([cmd, args, opts]) => [cmd, args[1] === background.STATS, opts.on]), [["sh", true, "work"]]);
  assert.equal(answers, 2);
  root = h.view.render();
  assert.equal(figures(root, "local"), "18% 67%");
  assert.equal(figures(root, "remote:work"), "86% 88%");
  assert.deepEqual(glyphs(find(root, "stats-remote:work")).map(g => g.props.src.split("/").pop()), ["cpu.svg", "memory.svg"]);
  assert.match(find(root, "host-remote:work").props.tooltip, /\nCPU 86% · Memory 28 of 32 GB \(88%\), pressure 52%$/);
  assert.equal(find(root, "stats-remote:work").props.tooltip, "CPU 86% · Memory 28 of 32 GB (88%), pressure 52%");
  assert.match(find(root, "host-local").props.accessibility_label, /, CPU 18% · Memory 21\.4 of 32 GB \(67%\), pressure 12%, expanded$/);
  // Not asked again before it is due.
  h.view.askStats(() => answers++);
  assert.equal(h.execs.length + h.reads.length, 2);
  // Ten seconds on, with herdr-stats' sampler stopped: this computer is measured too. The same
  // figures again draw nothing new.
  h.file(JSON.stringify({ v: 1, t: Date.now() - 60000, cpu: { total: 0.5 } }));
  for (const state of h.view.stats.values()) state.asked = Date.now() - background.STATS_MS;
  h.view.askStats(() => answers++);
  await settle();
  assert.deepEqual(h.execs.slice(1).map(([, , opts]) => opts.on).sort(), [null, "work"]);
  assert.equal(answers, 3);
  assert.equal(figures(h.view.render(), "local"), "86% 88%");
  // A machine that answers slowly is not asked twice meanwhile.
  h.answer(() => new Promise(() => {}));
  for (const state of h.view.stats.values()) state.asked = 0;
  h.view.askStats(() => answers++);
  h.view.stats.get("work").asked = 0;
  h.view.askStats(() => answers++);
  await settle();
  assert.equal(h.execs.filter(([, , opts]) => opts.on === "work").length, 3);
  // One that stopped answering keeps its figures a while, then shows none.
  h.view.stats.get("work").reading.at = Date.now() - background.STATS_STALE_MS - 1;
  root = h.view.render();
  assert.equal(find(root, "stats-remote:work"), null);
  assert.doesNotMatch(find(root, "host-remote:work").props.tooltip, /CPU/);
  // Narrower, memory goes first, then CPU; the tooltip keeps both.
  h.view.stats.get("work").reading.at = Date.now();
  h.view.width = 250;
  assert.deepEqual(ids(find(h.view.render(), "stats-remote:work")).filter(id => id.startsWith("stat-")), ["stat-remote:work-cpu"]);
  h.view.width = 215;
  root = h.view.render();
  assert.equal(find(root, "stats-remote:work"), null);
  assert.match(find(root, "host-remote:work").props.tooltip, /CPU 86%/);
  // No figures, nothing asked: in a rail, by project (no machine headings), with one machine,
  // or turned off.
  h.view.width = 100;
  h.view.render();
  assert.deepEqual(h.view.headed, []);
  h.view.width = 372;
  h.sharedState["agent-sidebar.group"] = "project";
  h.view.render();
  assert.deepEqual(h.view.headed, []);
  h.sharedState["agent-sidebar.group"] = "status";
  h.sharedState["agent-sidebar.settings"] = { stats: false };
  root = h.view.render();
  assert.deepEqual([find(root, "stats-local"), find(root, "stats-remote:work")], [null, null]);
  assert.doesNotMatch(find(root, "host-local").props.tooltip, /CPU/);
  const before = [h.execs.length, h.reads.length];
  for (const state of h.view.stats.values()) state.asked = 0;
  h.view.askStats(() => answers++);
  assert.deepEqual([h.execs.length, h.reads.length, h.view.stats.size], [...before, 0]);
  h.sharedState["agent-sidebar.settings"] = {};
  h.state.machines = [{ name: null, layout: "ready" }];
  h.view.render();
  assert.deepEqual(h.view.headed, []);
});

test("asking for an organization leaves each machine's clock alone, so the looks go on", async () => {
  const h = setup();
  h.answer(async () => ({ code: 1, stderr: "no", stdout: "" }));
  find(h.view.render(), "organize").props.on_click(null, h.cx);
  await settle();
  assert.ok(h.view.asked instanceof Map);
  assert.doesNotThrow(() => h.view.probe(() => {}));
});
