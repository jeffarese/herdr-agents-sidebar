import test from "node:test";
import assert from "node:assert/strict";
import { build, groups, counts, modelName, fitWhere, openAction, newSessionAction, sectionize, duration, backgroundLines, shortPath, holdDone, dropLeaving, LEAVE_MS } from "../mods/agent-sidebar/model.js";

const program = { key: "claude", name: "Claude Code", agent: true };
const terminal = (address, status = "idle", extra = {}) => ({ address, status, state: "live", program, title: "Fix login", ...extra });
const hosts = [{ name: "work", layout: "ready" }, { name: null, layout: "ready" }];
const world = extra => ({ machines: hosts, terminals: [terminal("t1"), terminal("work/t1", "working")], ...extra });

test("local and remote IDs stay distinct even when the terminal numbers match", () => {
  const rows = build(world());
  assert.equal(rows.length, 2);
  assert.deepEqual(groups(rows, hosts).map(g => [g.label, g.remote, g.rows[0].address]), [
    ["This computer", false, "t1"], ["work", true, "work/t1"],
  ]);
});

test("live agents, shells and other programs are listed once; finished and temporary hosts stay out", () => {
  const rows = build(world({
    agents: [{ address: "t1", status: "idle", program, pane: "p1" }],
    terminals: [terminal("t1"), terminal("t2", "working", { parent: "t1" }),
      terminal("t3", null, { program: { shell: true } }), terminal("t4", "idle", { state: "finished" }),
      terminal("sandbox/t1"), terminal("t5", null), terminal("t6", "working", { program: { key: "custom" } })],
  }));
  assert.deepEqual(new Set(rows.map(r => r.address)), new Set(["t1", "t2", "t3", "t5", "t6"]));
  assert.equal(rows.find(r => r.address === "t3").kind, "shell");
  assert.equal(rows.find(r => r.address === "t3").status, "idle");
  assert.equal(rows.find(r => r.address === "t2").parent, "t1");
  assert.equal(rows.find(r => r.address === "t5").status, "unknown");
});

test("attention takes priority over pinned idle agents, then done, then working", () => {
  const rows = build(world({ terminals: [terminal("t1", "idle", { labels: { "herdr.pinned": "true" } }),
    terminal("t2", "done"), terminal("t3", "working"), terminal("t4", "error")] }));
  assert.deepEqual(rows.map(r => r.address), ["t4", "t2", "t3", "t1"]);
  assert.deepEqual(counts(rows), { all: 4, blocked: 1, done: 1, working: 1, idle: 1, unknown: 0 });
});

test("machine identity comes from the address even if space metadata is missing or misleading", () => {
  const rows = build(world({ agents: [{ address: "t1", status: "idle", space_name: "work" }] }));
  assert.equal(rows.find(r => r.address === "t1").machine, null);
  assert.equal(rows.find(r => r.address === "work/t1").machine, "work");
});

test("task title wins over folder, program, and automatically named tabs", () => {
  const rows = build(world({ agents: [{ address: "t1", title: "✳ Build sidebar", status: "working", program, space_name: "app" }] }));
  assert.equal(rows.find(r => r.address === "t1").title, "Build sidebar");
  const fallback = build(world({ terminals: [terminal("t1", "idle", { title: "/Users/me/code", report: { title: "Review changes" } })] }));
  assert.equal(fallback[0].title, "Review changes");
});

test("named tabs provide a meaningful fallback when an agent has no task title", () => {
  const rows = build(world({
    agents: [{ address: "t1", title: "Claude Code", status: "idle", program, tab: "tab1" }],
    terminals: [terminal("t1", "idle", { title: "Claude Code" })],
    spaces: [{ name: "app", tabs: [{ id: "tab1", name: "Review API", named: true }] }],
  }));
  assert.equal(rows[0].title, "Review API");
});

test("unavailable hosts come last, cannot open stale rows, and never imply a connection", () => {
  const machines = [{ name: "zeta", layout: "ready" }, { name: "away", layout: "unavailable" }, { name: null, layout: "ready" }, { name: "work", layout: "unavailable" }, { name: "studio", layout: "loading" }];
  const rows = build(world({ machines }));
  assert.equal(openAction(rows.find(r => r.machine)), null);
  // This computer, the machines that can be reached by name, then the ones that can't.
  assert.deepEqual(groups(rows, machines).map(g => [g.label, g.layout]), [
    ["This computer", "ready"], ["studio", "loading"], ["zeta", "ready"], ["away", "unavailable"], ["work", "unavailable"],
  ]);
});

