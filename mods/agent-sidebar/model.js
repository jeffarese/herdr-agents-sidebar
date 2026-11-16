// Pure presentation model. Machine identity comes from Herdr, never from a folder name.
import { STALE_MS } from "./background.js";

export const WORDS = { blocked: "Needs you", done: "Done", working: "Working", idle: "Idle", unknown: "No status" };
const PRIORITY = { blocked: 60, done: 50, working: 40 };
export const machineOf = address => address?.includes("/") ? address.slice(0, address.indexOf("/")) : null;
const statusOf = status => status === "error" ? "blocked" : Object.hasOwn(WORDS, status) ? status : "unknown";
const clean = text => (text ?? "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();
const basename = path => path?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
// Shells and programs sort with agents: by status, then pins, then what changed last.
const priority = row => PRIORITY[row.status] ?? (row.pinned ? 30 : 20);
function taskTitle(value, program, address) {
  const title = clean(value);
  if (!title || /^[~/]|^[A-Za-z]:[\\/]/.test(title) || /^\d+$/.test(title)) return "";
  if ([program?.name, program?.key, address].some(s => s?.toLowerCase() === title.toLowerCase())) return "";
  return title;
}

// Statuses that say the agent's turn is over. Work it left running keeps it out of them.
const RESTING = new Set(["done", "idle", "unknown"]);
// Why an agent whose turn ended still counts as working, most concrete first.
export const BACKGROUND = {
  shell: "Background shell",
  agents: "Sub-agents running",
  goal: "Goal active",
};

export function build({ agents = [], terminals = [], panes = [], spaces = [], machines = [], focused = null, work = new Map(), now = Date.now() } = {}) {
  const hosts = new Map(machines.map(m => [m.name ?? null, m]));
  const placed = new Map(panes.filter(p => p.terminal).map(p => [p.terminal, p]));
  const listed = new Map(agents.map(a => [a.address, a]));
  const raw = new Map(terminals.map(t => [t.address, t]));
  const spaceByTab = new Map(spaces.flatMap(s => (s.tabs ?? []).map(tab => [tab.id, s])));
  const tabById = new Map(spaces.flatMap(s => (s.tabs ?? []).map(tab => [tab.id, tab])));
  const addresses = new Set([...listed.keys(), ...placed.keys(), ...terminals.filter(t => t.state === "live").map(t => t.address)]);
  const rows = [];
  for (const address of addresses) {
    const a = listed.get(address);
    const terminal = raw.get(address);
    if (terminal && terminal.state !== "live") continue;
    const machine = machineOf(address);
    // The app excludes temporary machines from machines(). Do not leak their agents in.
    if (machine !== null && !hosts.has(machine)) continue;
    const pane = placed.get(address);
    const tab = tabById.get(a?.tab ?? pane?.tab);
    const space = spaceByTab.get(a?.tab ?? pane?.tab);
    const program = terminal?.program ?? pane?.program ?? a?.program;
    const agent = !program?.shell && Boolean(a || program?.agent || terminal?.status || pane?.status);
    const kind = agent ? "agent" : program?.shell || !program ? "shell" : "process";
    const cwd = pane?.cwd ?? terminal?.foreground?.cwd ?? terminal?.cwd ?? "";
    const status = statusOf(a?.status ?? terminal?.status ?? pane?.status ?? (agent ? null : "idle"));
    const named = terminal?.name || (tab?.named && taskTitle(tab.name, program, address));
    const title = (!agent && named) || taskTitle(a?.title ?? pane?.title, program, address)
      || taskTitle(terminal?.report?.title ?? terminal?.title, program, address)
      || named || (agent ? a?.space_name || space?.name || program?.name || address
        : [program?.name || "Shell", basename(cwd)].filter(Boolean).join(" · "));
    rows.push({
      address, machine, title, status, program, kind,
      space: a?.space_name ?? space?.name ?? "",
      pane: a?.pane ?? pane?.pane ?? null,
      parent: terminal?.parent ?? null,
      cwd,
      branch: pane?.branch ?? null,
      pinned: Boolean(a?.pinned || terminal?.labels?.["herdr.pinned"]),
      focused: Boolean(a?.focused || focused?.terminal === address || focused?.shown === address),
      changed: terminal?.status_ms ?? terminal?.created_ms ?? 0,
      // When the current status began; shown as "4m" on agent rows. Null when unknown.
      since: terminal?.status_ms ?? terminal?.created_ms ?? null,
      seq: a?.seq ?? 0,
      available: hosts.get(machine)?.layout === "ready",
      // The process running in it now (an agent, or a wrapper that started one), for the probe.
      pid: terminal?.foreground?.pid ?? null,
      // Herdr's word, before background work is counted.
      reported: status,
      background: [], goal: null, shells: [], helpers: [],
    });
  }
  const fresh = address => {
    const info = work.get(address);
    return info && now - info.at <= STALE_MS ? info : null;
  };
  addSubagents(rows, fresh);
  holdBackground(rows, fresh);
  // Task titles can repeat, especially when multiple panes share a project. Keep each address.
  return rows.sort((a, b) => priority(b) - priority(a)
    || Number(b.pinned) - Number(a.pinned) || b.changed - a.changed || b.seq - a.seq
    || a.address.localeCompare(b.address, undefined, { numeric: true }));
}

// Claude Code's own sub-agents run inside its process, not in terminals: each running one
// becomes a row under its session. It can't be pinned or opened by itself; opening it opens
// the session. Its address is the session's plus "#" and the sub-agent's id.
function addSubagents(rows, fresh) {
  for (const row of rows.slice()) {
    if (row.kind !== "agent") continue;
    for (const sub of fresh(row.address)?.subagents ?? []) {
      rows.push({
        address: `${row.address}#${sub.id}`, machine: row.machine, kind: "agent", inner: true,
        title: sub.description || sub.type || "Sub-agent", status: "working", reported: "working",
        program: null, space: sub.type, pane: row.pane, terminal: row.address, parent: row.address,
        cwd: row.cwd, branch: row.branch, pinned: false, focused: false, changed: sub.started, since: sub.started, seq: 0,
        available: row.available, pid: null, inBackground: sub.background,
        background: [], goal: null, shells: [], helpers: [],
      });
    }
  }
}

// An agent whose turn ended (done or idle in Herdr) still counts as working while it waits
// on something it started: a background shell or monitor, sub-agents or workflows (Claude
// Code's session file says "shell" or "busy"), a program or sub-agent in a terminal it
// started, or an open /goal. `fresh`: address → what the probe read (background.js), if recent.
function holdBackground(rows, fresh) {
  for (const row of rows) {
    if (row.kind !== "agent" || row.inner) continue;
    const info = fresh(row.address);
    row.goal = info?.goal ?? null;
    if (!RESTING.has(row.reported)) continue;
    row.shells = info?.shells ?? [];
    const session = info?.session?.status;
    row.background = [
      (row.shells.length || session === "shell") && "shell",
      session === "busy" && "agents",
      row.goal && "goal",
    ].filter(Boolean);
  }
  // Terminals an agent started (hc run) and its own sub-agents: a program still running, or a
  // sub-agent still working, keeps it working too. Two rounds reach a grandchild.
  const kids = new Map();
  for (const row of rows) {
    if (!row.parent || row.parent === row.address) continue;
    if (!kids.has(row.parent)) kids.set(row.parent, []);
    kids.get(row.parent).push(row);
  }
  for (let round = 0; round < 2; round++) {
    for (const row of rows) {
      if (row.kind !== "agent" || row.inner || !RESTING.has(row.reported)) continue;
      row.helpers = (kids.get(row.address) ?? []).filter(kid => kid.kind === "process"
        || kid.kind === "agent" && (kid.reported === "working" || kid.background.length));
      const kinds = new Set(row.helpers.map(kid => kid.kind === "process" ? "shell" : "agents"));
      row.background = Object.keys(BACKGROUND).filter(reason => row.background.includes(reason) || kinds.has(reason));
    }
  }
  for (const row of rows) if (row.background.length) row.status = "working";
}

// Opening a finished session tells Herdr you've seen it, and it turns idle at once. Here it stays
// Done while you're in it, and turns idle once you leave. `before`: address → the status each
// row was shown with last time. Changes `rows` in place.
export function holdDone(rows, before) {
  for (const row of rows) {
    if (!row.inner && row.focused && before.get(row.address) === "done" && (row.status === "idle" || row.status === "unknown")) row.status = "done";
  }
  return rows;
}

// The tooltip's account of background work, one line each.
export function backgroundLines(row, now = Date.now()) {
  const cut = (text, n) => text.length > n ? `${text.slice(0, n - 1)}…` : text;
  const lines = row.shells.slice(0, 3).map(shell => `Shell: ${cut(shell.text, 60)} · ${duration(now - shell.started)}`);
  if (row.shells.length > 3) lines.push(`+${row.shells.length - 3} more shells`);
  if (row.background.includes("shell") && !row.shells.length && !row.helpers.some(kid => kid.kind === "process")) lines.push("A background shell is running");
  for (const kid of row.helpers.slice(0, 4)) {
    lines.push(kid.inner ? `Sub-agent: ${cut(kid.title, 60)}` : `${kid.kind === "process" ? "Running" : "Sub-agent"} in ${kid.address}: ${cut(kid.title, 50)}`);
  }
  if (row.helpers.length > 4) lines.push(`+${row.helpers.length - 4} more`);
  if (row.background.includes("agents") && !row.helpers.some(kid => kid.kind === "agent")) lines.push("Sub-agents or workflows are running");
  if (row.goal) {
    lines.push(`Goal: ${cut(row.goal.condition, 120)}`);
    if (row.goal.check) lines.push(`Last check: ${cut(row.goal.check, 120)}`);
  }
  return lines;
}

export function matches(row, query, filter = "all") {
  if (filter !== "all" && row.status !== filter) return false;
  const text = [row.title, row.space, row.program?.name, row.kind, "terminal session", row.machine ?? "local this computer", row.machine ? "remote" : "", row.address, row.cwd, WORDS[row.status],
    row.background.length ? "background" : "", row.goal ? `goal ${row.goal.condition}` : "", row.inner ? "sub-agent subagent" : "",
    ...row.shells.map(shell => shell.text)].join(" ").toLowerCase();
  return query.toLowerCase().trim().split(/\s+/).every(word => text.includes(word));
}

// Sections inside each host, in the order of Herdr's own Agents panel (by priority).
// Pins break ties inside the status sections; a pinned idle session gets its own section.
// Shells and programs follow the same rules: with nothing to report, they are idle.
export const SECTIONS = [
  { id: "blocked", label: "Needs you", status: "blocked" },
  { id: "done", label: "Done", status: "done" },
  { id: "working", label: "Working", status: "working" },
  { id: "pinned", label: "Pinned", status: null },
  { id: "idle", label: "Idle", status: null },
];
const URGENT = { blocked: 3, done: 2, working: 1 };
// A sub-agent reports to its parent: its "done" is the parent's news, not the user's.
const urgency = (row, nested) => URGENT[nested && row.status === "done" ? "idle" : row.status] ?? 0;

export function sectionOf(row, status = row.status) {
  if (URGENT[status]) return status;
  return row.pinned ? "pinned" : "idle";
}

// Rows of one host as sections of {row, depth} entries. Sub-agents sit under their parent
// when the parent is listed too, and lift the parent into their most urgent section.
export function sectionize(rows) {
  const listed = new Set(rows.map(row => row.address));
  const kids = new Map();
  for (const row of rows) {
    if (!row.parent || !listed.has(row.parent) || row.parent === row.address) continue;
    if (!kids.has(row.parent)) kids.set(row.parent, []);
    kids.get(row.parent).push(row);
  }
  const seen = new Set();
  const tree = (row, depth) => {
    if (seen.has(row.address)) return [];
    seen.add(row.address);
    return [{ row, depth }, ...(kids.get(row.address) ?? []).flatMap(kid => tree(kid, depth + 1))];
  };
  // Each section holds trees (a session and its sub-agents), in priority order.
  const out = new Map(SECTIONS.map(section => [section.id, []]));
  // Roots first; anything left over (a parent cycle) is listed on its own.
  const roots = rows.filter(row => !row.parent || !listed.has(row.parent) || row.parent === row.address);
  for (const row of [...roots, ...rows]) {
    if (seen.has(row.address)) continue;
    const entries = tree(row, 0);
    const top = Math.max(...entries.map((entry, i) => urgency(entry.row, i > 0)));
    const status = Object.keys(URGENT).find(key => URGENT[key] === top) ?? row.status;
    out.get(sectionOf(row, status)).push(entries);
  }
  return SECTIONS.map(section => {
    const folders = byFolder(out.get(section.id));
    return { ...section, folders, entries: folders.flatMap(folder => folder.entries) };
  }).filter(section => section.entries.length);
}

// "/Users/me/code/app" → "~/code/app", on any machine: each has its own home.
export const shortPath = path => (path ?? "").replace(/^(?:\/(?:Users|home)\/[^/]+|\/root)(?=\/|$)/, "~");
const folderKey = path => (path ?? "").replace(/(.)[\\/]+$/, "$1");

// The sessions of one section, by the folder they work in: a folder's sessions sit together
// where its first (most urgent) one would be. `sessions`: how many, each with what it started.
function byFolder(trees) {
  const folders = new Map();
  for (const entries of trees) {
    const key = folderKey(entries[0].row.cwd);
    if (!folders.has(key)) folders.set(key, { key, path: key, label: shortPath(key) === "~" ? "~" : basename(key) || "No folder", entries: [], sessions: 0 });
    const folder = folders.get(key);
    folder.entries.push(...entries);
    folder.sessions++;
  }
  return [...folders.values()];
}

export function groups(rows, machines, query = "", filter = "all") {
  const filtered = rows.filter(row => matches(row, query, filter));
  const hosts = [...machines];
  if (!hosts.some(m => m.name == null)) hosts.push({ name: null, layout: "loading" });
  hosts.sort((a, b) => a.name == null ? (b.name == null ? 0 : -1) : b.name == null ? 1 : a.name.localeCompare(b.name));
  return hosts.map(host => {
    const mine = filtered.filter(row => row.machine === (host.name ?? null));
    const sections = sectionize(mine);
    return {
      ...host, key: host.name == null ? "local" : `remote:${host.name}`,
      label: host.name ?? "This computer", remote: host.name != null,
      sections,
      // Display order: section by section, sub-agents under their parents.
      rows: sections.flatMap(section => section.entries.map(entry => entry.row)),
    };
  }).filter(group => !query.trim() && filter === "all" || group.rows.length);
}

// Compact age, as Herdr's Agents panel shows it: <1m, 4m, 2h, 3d.
export function duration(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Sessions by status. A sub-agent inside a session is part of it, not a session of its own.
export function counts(rows) {
  const out = { all: 0, blocked: 0, done: 0, working: 0, idle: 0, unknown: 0 };
  for (const row of rows) {
    if (row.inner) continue;
    out.all++;
    out[row.status]++;
  }
  return out;
}

export function openAction(row) {
  if (!row?.available) return null;
  return row.pane ? { name: "pane.focus", args: { pane: row.pane } }
    : { name: "terminal.peek", args: { terminal: row.terminal ?? row.address } };
}

// Closing a session: its pane (as ⌘W does), or its terminal when it has none. A sub-agent
// inside a session can't be closed by itself.
export function closeAction(row) {
  if (!row?.available || row.inner) return null;
  return row.pane ? { name: "pane.close", args: { pane: row.pane } } : { name: "terminal.kill", args: { terminal: row.address } };
}

// Never use the active host implicitly: a local + must stay local while a remote tab is focused.
// `folder`: where it starts (omitted: where the space's focused pane is, or the machine's home).
// `space`: the space it joins as a tab, null for a new space; omitted, the focused space on
// that machine, else its active or first one.
export function newSessionAction(machine, machines, spaces, focused, program = null, { folder, space: target } = {}) {
  if (!machines.some(host => (host.name ?? null) === machine && host.layout === "ready")) return null;
  const candidates = spaces.filter(space => (space.machine ?? null) === machine);
  const space = target !== undefined ? candidates.find(space => space.id === target)
    : candidates.find(space => space.id === focused?.space) ?? candidates.find(space => space.active) ?? candidates[0];
  const args = { ...(program ? { name: program.name, argv: program.run } : {}), ...(folder ? { folder } : {}) };
  return space ? { name: "tab.new", args: { ...args, space: space.id } }
    : { name: "space.new", args: { ...args, machine: machine ?? "" } };
}
