// Pure presentation model. Machine identity comes from Herdr, never from a folder name.
import { STALE_MS } from "./background.js";

export const WORDS = { blocked: "Needs you", done: "Done", working: "Cooking", idle: "Idle", unknown: "No status" };
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

const hiddenLabel = terminal => ["true", "1"].includes(terminal?.labels?.["herdr.hidden"]);

export function build({ agents = [], terminals = [], panes = [], spaces = [], machines = [], focused = null, work = new Map(), now = Date.now() } = {}) {
  const hosts = new Map(machines.map(m => [m.name ?? null, m]));
  const placed = new Map(panes.filter(p => p.terminal).map(p => [p.terminal, p]));
  const listed = new Map(agents.map(a => [a.address, a]));
  const raw = new Map(terminals.map(t => [t.address, t]));
  const spaceByTab = new Map(spaces.flatMap(s => (s.tabs ?? []).map(tab => [tab.id, s])));
  const tabById = new Map(spaces.flatMap(s => (s.tabs ?? []).map(tab => [tab.id, tab])));
  const spaceById = new Map(spaces.map(s => [s.id, s]));
  const order = new Map(spaces.map((s, i) => [s.id, i]));
  const addresses = new Set([...listed.keys(), ...placed.keys(), ...terminals.filter(t => t.state === "live").map(t => t.address)]);
  const rows = [];
  for (const address of addresses) {
    const a = listed.get(address);
    const terminal = raw.get(address);
    if (terminal && terminal.state !== "live") continue;
    // A mod that runs a program for itself and shows it itself (a VPN client behind a switch)
    // marks its terminal `herdr.hidden=true`: it is nobody's session.
    if (hiddenLabel(terminal)) continue;
    const machine = machineOf(address);
    // The app excludes temporary machines from machines(). Do not leak their agents in.
    if (machine !== null && !hosts.has(machine)) continue;
    const pane = placed.get(address);
    const tab = tabById.get(a?.tab ?? pane?.tab);
    // A terminal with no pane (one an agent started) still carries its space's label.
    const label = terminal?.labels?.["herdr.space"];
    const space = spaceByTab.get(a?.tab ?? pane?.tab) ?? (label ? spaceById.get(label) ?? spaceById.get(`${machine}/${label}`) : undefined);
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
      // Which space, and where it comes in Herdr's order, for grouping by space.
      spaceId: space?.id ?? null, spaceOrder: order.get(space?.id) ?? Infinity,
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
      // What its last turn ran with, when its machine could say (background.js).
      model: null, effort: null, context: null, activity: null, session: null,
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
        program: null, space: sub.type, spaceId: row.spaceId, spaceOrder: row.spaceOrder, pane: row.pane, terminal: row.address, parent: row.address,
        cwd: row.cwd, branch: row.branch, pinned: false, focused: false, changed: sub.started, since: sub.started, seq: 0,
        available: row.available, pid: null, inBackground: sub.background,
        background: [], goal: null, shells: [], helpers: [], model: null, effort: null, context: null, activity: null, session: null,
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
    row.model = info?.model ?? null;
    row.effort = info?.effort ?? null;
    row.context = info?.context ?? null;
    row.session = info?.id ?? null;
    // What its last turn was doing says what it does now only while that turn goes on.
    row.activity = row.reported === "working" || row.reported === "blocked" ? info?.activity ?? null : null;
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

// A session on its way out. Herdr drops a closed pane at once but lists its terminal until the
// core says it ended, a moment later; in between the row has lost its pane's folder, title and
// status, and would jump to another place before it goes. So it goes at once instead.
// `leaving`: address → when it started going (its ✕ clicked here, or its pane gone since the last
// render); `placed`: the terminals that had a pane then, `now` those that have one now. A terminal
// still listed after LEAVE_MS stayed on purpose (parked) and comes back. Changes `leaving`.
export const LEAVE_MS = 2500;
// `staying`: sessions whose pane went on purpose (one being moved to another space).
export function dropLeaving(rows, leaving, placed, panes, now = Date.now(), staying = new Set()) {
  const present = new Set(rows.map(row => row.address));
  for (const address of placed) if (!panes.has(address) && present.has(address) && !leaving.has(address) && !staying.has(address)) leaving.set(address, now);
  for (const address of staying) leaving.delete(address);
  for (const [address, at] of leaving) if (!present.has(address) || now - at > LEAVE_MS) leaving.delete(address);
  return leaving.size ? rows.filter(row => !leaving.has(row.inner ? row.terminal : row.address)) : rows;
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

// Sections inside each host, in the order of Herdr's own Agents panel (by priority).
// Pins break ties inside the status sections; a pinned idle session gets its own section.
// Shells and programs follow the same rules: with nothing to report, they are idle.
export const SECTIONS = [
  { id: "blocked", label: "Needs you", status: "blocked" },
  { id: "done", label: "Done", status: "done" },
  { id: "working", label: "Cooking", status: "working" },
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
// `by`: "status" (the sections above), or "space": a section for each of Herdr's spaces, in
// Herdr's order, its sessions by urgency; one outside any space comes last.
// `spaces`: that host's spaces, so one with no session still has its heading.
export function sectionize(rows, by = "status", spaces = []) {
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
  const held = new Map(by === "space" ? spaces.map((space, i) => [`space:${space.id}`, { id: `space:${space.id}`, label: space.name || "Space", status: null, space: space.id, order: i - spaces.length, trees: [] }]) : []);
  const out = new Map(SECTIONS.map(section => [section.id, []]));
  // Roots first; anything left over (a parent cycle) is listed on its own.
  const roots = rows.filter(row => !row.parent || !listed.has(row.parent) || row.parent === row.address);
  for (const row of [...roots, ...rows]) {
    if (seen.has(row.address)) continue;
    const entries = tree(row, 0);
    // Whatever the grouping, what needs you leads: it must not wait inside a space.
    if (by !== "status" && Math.max(...entries.map((entry, i) => urgency(entry.row, i > 0))) === URGENT.blocked) {
      out.get("blocked").push(entries);
      continue;
    }
    // A project is every space of one name, on whatever machine.
    if (by === "project") {
      const name = row.spaceId ? row.space || "Space" : "No space";
      const id = `project:${row.spaceId ? name.toLowerCase() : ""}`;
      if (!held.has(id)) held.set(id, { id, label: name, status: null, project: true, order: row.spaceId ? 0 : 1, trees: [] });
      held.get(id).trees.push(entries);
      continue;
    }
    if (by === "space") {
      const id = `space:${row.spaceId ?? ""}`;
      if (!held.has(id)) held.set(id, { id, label: row.spaceId ? row.space || "Space" : "No space", status: null, space: row.spaceId, order: row.spaceOrder, trees: [] });
      held.get(id).trees.push(entries);
      continue;
    }
    const top = Math.max(...entries.map((entry, i) => urgency(entry.row, i > 0)));
    const status = Object.keys(URGENT).find(key => URGENT[key] === top) ?? row.status;
    out.get(sectionOf(row, status)).push(entries);
  }
  if (by !== "status") {
    const lead = out.get("blocked").length ? [{ ...SECTIONS[0], trees: out.get("blocked") }] : [];
    return [...lead, ...[...held.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))].map(({ trees, order, ...section }) => {
      const folders = byFolder(trees);
      return { ...section, folders, entries: folders.flatMap(folder => folder.entries) };
    });
  }
  return SECTIONS.map(section => {
    const folders = byFolder(out.get(section.id));
    return { ...section, folders, entries: folders.flatMap(folder => folder.entries) };
  }).filter(section => section.entries.length);
}

// "/Users/me/code/app" → "~/code/app", on any machine: each has its own home.
export const shortPath = path => (path ?? "").replace(/^(?:\/(?:Users|home)\/[^/]+|\/root)(?=\/|$)/, "~");
// An expanded row's second line, in `room` characters: a folder too long for it gives way from
// its start ("~/code/app" → "…/app"), so its last part and the branch stay.
export function fitWhere(path, branch, room) {
  const tail = branch ? ` · ${branch}` : "";
  if (!path) return branch ?? "";
  if (path.length + tail.length <= room) return path + tail;
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const cut = `…/${parts.slice(i).join("/")}`;
    if (cut.length + tail.length <= room || i === parts.length - 1) return cut + tail;
  }
  return path + tail;
}
export const folderKey = path => (path ?? "").replace(/(.)[\\/]+$/, "$1");

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

// Each machine's sessions. This computer first, then the machines that can be reached, by name,
// then the ones that can't: those have nothing to act on, so they wait at the end.
export function groups(rows, machines, by = "status", spaces = []) {
  const hosts = [...machines];
  if (!hosts.some(m => m.name == null)) hosts.push({ name: null, layout: "loading" });
  const rank = host => host.name == null ? 0 : host.layout === "unavailable" ? 2 : 1;
  hosts.sort((a, b) => rank(a) - rank(b) || (a.name ?? "").localeCompare(b.name ?? ""));
  // By project, the machines that answer are one list; one that is away keeps its own line.
  if (by === "project") {
    const here = new Set(hosts.filter(host => host.layout !== "unavailable" || host.name == null).map(host => host.name ?? null));
    const sections = sectionize(rows.filter(row => here.has(row.machine)), "project");
    const all = { name: null, layout: "ready", key: "all", label: "All machines", remote: false, flat: true, sections, rows: sections.flatMap(section => section.entries.map(entry => entry.row)) };
    return [all, ...hosts.filter(host => !here.has(host.name ?? null)).map(host => {
      const away = sectionize(rows.filter(row => row.machine === host.name));
      return { ...host, key: `remote:${host.name}`, label: host.name, remote: true, sections: away, rows: away.flatMap(section => section.entries.map(entry => entry.row)) };
    })];
  }
  return hosts.map(host => {
    const mine = rows.filter(row => row.machine === (host.name ?? null));
    const sections = sectionize(mine, by, spaces.filter(space => (space.machine ?? null) === (host.name ?? null)));
    return {
      ...host, key: host.name == null ? "local" : `remote:${host.name}`,
      label: host.name ?? "Local", remote: host.name != null,
      sections,
      // Display order: section by section, sub-agents under their parents.
      rows: sections.flatMap(section => section.entries.map(entry => entry.row)),
    };
  });
}

// A model id as people say it: "claude-opus-4-1-20250805" → { family: "Opus", label: "Opus 4.1" },
// "us.anthropic.claude-3-5-sonnet-20241022-v2:0" → Sonnet 3.5. Read from the id's own words, so
// a model this was never told about still gets its name. Null when there is no id.
export function modelName(id) {
  if (typeof id !== "string" || !id.trim()) return null;
  const words = id.trim().replace(/\[[^\]]*\]$/, "").replace(/^.*claude-/i, "").replace(/@.*$/, "").replace(/-v\d+(?::\d+)?$/i, "")
    .split("-").filter(word => word && word !== "latest" && !/^\d{6,}$/.test(word));
  const name = words.find(word => /^[a-z]+$/i.test(word));
  // "--model opus": an alias is the family's name already.
  const known = /claude-/i.test(id) || /^(?:fable|mythos|opus|sonnet|haiku)$/i.test(words.join("-"));
  if (!name || !known) return { family: id.trim().slice(0, 24), label: id.trim().slice(0, 24) };
  const family = name[0].toUpperCase() + name.slice(1).toLowerCase();
  const version = words.filter(word => /^\d{1,2}$/.test(word)).join(".");
  return { family, label: version ? `${family} ${version}` : family };
}

// What a session is doing ("Bash · Run the tests") or, when it needs you, what it wants
// ("Asks · Which database?", "Wants Bash · rm -rf build"). "" when its machine didn't say.
const ASKS = new Set(["AskUserQuestion", "ExitPlanMode"]);
export function activityText(row) {
  const a = row.activity;
  if (!a?.tool) return "";
  const what = ASKS.has(a.tool) ? (a.tool === "ExitPlanMode" ? "Plan ready" : "Asks") : row.status === "blocked" ? `Wants ${a.tool}` : a.tool;
  return [what, a.detail].filter(Boolean).join(" · ");
}

// "159k", "1.2M": tokens of context, as people say them.
export const tokens = n => !Number.isFinite(n) || n <= 0 ? "" : n >= 999500 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

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

// Moving a session to another space of its machine. Herdr has no command for it, but shows a
// terminal wherever its labels say: so its pane is parked (terminal.park; it keeps running),
// and then `hc` is given these arguments, which make it a new tab of that space. A space lives
// on one machine, and so does a session. A sub-agent can't move by itself: not one inside a
// session, and not a terminal an agent started, which belongs to that agent's tab.
export const movable = row => Boolean(row?.available && !row.inner && !row.parent);
export const canMove = (row, space) => Boolean(movable(row) && space && machineOf(space) === row.machine && row.spaceId !== space);
export function moveArgs(row, space, tab) {
  // Labels use the machine's own ids: without the "<machine>/" the app puts before them.
  const local = id => row.machine == null ? id : id.slice(row.machine.length + 1);
  return ["label", row.address, `herdr.space=${local(space)}`, `herdr.tab=${tab}`];
}

// Organizing with Claude: it is shown each machine's spaces and sessions (title, folder, branch,
// by short ids) and answers with the spaces it would make of them. Nothing else is sent.
export const ORGANIZE_SYSTEM = "You organize a developer's terminal sessions into named spaces, one set per machine. "
  + "Put sessions that belong to the same project together: the same repository, or closely related work. "
  + "Keep an existing space and its name when it already fits; name a new one after its project in one to three words. "
  + "Prefer a few meaningful spaces to many with one session each, but never mix unrelated projects. "
  + "Every session goes in exactly one space, on its own machine. Answer only with the structured output.";
// Strict, as Codex asks of a schema: every property required, and no others.
export const ORGANIZE_SCHEMA = { type: "object", additionalProperties: false, required: ["machines"], properties: { machines: { type: "array", items: {
  type: "object", additionalProperties: false, required: ["machine", "spaces"],
  properties: { machine: { type: "string" }, spaces: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "sessions"],
    properties: { name: { type: "string" }, sessions: { type: "array", items: { type: "string" } } } } } } } } } };