test("a model id reads as its family and version, whatever the provider's spelling", () => {
  assert.deepEqual(["claude-fable-5-2", "claude-opus-4-1-20250805", "us.anthropic.claude-3-5-sonnet-20241022-v2:0", "claude-opus-5-5[1m]", "claude-sonnet-4-5@20250929", "claude-haiku-latest"].map(id => modelName(id).label),
    ["Fable 5.2", "Opus 4.1", "Sonnet 3.5", "Opus 5.5", "Sonnet 4.5", "Haiku"]);
  assert.equal(modelName("claude-opus-5-5").family, "Opus");
  assert.deepEqual(modelName("opus[1m]"), { family: "Opus", label: "Opus" }); // "--model opus"
  // Another maker's id is shown as it is; no id, nothing.
  assert.deepEqual(modelName("gpt-5.1-codex"), { family: "gpt-5.1-codex", label: "gpt-5.1-codex" });
  assert.equal(modelName(""), null);
  assert.equal(modelName(undefined), null);
});

test("a session carries the model and effort its machine read, while the reading is fresh", () => {
  const now = Date.now();
  const read = at => new Map([["t1", { at, session: { status: "idle" }, goal: null, shells: [], subagents: [], model: "claude-opus-5-5", effort: "xhigh" }]]);
  const row = work => build(world({ work, now })).find(r => r.address === "t1");
  assert.deepEqual([row(read(now)).model, row(read(now)).effort, row(read(now)).status], ["claude-opus-5-5", "xhigh", "idle"]);
  assert.deepEqual([row(read(now - 60000)).model, row(new Map()).effort], [null, null]);
});

test("a folder too long for its line gives way from its start, keeping its last part and the branch", () => {
  assert.equal(fitWhere("~/code/app", "main", 40), "~/code/app · main");
  assert.equal(fitWhere("~/workspace/herdr/herdr-agents", "main", 27), "…/herdr/herdr-agents · main");
  assert.equal(fitWhere("~/workspace/herdr/herdr-agents", "main", 22), "…/herdr-agents · main");
  assert.equal(fitWhere("~/workspace/herdr/herdr-agents", "main", 4), "…/herdr-agents · main"); // the last part always stays
  assert.equal(fitWhere("~", null, 2), "~");
  assert.equal(fitWhere("", "main", 10), "main");
});

test("grouped by space, each of Herdr's spaces is a section in Herdr's order, its sessions by urgency", () => {
  const spaces = [{ id: "s2", name: "Billing", tabs: [{ id: "b1" }] }, { id: "s1", name: "API", tabs: [{ id: "a1" }, { id: "a2" }] }];
  const terminals = [terminal("t1", "idle"), terminal("t2", "blocked"), terminal("t3", "working"), terminal("t4", "idle"),
    terminal("t5", "working", { parent: "t1" }), terminal("t6", "idle", { labels: { "herdr.space": "s2" } })];
  const panes = [{ terminal: "t1", pane: "p1", tab: "a1" }, { terminal: "t2", pane: "p2", tab: "a2" }, { terminal: "t3", pane: "p3", tab: "b1" }];
  const rows = build(world({ machines: [{ name: null, layout: "ready" }], terminals, panes, spaces }));
  const sections = sectionize(rows, "space");
  assert.deepEqual(sections.map(s => [s.id, s.label, s.space, s.entries.map(e => e.row.address)]), [
    ["space:s2", "Billing", "s2", ["t3", "t6"]],
    ["space:s1", "API", "s1", ["t2", "t1", "t5"]], // a sub-agent stays under its session
    ["space:", "No space", null, ["t4"]],
  ]);
  assert.deepEqual(groups(rows, [{ name: null, layout: "ready" }], "space")[0].sections.map(s => s.label), ["Billing", "API", "No space"]);
  // By status is unchanged.
  assert.deepEqual(sectionize(rows).map(s => s.id), ["blocked", "working", "idle"]);
});

test("a click focuses a pane using its exact machine-qualified ID or peeks an outside agent", () => {
  const rows = build(world({ panes: [{ terminal: "work/t1", pane: "work/p9" }] }));
  assert.deepEqual(openAction(rows.find(r => r.machine)), { name: "pane.focus", args: { pane: "work/p9" } });
  assert.deepEqual(openAction(rows.find(r => !r.machine)), { name: "terminal.peek", args: { terminal: "t1" } });
});

test("empty startup still shows local loading; duplicate task names do not merge agents", () => {
  assert.deepEqual(groups([], []).map(g => [g.label, g.layout]), [["This computer", "loading"]]);
  assert.equal(build(world({ terminals: [terminal("t1"), terminal("t2")] })).length, 2);
});

