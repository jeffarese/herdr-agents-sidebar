// Exercise real view/event code with an in-memory GPUI builder. This does not replace native QA.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as model from "../mods/agent-sidebar/model.js";
import * as background from "../mods/agent-sidebar/background.js";
import * as folders from "../mods/agent-sidebar/folders.js";

function setup(initial = {}, saved = {}) {
  const commands = [];
  const overlays = [];
  const execs = [];
  const hcs = [];
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
  const cx = { notify() {}, stop_propagation() {}, spawn(f) { tasks.push(f); }, focus_handle() { return { focus() {} }; }, timer: { every(ms) { timers.push(ms); } } };
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
    home: () => "/Users/me", pickFolder: async () => picked,
    localStorage: storage, shared: key => sharedState[key], setShared: (key, value) => { sharedState[key] = value; },
    updates: () => ({ app: { ready: null } }),
    exec: (...args) => { execs.push(args); return execResult(...args); },
    hc: async args => { hcs.push(args); return hcResult; }, notify: note => { notes.push(note); return "n1"; },
    ...model, ...background, ...folders,
  };
  const launcherSource = readFileSync(new URL("../mods/agent-sidebar/launcher.js", import.meta.url), "utf8").replace(/^import [\s\S]*?;$/gm, "").replace(/export (function|const)/g, "$1");
  Object.assign(imports, new Function(...Object.keys(imports), `${launcherSource}\nreturn { initLauncher, renderLauncher, LAUNCHER };`)(...Object.values(imports)));
  const source = readFileSync(new URL("../mods/agent-sidebar/main.js", import.meta.url), "utf8").replace(/^import [\s\S]*?;$/gm, "").replace("export default class", "return class");
  const View = new Function(...Object.keys(imports), source)(...Object.values(imports));
  const view = new View();
  // GPUI init receives its own props; Herdr supplies overlay props through herdr.props().
  view.init({}, cx);
  const settle = async () => { while (tasks.length) await tasks.shift()(cx); };
  return { view, cx, input, state, commands, overlays, storage, timers, sharedState, execs, settle, hcs, notes, hcFails: stderr => { hcResult = { code: 1, stdout: "", stderr }; },
    answer: f => { execResult = f; }, agents: list => { agentList = list; }, pick: path => { picked = path; },
    order: () => order, scrollTo: () => scrollTo };
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
  find(root, "settings").props.on_click();
  find(root, "add-machine").props.on_click();
  assert.deepEqual(h.commands, [{ name: "app.settings", args: undefined }, { name: "mod.open", args: { name: "machine-add" } }]);
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
  assert.match(sub.props.tooltip, /^Review the repo\nSub-agent, in the background · general-high\nLocal · This computer\nWorking · 3m/);
  assert.match(text(sub), /Review the repo general-high 3m/);
  // Counted as part of its session, and not a terminal for next/previous agent.
  assert.equal(text(find(root, "sessions-count")), "2");
  assert.match(text(find(root, "section-local:working")), /Working 1/);
  assert.match(text(find(root, "host-local")), /LOCAL 1/);
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

test("Tab moves Enter's program through the list and back; it shows which", async () => {
  const h = launcherSetup();
  h.agents([claude, { key: "codex", name: "Codex", run: ["codex"], installed: true }]);
  await h.settle();
  const tab = shift => h.view.render().props.on_key_down({ key: "tab", keystroke: shift ? "shift-tab" : "tab", modifiers: { shift } }, h.cx);
  let root = h.view.render();
  assert.equal(find(root, "launch-shell").props.aria_selected, true); // nothing started yet: a shell
  tab(false);
  tab(false);
  root = h.view.render();
  assert.equal(find(root, "launch-codex").props.aria_selected, true);
  assert.match(text(find(root, "launch-codex")), /↵/);
  tab(false); // wraps
  tab(true); // and back
  h.input.handlers.submit();
  assert.deepEqual(h.commands, [{ name: "tab.new", args: { name: "Codex", argv: ["codex"], folder: "/Users/me/api/server", space: "s1" } }]);
});

test("a typed folder that is not there says so and starts nothing", async () => {
  const h = launcherSetup();
  h.answer(async () => ({ code: 3, stdout: "", stderr: "" }));
  h.input.text = "/nope/";
  h.input.handlers.change(null, h.cx);
  await h.settle();
  const root = h.view.render();
  assert.match(text(root), /No folder \/nope on this computer/);
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
  assert.doesNotMatch(h.view.tip(h.view.rows[0], Date.now()), /This computer/);
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
  find(root, "density").props.on_click(null, h.cx);
  assert.equal(h.sharedState["agent-sidebar.density"], "expanded");
  root = h.view.render();
  assert.equal(find(root, "agent-t1").props.h, 40);
  assert.match(text(find(root, "agent-t1")), /~\/code\/api · fix-login/);
  assert.equal(find(root, "density").props.aria_selected, true);
  // The rail is unchanged: icons only.
  h.view.width = 76;
  assert.equal(find(h.view.render(), "agent-t1").props.h, 28);
  h.view.width = 320;
  find(h.view.render(), "density").props.on_click(null, h.cx);
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
  find(root, "group").props.on_click(null, h.cx);
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
  assert.equal(find(root, "group").props.aria_selected, false);
  assert.ok(find(root, "section-local:blocked"));
  find(root, "group").props.on_click(null, h.cx);
  assert.equal(h.sharedState["agent-sidebar.group"], "space");
  root = h.view.render();
  assert.equal(find(root, "group").props.aria_selected, true);
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
  find(root, "group").props.on_click(null, h.cx);
  assert.equal(h.sharedState["agent-sidebar.group"], "project");
  find(h.view.render(), "group").props.on_click(null, h.cx);
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
  // Dropped anywhere else, nothing moves and the move is over.
  root = h.view.render();
  find(root, "agent-t3").props.on_mouse_down[1]();
  find(root, "agent-t2").props.on_mouse_move(null, h.cx);
  find(h.view.render(), "agent-t2").props.on_mouse_up[1](null, h.cx);
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
  assert.deepEqual(h.hcs, [["send", "t1", "continue with the plan"]]);
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
  assert.match(text(find(root, "plan")), /Claude suggests Rename API to Auth To Billing: Add retries Apply · moves 1 Dismiss/);
  assert.deepEqual(h.commands, []);
  find(root, "plan-apply").props.on_click(null, h.cx);
  assert.deepEqual(h.commands, [{ name: "space.rename", args: { id: "s1", name: "Auth" } }, { name: "terminal.park", args: { terminal: "t3" } }]);
  assert.equal(find(h.view.render(), "plan"), null);
  // Dismiss changes nothing; a new space is named once Herdr shows it.
  h.answer(async (_cmd, args) => ({ code: 0, stderr: "", stdout: JSON.stringify({ result: JSON.stringify({ machines: [{ machine: "local", spaces: [{ name: "Billing", sessions: [args.at(-1).match(/- (s\d+): "Fix login"/)[1]] }, { name: "Keys", sessions: [args.at(-1).match(/- (s\d+): "Rotate keys"/)[1]] }] }] }) }) }));
  h.view.pending = [];
  find(h.view.render(), "organize").props.on_click(null, h.cx);
  await new Promise(resolve => setTimeout(resolve, 0));
  find(h.view.render(), "plan-dismiss").props.on_click(null, h.cx);
  assert.equal(h.commands.length, 2);
  find(h.view.render(), "organize").props.on_click(null, h.cx);
  await new Promise(resolve => setTimeout(resolve, 0));
  find(h.view.render(), "plan-apply").props.on_click(null, h.cx);
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