// Claude Code takes a family's name for its latest model ("sonnet"). Codex wants the model
// itself, so the latest of a family ("terra" → "gpt-6.1-terra") is looked up in the list Codex
// keeps of the models it can use (~/.codex/models_cache.json). Null when it lists none: Codex
// then uses its own default.
export function latestCodex(cache, family) {
  let models;
  try { models = JSON.parse(cache ?? "")?.models; } catch { return null; }
  const found = (Array.isArray(models) ? models : []).map(model => {
    const m = new RegExp(`^gpt-(\\d+)(?:\\.(\\d+))?-${family}$`).exec(model?.visibility === "hide" ? "" : model?.slug ?? "");
    return m && { slug: model.slug, major: Number(m[1]), minor: Number(m[2] ?? 0) };
  }).filter(Boolean).sort((a, b) => b.major - a.major || b.minor - a.minor);
  return found[0]?.slug ?? null;
}
// What either one answers: Codex its answer itself, Claude Code an envelope around it.
export function organizeAnswer(stdout) {
  try {
    const out = JSON.parse(stdout);
    return Array.isArray(out?.machines) ? out : out?.structured_output ?? JSON.parse(out.result);
  } catch { return null; }
}

// What Claude is asked, and `ids`: the short id it knows each session by → its address.
export function organizeBrief(rows, spaces) {
  const ids = new Map();
  const lines = [];
  const machines = [...new Set(rows.filter(movable).map(row => row.machine))];
  for (const machine of machines) {
    const names = spaces.filter(space => (space.machine ?? null) === machine).map(space => JSON.stringify(space.name));
    lines.push(`Machine ${JSON.stringify(machine ?? "local")}. Spaces now: ${names.join(", ") || "none"}. Sessions:`);
    for (const row of rows.filter(row => movable(row) && row.machine === machine)) {
      const id = `s${ids.size + 1}`;
      ids.set(id, row.address);
      lines.push(`- ${id}: ${JSON.stringify(row.title.slice(0, 80))}, ${row.kind === "agent" ? "agent" : "shell"}, in ${shortPath(row.cwd) || "?"}${row.branch ? ` on ${row.branch}` : ""}, space ${row.spaceId ? JSON.stringify(row.space) : "none"}`);
    }
  }
  return { prompt: `${lines.join("\n")}\n\nGroup every session into spaces.`, ids };
}