test("shell rows use their live folder and preserve explicit names", () => {
  const shells = [terminal("t1", null, { title: "/Users/me/project", cwd: "/Users/me/old", foreground: { cwd: "/Users/me/project" }, program: { name: "zsh", shell: true } }),
    terminal("t2", null, { title: "zsh", name: "Release console", program: { name: "zsh", shell: true } })];
  const rows = build(world({ terminals: shells }));
  assert.equal(rows.find(r => r.address === "t1").title, "zsh · project");
  assert.equal(rows.find(r => r.address === "t2").title, "Release console");
});

test("attention, done and running work lead; pins promote; idle shells and programs sort with agents by recency", () => {
  const shell = { shell: true, name: "zsh" };
  const rows = build(world({ terminals: [
    terminal("shell", null, { program: shell, created_ms: 300 }),
    terminal("pinned-shell", null, { program: shell, labels: { "herdr.pinned": "true" } }),
    terminal("process", null, { program: { name: "Neovim" } }),
    terminal("idle"), terminal("working", "working"), terminal("done", "done"), terminal("attention", "blocked"),
  ] }));
  assert.deepEqual(rows.map(r => r.address), ["attention", "done", "working", "pinned-shell", "shell", "idle", "process"]);
  assert.equal(rows.find(r => r.address === "process").kind, "process");
});

test("new sessions always target the selected host, even while another host has focus", () => {
  const spaces = [{ id: "local-space", machine: null }, { id: "work/one", machine: "work" }, { id: "work/two", machine: "work" }];
  assert.deepEqual(newSessionAction(null, hosts, spaces, { space: "work/two" }), { name: "tab.new", args: { space: "local-space" } });
  assert.deepEqual(newSessionAction("work", hosts, spaces, { space: "work/two" }), { name: "tab.new", args: { space: "work/two" } });
  assert.deepEqual(newSessionAction(null, hosts, [], null), { name: "space.new", args: { machine: "" } });
  const agent = { name: "Codex", run: ["codex"] };
  assert.deepEqual(newSessionAction("work", hosts, [], null, agent), { name: "space.new", args: { machine: "work", name: "Codex", argv: ["codex"] } });
  assert.equal(newSessionAction("offline", hosts, spaces, null), null);
});

test("sections follow Herdr's priority, shells too; a sub-agent's done does not lift its parent", () => {
  const shell = { shell: true, name: "zsh" };
  const rows = build(world({ terminals: [
    terminal("parent"), terminal("kid", "done", { parent: "parent" }),
    terminal("busy", "working"), terminal("kept", "idle", { labels: { "herdr.pinned": "true" } }),
    terminal("sh", null, { program: shell }), terminal("odd", null),
  ] }));
  const sections = sectionize(rows.filter(r => !r.machine));
  assert.deepEqual(sections.map(s => [s.id, s.entries.map(e => `${e.row.address}:${e.depth}`)]), [
    ["working", ["busy:0"]], ["pinned", ["kept:0"]], ["idle", ["odd:0", "parent:0", "kid:1", "sh:0"]],
  ]);
});

test("a parent cycle or a missing parent never drops a session", () => {
  const rows = build(world({ terminals: [terminal("a", "idle", { parent: "b" }), terminal("b", "blocked", { parent: "a" }), terminal("c", "idle", { parent: "gone" })] }));
  const entries = sectionize(rows.filter(r => !r.machine)).flatMap(s => s.entries);
  assert.deepEqual(entries.map(e => e.row.address).sort(), ["a", "b", "c"]);
  assert.equal(groups(rows, hosts)[0].rows.length, 3);
});

test("durations read like Herdr's Agents panel", () => {
  assert.deepEqual([0, 59000, 4 * 60000, 3 * 3600000, 2 * 86400000].map(duration), ["<1m", "<1m", "4m", "3h", "2d"]);
});

