// The folders the launcher offers on one machine, and where a session started there opens.
// Pure: it imports nothing from the app, so Node can test it.

// Shared keys, each an object keyed by machine ("" for this computer).
export const RECENT_KEY = "agent-sidebar.recent"; // folders sessions were started in, newest first
export const LAST_KEY = "agent-sidebar.last"; // the program last started: "shell" or a program key
export const SCAN_KEY = "agent-sidebar.scan"; // { home, folders, at }: what SCAN found
export const AGENTS_KEY = "agent-sidebar.agents"; // the last knownAgents() answer
const RECENT_MAX = 12;
// A machine's projects are looked for again after this long.
export const SCAN_MS = 10 * 60 * 1000;

export const machineKey = machine => machine ?? "";

const trim = path => path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
export const basename = path => path === "/" ? "/" : trim(path).split(/[\\/]/).pop();

// "~/workspace/api" for display; the absolute path is what gets started.
export function tilde(path, home) {
  if (!home || !path) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function expand(path, home) {
  if (!home) return path;
  if (path === "~") return home;
  return path.startsWith("~/") ? home + path.slice(1) : path;
}

// Prints the machine's home, then the folders people keep projects in: each folder one level
// under a usual projects folder, and each Git repository one level under those. Changes nothing.
export const SCAN = `printf '%s\\n' "$HOME"
for d in "$HOME/workspace" "$HOME/Workspace" "$HOME/code" "$HOME/Code" "$HOME/src" "$HOME/projects" \\
  "$HOME/Projects" "$HOME/dev" "$HOME/Developer" "$HOME/git" "$HOME/repos" "$HOME/work" "$HOME/github"; do
  [ -d "$d" ] || continue
  for f in "$d"/*/; do
    [ -d "$f" ] || continue
    f=\${f%/}
    printf '%s\\n' "$f"
    for r in "$f"/*/.git; do [ -e "$r" ] && printf '%s\\n' "\${r%/.git}"; done
  done
done 2>/dev/null | head -n 400`;

// Lists the folders inside $1 (~ allowed): the home, the folder itself, then one name a line,
// hidden ones last. Exits 3 when $1 is not a folder.
export const LIST = `d=$1
case $d in "~") d=$HOME ;; "~/"*) d=$HOME/\${d#??} ;; esac
[ -d "$d" ] || exit 3
printf '%s\\n%s\\n' "$HOME" "$d"
cd "$d" 2>/dev/null || exit 3
for f in * .[!.]* ..?*; do [ -d "$f" ] && printf '%s\\n' "$f"; done 2>/dev/null | head -n 300`;

export function parseScan(stdout) {
  const [home = "", ...lines] = stdout.split("\n");
  const seen = new Set();
  const folders = [];
  for (const line of lines) {
    const path = trim(line.trim());
    // Case-insensitive file systems answer both ~/code and ~/Code.
    if (!path || seen.has(path.toLowerCase())) continue;
    seen.add(path.toLowerCase());
    folders.push(path);
  }
  return { home: home.trim() || null, folders };
}

export function parseList(stdout) {
  const [home = "", dir = "", ...names] = stdout.split("\n");
  return { home: home.trim() || null, dir: trim(dir.trim()), names: names.filter(Boolean) };
}

// A typed path: the folder to list and the start of the name in it, or null for a search.
export function pathQuery(query) {
  const q = query.trim();
  if (q === "~") return { dir: "~", leaf: "" };
  if (!/^(~\/|\/)/.test(q)) return null;
  const cut = q.lastIndexOf("/");
  return { dir: q.slice(0, cut) || "/", leaf: q.slice(cut + 1) };
}

const join = (dir, name) => dir === "/" ? `/${name}` : `${dir}/${name}`;
const add = (out, seen, path, tag, group) => {
  if (path == null || path === "") return;
  const key = trim(path);
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ path: key, tag, group });
};

// Every folder the launcher knows on this machine, most relevant first, each once:
// `chosen` ({ path, tag }: picked in the system's picker, or a session's), the focused terminal's, the spaces' terminals' and
// their start folders, recent starts, the home folder, then projects found by SCAN.
export function knownFolders({ machine = null, chosen = null, focused = null, spaces = [], panes = [], recent = [], scanned = [], home = null }) {
  const out = [];
  const seen = new Set();
  const mine = spaces.filter(space => (space.machine ?? null) === machine);
  const spaceOfTab = new Map(mine.flatMap(space => (space.tabs ?? []).map(tab => [tab.id, space])));
  add(out, seen, chosen?.path, chosen?.tag ?? "Picked", "open");
  if (mine.some(space => space.id === focused?.space)) add(out, seen, focused?.cwd, "Current", "open");
  for (const space of mine) {
    for (const pane of panes) if (spaceOfTab.get(pane.tab) === space) add(out, seen, pane.cwd, space.name, "open");
    add(out, seen, space.folder || home, space.name, "open");
  }
  for (const path of recent) add(out, seen, path, "Recent", "recent");
  // "~" until the machine says where its home is: a session started there opens in it.
  add(out, seen, home ?? "~", "Home", "recent");
  for (const path of scanned) add(out, seen, path, "", "projects");
  return out;
}

export const GROUPS = { open: "Open here", recent: "Recent", projects: "Projects", inside: "Inside" };

// What a search shows: every word in the folder's path, best names first.
export function searchFolders(folders, query, home) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return folders;
  const whole = query.toLowerCase().trim();
  const rank = folder => {
    const name = basename(folder.path).toLowerCase();
    return name === whole ? 0 : name.startsWith(words[0]) ? 1 : words.every(w => name.includes(w)) ? 2 : 3;
  };
  return folders
    .map((folder, i) => ({ folder, i, text: `${tilde(folder.path, home)} ${folder.tag}`.toLowerCase() }))
    .filter(entry => words.every(word => entry.text.includes(word)))
    .map(entry => ({ ...entry, rank: rank(entry.folder) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(entry => entry.folder);
}

// What a typed path shows, from LIST's answer for its folder: the folder itself while
// nothing follows its last "/", then the folders in it that start with what does.
export function insideFolders(listing, leaf) {
  if (!listing) return [];
  const start = leaf.toLowerCase();
  const out = leaf ? [] : [{ path: listing.dir, tag: "This folder", group: "inside" }];
  for (const name of listing.names) {
    if (name.startsWith(".") && !leaf.startsWith(".")) continue;
    if (name.toLowerCase().startsWith(start)) out.push({ path: join(listing.dir, name), tag: "", group: "inside" });
  }
  return out;
}

export function remember(list = [], path, max = RECENT_MAX) {
  return [path, ...list.filter(p => p !== path)].slice(0, max);
}

// The space a session started in `folder` joins as a tab: the focused space when it is there,
// else the active one there, else any space with a terminal there. Null: a new space suits it.
// `fallback`: the space a tab goes to when the person asks for one anyway.
export function placement(folder, machine, spaces = [], panes = [], focused = null) {
  const mine = spaces.filter(space => (space.machine ?? null) === machine);
  const tabs = new Map(mine.flatMap(space => (space.tabs ?? []).map(tab => [tab.id, space])));
  const has = space => folder != null && (trim(space.folder || "") === folder
    || panes.some(pane => tabs.get(pane.tab) === space && pane.cwd && trim(pane.cwd) === folder));
  const order = space => space.id === focused?.space ? 0 : space.active ? 1 : 2;
  const ranked = [...mine].sort((a, b) => order(a) - order(b));
  return { match: ranked.find(has) ?? null, fallback: ranked[0] ?? null };
}