// What its answer changes: `renames` [{ id, from, to }] and `moves` [{ address, title, to, name,
// created }], `to` being a space's id. A space it names that exists (whatever the case) is that
// one; else the space most of those sessions are in already is renamed, if nothing else wants
// it; else it is a new space, with the id `newId(machine)` makes. Sessions it left out, or put
// where they are, don't move.
export function organizePlan(rows, spaces, answer, ids, newId) {
  const renames = [];
  const moves = [];
  const byAddress = new Map(rows.map(row => [row.address, row]));
  for (const group of Array.isArray(answer?.machines) ? answer.machines : []) {
    const machine = group?.machine === "local" ? null : group?.machine ?? null;
    const mine = spaces.filter(space => (space.machine ?? null) === machine);
    const wanted = (Array.isArray(group?.spaces) ? group.spaces : []).map(space => ({
      name: String(space?.name ?? "").trim().slice(0, 40),
      rows: [...new Set(Array.isArray(space?.sessions) ? space.sessions : [])].map(id => byAddress.get(ids.get(id))).filter(row => movable(row) && row.machine === machine),
    })).filter(space => space.name && space.rows.length);
    const names = new Set(wanted.map(space => space.name.toLowerCase()));
    const taken = new Set();
    const seen = new Set();
    for (const space of wanted) space.rows = space.rows.filter(row => !seen.has(row.address) && seen.add(row.address));
    // The larger groups choose first, so the space that is renamed is the one that moves least.
    for (const space of [...wanted].sort((a, b) => b.rows.length - a.rows.length)) {
      let target = mine.find(other => other.name.toLowerCase() === space.name.toLowerCase() && !taken.has(other.id));
      let created = false;
      if (!target) {
        const count = new Map();
        for (const row of space.rows) if (row.spaceId) count.set(row.spaceId, (count.get(row.spaceId) ?? 0) + 1);
        const [most] = [...count].sort((a, b) => b[1] - a[1])[0] ?? [];
        const home = mine.find(other => other.id === most && !taken.has(other.id) && !names.has(other.name.toLowerCase()));
        if (home && count.get(most) * 2 > space.rows.length) {
          renames.push({ id: home.id, from: home.name, to: space.name });
          target = home;
        } else {
          target = { id: newId(machine), name: space.name };
          created = true;
        }
      }
      taken.add(target.id);
      for (const row of space.rows) if (row.spaceId !== target.id) moves.push({ address: row.address, title: row.title, to: target.id, name: space.name, created });
    }
  }
  return { renames, moves };
}