test("an agent whose turn ended stays working while background work it started runs", () => {
  const now = Date.now();
  const reading = (session, extra = {}) => ({ at: now, session: { status: session }, goal: null, shells: [], ...extra });
  const work = new Map([
    ["t1", reading("shell", { shells: [{ text: "npm test", started: now - 4 * 60000 }] })],
    ["t2", reading("busy")],
    ["t3", reading("idle", { goal: { condition: "Ship the API", check: "Tests still fail" } })],
    ["t4", reading("idle")],
    // While it works, its shells are its own tool calls, not background work.
    ["t5", reading("busy", { shells: [{ text: "ls", started: now }] })],
    ["t6", { ...reading("shell"), at: now - 60000 }], // a reading too old to trust
    ["t7", reading("shell")],                         // the session file alone is enough
  ]);
  const rows = build(world({ terminals: ["done", "idle", "done", "done", "working", "done", "idle"].map((status, i) => terminal(`t${i + 1}`, status)), work, now }));
  const row = address => rows.find(r => r.address === address);
  assert.deepEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7"].map(a => [row(a).status, row(a).background.join()]), [
    ["working", "shell"], ["working", "agents"], ["working", "goal"], ["done", ""], ["working", ""], ["done", ""], ["working", "shell"],
  ]);
  assert.equal(row("t1").reported, "done");
  assert.deepEqual(row("t5").shells, []);
  assert.deepEqual(counts(rows.filter(r => !r.machine)), { all: 7, blocked: 0, done: 2, working: 5, idle: 0, unknown: 0 });
  assert.deepEqual(backgroundLines(row("t1"), now), ["Shell: npm test · 4m"]);
  assert.deepEqual(backgroundLines(row("t2"), now), ["Sub-agents or workflows are running"]);
  assert.deepEqual(backgroundLines(row("t3"), now), ["Goal: Ship the API", "Last check: Tests still fail"]);
  assert.deepEqual(backgroundLines(row("t7"), now), ["A background shell is running"]);
  assert.deepEqual(sectionize(rows.filter(r => !r.machine)).map(s => [s.id, s.entries.length]), [["done", 2], ["working", 5]]);
});

test("an open goal shows on agents that need you or are working without changing their status", () => {
  const now = Date.now();
  const goal = { condition: "Ship", check: "" };
  const work = new Map([["t1", { at: now, session: { status: "waiting" }, goal, shells: [] }], ["t2", { at: now, session: { status: "busy" }, goal, shells: [] }]]);
  const rows = build(world({ terminals: [terminal("t1", "blocked"), terminal("t2", "working")], work, now }));
  assert.deepEqual(rows.filter(r => !r.machine).map(r => [r.address, r.status, r.background.length, r.goal?.condition]), [["t1", "blocked", 0, "Ship"], ["t2", "working", 0, "Ship"]]);
  assert.deepEqual(backgroundLines(rows.find(r => r.address === "t2"), now), ["Goal: Ship"]);
});

test("a program or a working sub-agent in a Herdr terminal an agent started keeps it working", () => {
  const now = Date.now();
  const npm = { name: "npm", key: "npm" };
  const rows = build(world({ now, work: new Map([["k5", { at: now, session: { status: "shell" }, goal: null, shells: [] }]]), terminals: [
    terminal("p", "done"), terminal("k1", null, { parent: "p", program: npm, title: "npm test" }),
    terminal("q", "idle"), terminal("k2", null, { parent: "q", program: { name: "zsh", shell: true } }),
    terminal("r", "done"), terminal("k3", "working", { parent: "r", title: "Port the parser" }),
    terminal("s", "done"), terminal("k4", "done", { parent: "s" }),
    // A sub-agent that is done itself but waits on its own background shell.
    terminal("u", "idle"), terminal("k5", "done", { parent: "u", title: "Run evals" }),
  ] }));
  const row = address => rows.find(r => r.address === address);
  assert.deepEqual(["p", "q", "r", "s", "u", "k5"].map(a => [row(a).status, row(a).background.join()]), [
    ["working", "shell"], ["idle", ""], ["working", "agents"], ["done", ""], ["working", "agents"], ["working", "shell"],
  ]);
  assert.deepEqual(backgroundLines(row("p"), now), ["Running in k1: npm test"]);
  assert.deepEqual(backgroundLines(row("r"), now), ["Sub-agent in k3: Port the parser"]);
  const working = sectionize(rows.filter(r => !r.machine)).find(s => s.id === "working");
  assert.deepEqual(working.entries.map(e => `${e.row.address}:${e.depth}`), ["p:0", "k1:1", "r:0", "k3:1", "u:0", "k5:1"]);
});

test("Claude Code's sub-agents are rows inside their session, counted as part of it", () => {
  const now = Date.now();
  const subagents = [1, 2, 3, 4, 5, 6].map(n => ({ id: `a${n}`, type: "Explore", description: `Look at part ${n}`, background: n === 1, started: now - n * 1000 }));
  const work = new Map([["t1", { at: now, session: { status: "busy" }, goal: null, shells: [], subagents }]]);
  const rows = build(world({ terminals: [terminal("t1", "done")], work, now }));
  const inner = rows.filter(r => r.inner);
  assert.equal(inner.length, 6);
  assert.deepEqual([inner[0].address, inner[0].parent, inner[0].status, inner[0].inBackground], ["t1#a1", "t1", "working", true]);
  const parent = rows.find(r => r.address === "t1");
  assert.equal(parent.status, "working");
  assert.deepEqual(backgroundLines(parent, now).slice(-2), ["Sub-agent: Look at part 4", "+2 more"]);
  assert.deepEqual(counts(rows), { all: 1, blocked: 0, done: 0, working: 1, idle: 0, unknown: 0 });
});

