import test from "node:test";
import assert from "node:assert/strict";
import { build, groups, counts, modelName, fitWhere, canMove, moveArgs, organizeBrief, organizePlan, latestCodex, organizeAnswer, ORGANIZE_SCHEMA, activityText, tokens, stale, ended, remember, resumeAction, canReply, openAction, newSessionAction, sectionize, duration, backgroundLines, shortPath, holdDone, dropLeaving, LEAVE_MS , statFigures, statsText } from "../mods/agent-sidebar/model.js";

const program = { key: "claude", name: "Claude Code", agent: true };
const terminal = (address, status = "idle", extra = {}) => ({ address, status, state: "live", program, title: "Fix login", ...extra });
const hosts = [{ name: "work", layout: "ready" }, { name: null, layout: "ready" }];
const world = extra => ({ machines: hosts, terminals: [terminal("t1"), terminal("work/t1", "working")], ...extra });

test("local and remote IDs stay distinct even when the terminal numbers match", () => {
  const rows = build(world());
  assert.equal(rows.length, 2);
  assert.deepEqual(groups(rows, hosts).map(g => [g.label, g.remote, g.rows[0].address]), [
    ["Local", false, "t1"], ["work", true, "work/t1"],
  ]);
});

test("a terminal its mod marked herdr.hidden stays out, also when Herdr counts it as an agent", () => {
  const rows = build(world({
    agents: [{ address: "t2", status: "idle", program }],
    terminals: [terminal("t1"), terminal("t2", "idle", { labels: { "herdr.hidden": "true" } }),
      terminal("t3", "idle", { labels: { "herdr.hidden": "false" } })],
  }));
  assert.deepEqual(rows.map(r => r.address).sort(), ["t1", "t3"]);
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
    ["Local", "ready"], ["studio", "loading"], ["zeta", "ready"], ["away", "unavailable"], ["work", "unavailable"],
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
    ["blocked", "Needs you", undefined, ["t2"]], // what needs you leads, whatever its space
    ["space:s2", "Billing", "s2", ["t3", "t6"]],
    ["space:s1", "API", "s1", ["t1", "t5"]], // a sub-agent stays under its session
    ["space:", "No space", null, ["t4"]],
  ]);
  // Given the machine's spaces, one with no session (or none left outside Needs you) keeps its heading.
  const all = [...spaces, { id: "s3", name: "Empty" }, { id: "work/s9", name: "Elsewhere", machine: "work" }];
  assert.deepEqual(groups(rows, [{ name: null, layout: "ready" }], "space", all)[0].sections.map(s => [s.label, s.entries.length]),
    [["Needs you", 1], ["Billing", 2], ["API", 2], ["Empty", 0], ["No space", 1]]);
  // A session moves to another space of its own machine, by its labels, in that machine's ids.
  const row = address => rows.find(r => r.address === address);
  assert.deepEqual([canMove(row("t1"), "s2"), canMove(row("t1"), "s1"), canMove(row("t1"), "work/s9"), canMove(row("t4"), "s1"), canMove(null, "s1")], [true, false, false, true, false]);
  assert.deepEqual(moveArgs(row("t1"), "s2", "tbnew"), ["label", "t1", "herdr.space=s2", "herdr.tab=tbnew"]);
  assert.deepEqual(moveArgs({ address: "work/t7", machine: "work" }, "work/s9", "tbnew"), ["label", "work/t7", "herdr.space=s9", "herdr.tab=tbnew"]);
  // By status is unchanged.
  assert.deepEqual(sectionize(rows).map(s => s.id), ["blocked", "working", "idle"]);
});

test("a click focuses a pane using its exact machine-qualified ID or peeks an outside agent", () => {
  const rows = build(world({ panes: [{ terminal: "work/t1", pane: "work/p9" }] }));
  assert.deepEqual(openAction(rows.find(r => r.machine)), { name: "pane.focus", args: { pane: "work/p9" } });
  assert.deepEqual(openAction(rows.find(r => !r.machine)), { name: "terminal.peek", args: { terminal: "t1" } });
});