// The list as a plan would leave it, to look at before applying: `rows` with each moved session
// in its new space, `spaces` with the renamed and the new ones, and what to mark: `moved`
// (address → the space it leaves), `created` (ids), `renamed` (id → the old name). A move in
// `skip` (addresses the person took out) stays where it is.
export function previewOf(rows, spaces, plan, skip = new Set()) {
  const renamed = new Map(plan.renames.map(rename => [rename.id, rename]));
  const moves = new Map(plan.moves.filter(move => !skip.has(move.address)).map(move => [move.address, move]));
  const created = new Map([...moves.values()].filter(move => move.created).map(move => [move.to, move]));
  const order = new Map(spaces.map((space, i) => [space.id, i]));
  const name = id => renamed.get(id)?.to ?? spaces.find(space => space.id === id)?.name ?? created.get(id)?.name ?? "";
  const moved = new Map();
  const out = rows.map(row => {
    const move = moves.get(row.address) ?? (row.inner || row.parent ? moves.get(row.parent) : null);
    if (move && !row.inner && row.address === move.address) moved.set(row.address, row.spaceId ? row.space : "no space");
    const spaceId = move ? move.to : row.spaceId;
    return spaceId === row.spaceId && !renamed.has(spaceId) ? row
      : { ...row, spaceId, space: row.inner ? row.space : name(spaceId), spaceOrder: order.get(spaceId) ?? spaces.length };
  });
  return {
    rows: out, moved, created: new Set(created.keys()), renamed: new Map([...renamed].map(([id, rename]) => [id, rename.from])),
    spaces: [...spaces.map(space => renamed.has(space.id) ? { ...space, name: renamed.get(space.id).to } : space),
      ...[...created].map(([id, move]) => ({ id, name: move.name, machine: machineOf(id), tabs: [] }))],
  };
}