test("inside a status, sessions in the same folder sit together where the first of them would be", () => {
  const rows = build(world({ terminals: [
    terminal("a1", "idle", { cwd: "/code/api/", status_ms: 400 }),
    terminal("b1", "idle", { cwd: "/code/web", status_ms: 300 }),
    terminal("a2", "idle", { cwd: "/code/api", status_ms: 200 }),
    terminal("kid", "idle", { cwd: "/code/web", parent: "a2", status_ms: 100 }),
    terminal("a3", "working", { cwd: "/code/api" }),
    terminal("none", "idle", { status_ms: 50 }),
  ] }));
  const idle = sectionize(rows.filter(r => !r.machine)).find(s => s.id === "idle");
  // A sub-agent stays with its parent, whatever its own folder; the trailing slash is the same folder.
  assert.deepEqual(idle.entries.map(e => e.row.address), ["a1", "a2", "kid", "b1", "none"]);
  assert.deepEqual(idle.folders.map(f => [f.label, f.sessions]), [["api", 2], ["web", 1], ["No folder", 1]]);
  // Another status is grouped on its own.
  assert.deepEqual(sectionize(rows.filter(r => !r.machine)).find(s => s.id === "working").folders.map(f => f.key), ["/code/api"]);
});

test("paths read from each machine's home, and rows carry their pane's branch", () => {
  assert.equal(shortPath("/Users/me/code/app"), "~/code/app");
  assert.equal(shortPath("/home/me"), "~");
  assert.equal(shortPath("/root/x"), "~/x");
  assert.equal(shortPath("/Users/me2"), "~");
  assert.equal(shortPath("/opt/Users/me"), "/opt/Users/me");
  assert.equal(shortPath(null), "");
  const rows = build(world({ panes: [{ pane: "p1", terminal: "t1", tab: "tb", cwd: "/code/app", branch: "main" }] }));
  assert.equal(rows.find(r => r.address === "t1").branch, "main");
});

test("a finished session you open stays Done until you leave it", () => {
  const rows = () => build(world({ terminals: [terminal("t1", "idle"), terminal("t2", "idle"), terminal("t3", "working")], focused: { terminal: "t1" } }));
  const before = new Map([["t1", "done"], ["t2", "done"], ["t3", "done"]]);
  const held = holdDone(rows(), before);
  // Focused and seen: still Done. Not focused, or busy again: what Herdr says.
  assert.equal(held.find(r => r.address === "t1").status, "done");
  assert.equal(held.find(r => r.address === "t2").status, "idle");
  assert.equal(holdDone(rows(), new Map([["t3", "done"]])).find(r => r.address === "t3").status, "working");
  // Never Done before: nothing to hold.
  assert.equal(holdDone(rows(), new Map()).find(r => r.address === "t1").status, "idle");
});

test("a session whose pane closed is held out until Herdr stops listing it, or LEAVE_MS passes", () => {
  const rows = () => build(world({ terminals: [terminal("t1"), terminal("t2"), terminal("t3")] })).concat({ address: "t1#a", inner: true, terminal: "t1" });
  const leaving = new Map();
  // t1 lost its pane since the last render; t3 never had one; t2 still has its pane.
  let shown = dropLeaving(rows(), leaving, new Set(["t1", "t2"]), new Set(["t2"]), 1000);
  assert.deepEqual(shown.map(r => r.address).sort(), ["t2", "t3"]); // t1's sub-agent goes with it
  assert.deepEqual([...leaving], [["t1", 1000]]);
  // Still listed, no pane, within LEAVE_MS: still out. Not marked again from an older render.
  shown = dropLeaving(rows(), leaving, new Set(["t2"]), new Set(["t2"]), 1000 + LEAVE_MS);
  assert.equal(shown.some(r => r.address === "t1"), false);
  // Gone from Herdr's lists: forgotten.
  dropLeaving(rows().filter(r => r.address !== "t1" && r.address !== "t1#a"), leaving, new Set(["t2"]), new Set(["t2"]), 1500);
  assert.equal(leaving.size, 0);
  // Still listed after LEAVE_MS (parked): back.
  leaving.set("t3", 0);
  shown = dropLeaving(rows(), leaving, new Set(), new Set(), LEAVE_MS + 1);
  assert.ok(shown.some(r => r.address === "t3"));
  assert.equal(leaving.size, 0);
});