test("empty startup still shows local loading; duplicate task names do not merge agents", () => {
  assert.deepEqual(groups([], []).map(g => [g.label, g.layout]), [["Local", "loading"]]);
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

test("Codex runs a session started show as its sub-agents, with Codex's icon", () => {
  const now = Date.now();
  const codex = [{ id: "codex-903", title: "Codex run: review", model: "gpt-6.2-astra", effort: "high", started: now - 5000 }];
  const work = new Map([["t1", { at: now, session: { status: "shell" }, goal: null, shells: [], subagents: [], codex }]]);
  const rows = build(world({ terminals: [terminal("t1", "done")], work, now }));
  const run = rows.find(r => r.inner);
  assert.deepEqual([run.address, run.parent, run.title, run.program.key, run.program.icon, run.model, run.effort],
    ["t1#codex-903", "t1", "Codex run: review", "codex", "icons/codex.svg", "gpt-6.2-astra", "high"]);
  assert.equal(rows.find(r => r.address === "t1").status, "working");
});

test("a line from further up runs on past a sub-agent's own sub-agents to its next sibling", () => {
  const rows = build(world({ terminals: [
    terminal("p", "working"),
    terminal("k1", "working", { parent: "p" }),
    terminal("g1", "working", { parent: "k1" }),
    terminal("k2", "working", { parent: "p" }),
  ] }));
  const working = sectionize(rows.filter(r => !r.machine)).find(s => s.id === "working");
  assert.deepEqual(working.entries.map(e => [e.row.address, e.depth, e.last, e.rails]),
    [["p", 0, false, []], ["k1", 1, false, []], ["g1", 2, true, [1]], ["k2", 1, true, []]]);
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

test("Claude is shown each machine's spaces and sessions by short ids; its answer becomes renames and moves", () => {
  const spaces = [{ id: "s1", name: "Claude Code", machine: null, tabs: [{ id: "a1" }] }, { id: "s2", name: "api", machine: null, tabs: [{ id: "b1" }] }, { id: "work/s9", name: "Remote", machine: "work", tabs: [{ id: "work/r1" }] }];
  const terminals = [terminal("t1", "idle", { title: "Fix login" }), terminal("t2", "idle", { title: "Add retries" }), terminal("t3", "idle", { title: "Watchface colors" }),
    terminal("t4", "idle", { title: "Tune the bezel" }), terminal("work/t1", "idle", { title: "Deploy" })];
  const panes = [{ terminal: "t1", pane: "p1", tab: "a1", cwd: "/Users/me/code/api", branch: "main" }, { terminal: "t2", pane: "p2", tab: "b1", cwd: "/Users/me/code/api" },
    { terminal: "t3", pane: "p3", tab: "a1", cwd: "/Users/me/garmin" }, { terminal: "t4", pane: "p4", tab: "a1", cwd: "/Users/me/garmin" }, { terminal: "work/t1", pane: "work/p1", tab: "work/r1" }];
  const rows = build(world({ terminals, panes, spaces }));
  const { prompt, ids } = organizeBrief(rows, spaces);
  assert.match(prompt, /Machine "local"\. Spaces now: "Claude Code", "api"\. Sessions:/);
  assert.match(prompt, /- s\d: "Fix login", agent, in ~\/code\/api on main, space "Claude Code"/);
  assert.match(prompt, /Machine "work"\. Spaces now: "Remote"/);
  const id = address => [...ids].find(([, a]) => a === address)[0];
  let made = 0;
  const plan = organizePlan(rows, spaces, { machines: [
    { machine: "local", spaces: [{ name: "API", sessions: [id("t1"), id("t2"), "s99"] }, { name: "Garmin", sessions: [id("t3"), id("t4"), id("work/t1")] }] },
    { machine: "work", spaces: [{ name: "Remote", sessions: [id("work/t1")] }] },
  ] }, ids, machine => `${machine ? `${machine}/` : ""}spnew${++made}`);
  // "API" is the space "api"; most of Garmin's sessions are in "Claude Code", which nothing else
  // wants, so that is renamed; another machine's session and an unknown id are left out.
  assert.deepEqual(plan.renames, [{ id: "s1", from: "Claude Code", to: "Garmin" }]);
  assert.deepEqual(plan.moves, [{ address: "t1", title: "Fix login", to: "s2", name: "API", created: false }]);
  // A space that fits nothing there is new; an answer that makes no sense changes nothing.
  const fresh = organizePlan(rows, spaces, { machines: [{ machine: "local", spaces: [{ name: "Watch", sessions: [id("t3")] }, { name: "Rest", sessions: [id("t1"), id("t4")] }] }] }, ids, () => "spnew");
  assert.deepEqual(fresh.moves.map(move => [move.address, move.to, move.created]), [["t3", "spnew", true]]);
  assert.deepEqual(fresh.renames, [{ id: "s1", from: "Claude Code", to: "Rest" }]);
  for (const junk of [null, {}, { machines: "x" }, { machines: [{ machine: "local" }, { spaces: [{ name: "", sessions: [id("t1")] }] }] }]) {
    assert.deepEqual(organizePlan(rows, spaces, junk, ids, () => "spnew"), { renames: [], moves: [] });
  }
});

test("small sayings: what a session does or wants, tokens, who can be written to, what is stale, what ended", () => {
  const row = (status, activity) => ({ status, activity });
  assert.equal(activityText(row("working", { tool: "Bash", detail: "Run the tests" })), "Bash · Run the tests");
  assert.equal(activityText(row("blocked", { tool: "Bash", detail: "rm -rf build" })), "Wants Bash · rm -rf build");
  assert.equal(activityText(row("blocked", { tool: "AskUserQuestion", detail: "Which one?" })), "Asks · Which one?");
  assert.equal(activityText(row("blocked", { tool: "ExitPlanMode", detail: "" })), "Plan ready");
  assert.equal(activityText(row("working", null)), "");
  assert.deepEqual([0, 950, 1000, 159200, 999600, 1240000, NaN].map(tokens), ["", "950", "1k", "159k", "1.0M", "1.2M", ""]);
  const agent = extra => ({ available: true, kind: "agent", reported: "idle", ...extra });
  assert.deepEqual([agent(), agent({ reported: "blocked" }), agent({ kind: "shell" }), agent({ inner: true }), agent({ available: false }), null].map(canReply), [true, false, false, false, false, false]);
  const known = new Map([["t1", { machine: null, session: "a" }], ["work/t1", { machine: "work", session: "b" }], ["t2", { machine: null, session: "c" }]]);
  assert.deepEqual(ended(known, new Set(["t2"]), new Set([null])).map(seen => seen.session), ["a"]); // "work" doesn't answer: unknown
  assert.deepEqual([...known.keys()], ["work/t1", "t2"]);
  const list = Array.from({ length: 9 }, (_, i) => ({ session: `s${i}` })).reduce((closed, seen, i) => remember(closed, seen, i), []);
  assert.deepEqual([list.length, list[0].session, remember(list, { session: "s5" }, 99)[0].at, remember(list, { session: "s5" }, 99).length], [8, "s8", 99, 8]);
  const machines = [{ name: null, layout: "ready" }];
  assert.deepEqual(resumeAction({ session: "abc-1", cwd: "/w", machine: null }, machines, [{ id: "s1", machine: null, active: true }], null),
    { name: "tab.new", args: { name: undefined, argv: ["claude", "--resume", "abc-1"], folder: "/w", space: "s1" } });
  assert.equal(resumeAction({ session: "x; rm", machine: null }, machines, [], null), null);
});

test("Codex is given the latest model of a family, from its own list; either one's answer is read", () => {
  const cache = JSON.stringify({ models: [{ slug: "gpt-6.2-sol", visibility: "list" }, { slug: "gpt-6.1-terra", visibility: "list" }, { slug: "gpt-5.6-terra", visibility: "list" },
    { slug: "gpt-10-terra", visibility: "list" }, { slug: "gpt-11-terra", visibility: "hide" }, { slug: "gpt-6-luna", visibility: "list" }, { slug: "gpt-6.1-terra-preview" }, { slug: "codex-auto-review" }] });
  assert.deepEqual(["terra", "sol", "luna", "astra"].map(family => latestCodex(cache, family)), ["gpt-10-terra", "gpt-6.2-sol", "gpt-6-luna", null]);
  assert.deepEqual([latestCodex("not json", "terra"), latestCodex(null, "terra"), latestCodex("{}", "terra")], [null, null, null]);
  const answer = { machines: [{ machine: "local", spaces: [] }] };
  assert.deepEqual(organizeAnswer(JSON.stringify(answer)), answer); // Codex: the answer itself
  assert.deepEqual(organizeAnswer(JSON.stringify({ structured_output: answer, result: "" })), answer); // Claude Code: in an envelope
  assert.deepEqual(organizeAnswer(JSON.stringify({ result: JSON.stringify(answer) })), answer);
  assert.deepEqual([organizeAnswer(""), organizeAnswer("{}"), organizeAnswer("sorry")], [null, null, null]);
  // Strict, as Codex asks: every object closed, every property required.
  const closed = schema => schema.type !== "object" ? (schema.items ? closed(schema.items) : true)
    : schema.additionalProperties === false && Object.keys(schema.properties).every(key => schema.required.includes(key) && closed(schema.properties[key]));
  assert.ok(closed(ORGANIZE_SCHEMA));
});

test("a machine's figures are quiet until one runs high; memory goes by its pressure where it has one", () => {
  const GB = 2 ** 30;
  const said = r => statFigures(r).map(f => `${f.key} ${f.text} ${f.level}`);
  assert.deepEqual(said({ cpu: 0.234, used: 52 * GB, total: 64 * GB, pressure: 0.3 }), ["cpu 23% 0", "memory 81% 0"]); // a Mac, mostly in use, not short
  assert.deepEqual(said({ cpu: 0.7, used: 20 * GB, total: 32 * GB, pressure: 0.52 }), ["cpu 70% 1", "memory 63% 1"]);
  assert.deepEqual(said({ cpu: 0.95, used: 30 * GB, total: 32 * GB, pressure: 0.8 }), ["cpu 95% 2", "memory 94% 2"]);
  // No pressure (Linux): how much is used decides.
  assert.deepEqual(said({ cpu: null, used: 26 * GB, total: 32 * GB, pressure: null }), ["memory 81% 1"]);
  assert.deepEqual(said({ cpu: 0.1, used: null, total: null, pressure: null }), ["cpu 10% 0"]);
  assert.deepEqual([statFigures(null), statsText(null)], [[], ""]);
  assert.equal(statsText({ cpu: 0.45, used: 52.1 * GB, total: 64 * GB, pressure: 0.33 }), "CPU 45% · Memory 52.1 of 64 GB (81%), pressure 33%");
  assert.equal(statsText({ cpu: null, used: 97 * GB, total: 128 * GB, pressure: null }), "Memory 97 of 128 GB (76%)");
  assert.equal(statsText({ cpu: 0.05, used: 0.6 * GB, total: 1 * GB, pressure: null }), "CPU 5% · Memory 0.6 of 1 GB (60%)");
  // The disk, full at 85% and 95%, in TB once there are a thousand GB.
  const disk = (used, total) => ({ cpu: null, used: null, total: null, pressure: null, disk: { used: used * GB, total: total * GB } });
  assert.deepEqual([said(disk(412, 926)), said(disk(421, 494)), said(disk(3700, 3815))], [["disk 44% 0"], ["disk 85% 1"], ["disk 97% 2"]]);
  assert.deepEqual(said({ cpu: 0.2, used: 1, total: 2, pressure: null, disk: { used: 1, total: 4 } }).map(f => f.split(" ")[0]), ["cpu", "memory", "disk"]);
  assert.equal(statsText(disk(875.2, 1858.1)), "Disk 875 GB of 1.8 TB (47%)");
  assert.equal(statsText(disk(3480, 3815)), "Disk 3.4 of 3.7 TB (91%)");
});