// A message can be sent to an agent that is not waiting on a dialog: typed into one, it would
// answer it. Never to a shell, where it would run.
export const canReply = row => Boolean(row?.available && row.kind === "agent" && !row.inner && row.reported !== "blocked");

// How busy a machine is (background.js parseStats), beside its name: CPU, memory and disk in
// use, quiet until one runs high, then a warning (1) and worse (2) at herdr-stats' thresholds.
// Memory goes by its pressure where the machine says it (a Mac keeps most of its memory in use,
// and only the pressure says it is short), else by how much of it is used.
export const STAT_LEVELS = { cpu: [0.7, 0.9], used: [0.8, 0.92], pressure: [0.5, 0.75], disk: [0.85, 0.95] };
const statLevel = (value, [warn, crit]) => value == null ? 0 : value >= crit ? 2 : value >= warn ? 1 : 0;
const percent = x => `${Math.round(x * 100)}%`;
// 52.1 GB, 875 GB, 1.8 TB: one decimal under 100. "52.1 of 64 GB", "875 GB of 1.8 TB".
function size(n) {
  const tera = n >= 1000 * 2 ** 30;
  const v = n / 2 ** (tera ? 40 : 30);
  return [v.toFixed(v < 100 ? 1 : 0).replace(/\.0$/, ""), tera ? "TB" : "GB"];
}
function amount(used, total) {
  const [[a, unit], [b, of]] = [size(used), size(total)];
  return unit === of ? `${a} of ${b} ${of}` : `${a} ${unit} of ${b} ${of}`;
}
// [{ key: "cpu" | "memory" | "disk", text: "23%", level: 0 | 1 | 2 }], in that order: the
// order in which they give way when there is no room, from the end.
export function statFigures(r) {
  const out = [];
  if (r?.cpu != null) out.push({ key: "cpu", text: percent(r.cpu), level: statLevel(r.cpu, STAT_LEVELS.cpu) });
  if (r?.total) {
    const used = r.used / r.total;
    out.push({ key: "memory", text: percent(used), level: r.pressure != null ? statLevel(r.pressure, STAT_LEVELS.pressure) : statLevel(used, STAT_LEVELS.used) });
  }
  if (r?.disk) out.push({ key: "disk", text: percent(r.disk.used / r.disk.total), level: statLevel(r.disk.used / r.disk.total, STAT_LEVELS.disk) });
  return out;
}
// "CPU 45% · Memory 52.1 of 64 GB (81%), pressure 33% · Disk 875 GB of 1.8 TB (47%)"
export const statsText = r => [r?.cpu != null ? `CPU ${percent(r.cpu)}` : "",
  r?.total ? `Memory ${amount(r.used, r.total)} (${percent(r.used / r.total)})${r.pressure != null ? `, pressure ${percent(r.pressure)}` : ""}` : "",
  r?.disk ? `Disk ${amount(r.disk.used, r.disk.total)} (${percent(r.disk.used / r.disk.total)})` : ""]
  .filter(Boolean).join(" · ");

