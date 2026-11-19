// Example sessions, for the picture in the README: the sidebar drawn by Herdr itself, with
// nothing of anyone's. `agent-sidebar.demo` opens a copy that shows these instead of the app's
// own; it asks no machine anything and changes nothing.
const claude = { key: "claude", name: "Claude Code", agent: true, icon: "icons/claude.svg", tint: false };
const codex = { key: "codex", name: "Codex", agent: true, icon: "icons/codex.svg", tint: false };
const MINUTE = 60000;

export function demo(now = Date.now()) {
  const agent = (address, status, title, minutes, extra = {}) => ({ address, state: "live", status, title, program: claude, status_ms: now - minutes * MINUTE, ...extra });
  const terminals = [
    agent("t1", "blocked", "Rotate the API signing keys", 2),
    agent("t2", "done", "Fix the flaky checkout test", 1),
    agent("t3", "working", "Upgrade the build to Node 22", 6),
    agent("t4", "working", "Add retries to the webhook client", 9),
    agent("t5", "working", "Migrate the billing schema", 14),
    agent("t6", "idle", "Tidy the logging setup", 190, { labels: { "herdr.pinned": "true" } }),
    agent("t7", "idle", "Write the release notes", 65),
    { address: "t8", state: "live", program: { name: "zsh", shell: true }, cwd: "/Users/me/code/api" },
    agent("studio/t1", "working", "Train the ranking model", 41),
    agent("studio/t2", "idle", "Profile the image pipeline", 130, { program: codex }),
    agent("attic/t1", "idle", "Index the photo archive", 600),
  ];
  const pane = (terminal, tab, cwd, branch) => ({ pane: `p-${terminal}`, terminal, tab, cwd, branch });
  const panes = [
    pane("t1", "a1", "/Users/me/code/api", "rotate-keys"), pane("t2", "w1", "/Users/me/code/web", "fix-checkout"),
    pane("t3", "w2", "/Users/me/code/build", "node-22"), pane("t4", "a2", "/Users/me/code/hooks", "webhook-retries"),
    pane("t5", "a3", "/Users/me/code/billing", "billing-v2"), pane("t6", "w3", "/Users/me/code/logging", "main"),
    pane("t7", "a4", "/Users/me/code/docs", "main"), pane("t8", "a4", "/Users/me/code/api", "main"),
    pane("studio/t1", "studio/r1", "/home/me/ranking", "main"), pane("studio/t2", "studio/r2", "/home/me/images", "main"),
  ];
  const space = (id, name, machine, tabs) => ({ id, name, machine, named: true, tabs: tabs.map(tab => ({ id: tab })) });
  const spaces = [space("s1", "api", null, ["a1", "a2", "a3", "a4"]), space("s2", "web", null, ["w1", "w2", "w3"]),
    space("studio/s1", "ranking", "studio", ["studio/r1", "studio/r2"])];
  // What the probe would have read of each session. `at` never goes stale.
  const read = (model, effort, extra = {}) => ({ at: Number.MAX_SAFE_INTEGER, session: { status: "idle" }, goal: null, shells: [], subagents: [], model, effort, context: null, activity: null, id: null, ...extra });
  const work = new Map([
    ["t1", read("claude-opus-5-5", "high", { context: 84000, activity: { tool: "AskUserQuestion", detail: "Rotate the staging keys too?" } })],
    ["t2", read("claude-sonnet-5-5", "medium", { context: 61000 })],
    ["t3", read("claude-opus-5-5", "xhigh", { context: 212000, activity: { tool: "Bash", detail: "Run the test suite" } })],
    ["t4", read("claude-fable-5-2", "high", { goal: { condition: "Every webhook test passes", check: "" }, activity: { tool: "Edit", detail: "client.js" } })],
    ["t5", read("claude-opus-5-5", "high", { session: { status: "busy" }, activity: { tool: "Agent", detail: "Check the migration on a copy" }, subagents: [
      { id: "a1", type: "general-purpose", description: "Check the migration on a copy", background: false, started: now - MINUTE },
      { id: "a2", type: "Explore", description: "Find every query on invoices", background: false, started: now - 3 * MINUTE }] })],
    ["t6", read("claude-sonnet-5-5", "medium")],
    ["t7", read("claude-haiku-5-5", "low")],
    ["studio/t1", read("claude-fable-5-2", "max", { context: 1240000, activity: { tool: "Bash", detail: "Train for 20 epochs" } })],
  ]);
  const git = new Map([[null, {
    asked: Infinity, pulled: Infinity,
    changes: new Map([["/Users/me/code/web", { files: 4, added: 42, removed: 7 }], ["/Users/me/code/logging", { files: 9, added: 310, removed: 96 }]]),
    pulls: new Map([["/Users/me/code/web", { number: 128, state: "open", url: "" }], ["/Users/me/code/docs", { number: 131, state: "merged", url: "" }]]),
  }]]);
  const shared = {
    "agent-sidebar.density": "expanded", "agent-sidebar.group": "status", "agent-sidebar.settings": {},
    "agent-sidebar.kinds": { "": "laptop", studio: "server" }, "space.colors": {},
    "agent-sidebar.closed": [{ title: "Compare two caching layers", cwd: "/Users/me/code/api", machine: null, session: "demo-1", at: now - 20 * MINUTE }],
  };
  const machines = [{ name: null, layout: "ready" }, { name: "studio", layout: "ready" }, { name: "attic", layout: "unavailable" }];
  // How busy each machine is (background.js STATS): this one at ease, the studio training hard
  // and filling its disk.
  const GB = 2 ** 30;
  const busy = (cpu, used, total, pressure, disk, size) => ({ reading: { cpu, used: used * GB, total: total * GB, pressure, disk: { used: disk * GB, total: size * GB }, at: Number.MAX_SAFE_INTEGER }, asked: Infinity, asking: false });
  const stats = new Map([[null, busy(0.18, 21.4, 32, 0.12, 412, 926)], ["studio", busy(0.86, 97, 128, 0.31, 3480, 3815)]]);
  return { machines, terminals, panes, spaces, focused: { terminal: "t5", space: "s1" }, work, git, stats, shared };
}