// The sidebar's settings, in Herdr's shared state: the person's, so every copy and layout
// follows. Density and grouping have keys of their own (a key can be bound to each).
export const DENSITY_KEY = "agent-sidebar.density";
export const GROUP_KEY = "agent-sidebar.group";
export const SETTINGS_KEY = "agent-sidebar.settings";
export const DEFAULTS = {
  folders: true, subagents: true, shells: true, away: true, stats: true,
  model: true, effort: true, effortColors: false, activity: true, context: true, changes: true, pulls: true, age: true,
  addMachine: true, closed: true, cleanup: true, cleanupDays: 1,
  organize: true, organizeWith: "claude", organizeModel: "sonnet", organizeCodex: "terra", organizeEffort: "low",
  animations: true,
};
const CHOICES = { cleanupDays: [1, 3, 7], organizeWith: ["claude", "codex"], organizeModel: ["haiku", "sonnet", "opus"],
  organizeCodex: ["auto", "luna", "terra", "sol", "astra"], organizeEffort: ["low", "medium", "high"] };
// What is saved, over the defaults: anything missing or not one of a setting's values is the default.
export function settingsOf(saved) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = saved?.[key];
    if (CHOICES[key] ? CHOICES[key].includes(value) : typeof value === "boolean") out[key] = value;
  }
  return out;
}

// Sessions with nothing to say for long enough (a day, unless `after` says otherwise), which
// Clean up closes: not the one you are in, a pinned one, or one with a goal or work running.
export const STALE_SESSION_MS = 24 * 3600 * 1000;
export function stale(rows, now = Date.now(), after = STALE_SESSION_MS) {
  return rows.filter(row => row.kind === "agent" && !row.inner && row.available && !row.pinned && !row.focused
    && !row.background.length && !row.goal && ["idle", "done", "unknown"].includes(row.status)
    && Boolean(row.since) && now - row.since > after);
}

// Claude Code sessions that ended since they were last seen, to offer again. `known`: address →
// { title, cwd, machine, session } as last seen; `live`: the addresses of live terminals;
// `ready`: the machines that answer (null: this computer). Only a terminal gone from a machine
// that answers has ended: a parked pane, a machine that is away or a reload ends nothing.
// Changes `known`.
export function ended(known, live, ready) {
  const out = [];
  for (const [address, seen] of known) {
    if (live.has(address) || !ready.has(seen.machine)) continue;
    known.delete(address);
    out.push(seen);
  }
  return out;
}
export const CLOSED_MAX = 8;
export const remember = (closed, seen, now = Date.now()) =>
  [{ ...seen, at: now }, ...(closed ?? []).filter(entry => entry.session !== seen.session)].slice(0, CLOSED_MAX);
// Reopening one: Claude Code resumes it by its id, in the folder it worked in.
export function resumeAction(entry, machines, spaces, focused) {
  if (!/^[0-9A-Za-z-]+$/.test(entry?.session ?? "")) return null;
  return newSessionAction(entry.machine ?? null, machines, spaces, focused, { run: ["claude", "--resume", entry.session] }, { folder: entry.cwd || undefined });
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
