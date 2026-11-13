// Work Herdr's status cannot see: what an agent left running after its turn ended, and the
// sub-agents running inside it. Read on the agent's own machine from its process tree and
// from Claude Code's files: the session file (~/.claude/sessions/<pid>.json), the last goal
// record in the session's transcript, and the transcripts of its sub-agents. Pure, so the
// sidebar can test it; main.js runs PROBE through Herdr's exec.

// How often to look while nothing changes. A machine is also looked at within a second of
// one of its agents changing status, which is when background work starts or ends, except
// "/goal clear", which this interval catches.
export const PROBE_MS = 10000;
// Older readings are ignored, so a machine that stops answering cannot pin rows in Working.
export const STALE_MS = 45000;
// A sub-agent whose transcript has been quiet this long is taken as stopped.
const QUIET_MINUTES = 15;
// Transcripts read in full in one look, at most (always at least one): the rest wait for the
// next look, so a first look over very long sessions can't run into exec's time limit.
const FULL_READ_BYTES = 256 * 1024 * 1024;
// Bytes read again before the last read's end: a goal record (a few KB) still being written.
const SLACK = 4096;

// POSIX sh. Arguments: the agent terminals' foreground process IDs, then what was read
// before: <session>=<bytes>@<folder> for a session's transcript (<folder>: its project
// folder), <agent>=<bytes> for a sub-agent's. Prints, one record a line:
//   P <pid> <ppid> <elapsed> <args>   every process up to three levels under an argument
//   S <pid> <json>                    Claude Code's session file for that process
//   L <pid> <session> <folder>        the session whose transcript was found for it
//   Z <session> <bytes>               that transcript's size
//   G <session> * [<json>]            read in full: its last goal record, if any
//   G <session> + <json>              the last goal record among bytes added since the last read
//                                     (no Z line: too much to read in full this time)
//   T <session> <agent> <bytes>       a sub-agent transcript written in the last few minutes
//   M <agent> <json>                  a new sub-agent's description (its .meta.json)
//   A <agent> run|done                a changed sub-agent: still going, or handed back
//   B <agent> <timestamp>             when a new sub-agent started
// Only what changed since the last read is read, so a look usually costs a ps, an awk, a wc
// and a tail for each transcript that grew: transcripts run to hundreds of MB, and starting a
// program is slow on some Macs. Lookups happen in awk, which stays fast with many agents. A
// transcript that grew is read from where the last read ended, so whatever it gains while
// it is read is left for the next look, never skipped.
// A plain template: \${ is the shell's own expansion and \\n stays \n for printf.
export const PROBE = `PROBE_DIR=\${CLAUDE_CONFIG_DIR:-$HOME/.claude}
export PROBE_DIR
mark='"attachment":{"type":"goal_status"'
nl='
'
roots= known=
for arg; do
  case $arg in *=*) known="$known $arg" ;; *) roots="$roots $arg" ;; esac
done
# For awk: the id in a path (.../<id>.jsonl or .../agent-<id>.jsonl), and what was read before.
lib='function name(f,  n, part) { n = split(f, part, "/"); f = part[n]; sub(/^agent-/, "", f); sub(/[.]jsonl$/, "", f); return f }
function remember(  n, list, i, j, k, id) {
  n = split(known, list, " ")
  for (i = 1; i <= n; i++) {
    j = index(list[i], "="); k = index(list[i], "@"); id = substr(list[i], 1, j - 1)
    bytes[id] = (k ? substr(list[i], j + 1, k - j - 1) : substr(list[i], j + 1)) + 0
    if (k) folder[id] = substr(list[i], k + 1)
  }
}
function size_and_path() { size = $1 + 0; path = $0; sub(/^ *[0-9]+ /, "", path) }'
# Before each file read from a byte offset: "==> <offset> <file> <==". Its first line is cut
# short, unless the read starts at the beginning. One field a line: lines run to MBs.
skip='BEGIN { FS = "\\n" }
/^==> [0-9]+ .* <==$/ { file = substr($0, 5, length($0) - 8); i = index(file, " "); cut = substr(file, 1, i - 1) + 0 > 1; file = substr(file, i + 1); next }
cut { cut = 0; next }'

# The processes under each agent, its Claude Code session file, and the session's id.
procs=$(ps -A -ww -o pid= -o ppid= -o etime= -o args= 2>/dev/null | awk -v roots="$roots" -v known="$known" "$lib"'
  BEGIN { remember(); n = split(roots, list, " "); for (i = 1; i <= n; i++) depth[list[i]] = 0 }
  { pid[NR] = $1; up[NR] = $2; line[NR] = $0 }
  END {
    if (!NR) exit 1
    for (round = 0; round < 3; round++)
      for (i = 1; i <= NR; i++)
        if (!(pid[i] in depth) && (up[i] in depth) && depth[up[i]] < 3) depth[pid[i]] = depth[up[i]] + 1
    for (i = 1; i <= NR; i++) {
      if (!(pid[i] in depth)) continue
      print "P " line[i]
      file = ENVIRON["PROBE_DIR"] "/sessions/" pid[i] ".json"
      session = ""
      if ((getline session < file) > 0) print "S " pid[i] " " session
      close(file)
      id = ""
      if (match(session, /"sessionId":"[0-9A-Za-z][0-9A-Za-z-]*"/)) id = substr(session, RSTART + 13, RLENGTH - 14)
      else if (session == "") {
        # No session file (some machines write none): a claude command line may name it.
        n = split(line[i], word, " "); cmd = word[4]; sub(/.*\\//, "", cmd)
        if (cmd == "claude") for (j = 5; j < n; j++) if (word[j] == "--session-id" || word[j] == "--resume" || word[j] == "-r") { id = word[j + 1]; break }
        if (id !~ /^[0-9A-Za-z][0-9A-Za-z-]*$/) id = ""
      }
      # Sub-agents run only while Claude Code is busy or asking, which its session file says.
      if (id != "") print "I " pid[i] " " id " " (session == "" || session ~ /"status":"(busy|waiting)"/) " " (id in folder ? folder[id] : "-")
    }
  }') || exit 1 # no process list: say so, rather than "nothing running"
[ -n "$procs" ] || exit 0
printf '%s\\n' "$procs"

# Each session's transcript: in the folder it was in last time, or found again (the newest,
# if a resumed session left one in two folders). A session open twice is read once.
set --
subs=$nl seen=$nl
while read -r tag pid id look folder; do
  [ "$tag" = I ] || continue
  path=
  case $folder in -|.*|*[!0-9A-Za-z._-]*) ;; *) [ -f "$PROBE_DIR/projects/$folder/$id.jsonl" ] && path=$PROBE_DIR/projects/$folder/$id.jsonl ;; esac
  if [ -z "$path" ]; then
    for found in "$PROBE_DIR"/projects/*/"$id".jsonl; do
      [ -f "$found" ] && { [ -z "$path" ] || [ "$found" -nt "$path" ]; } && path=$found
    done
  fi
  [ -n "$path" ] || continue
  folder=\${path%/*}
  printf 'L %s %s %s\\n' "$pid" "$id" "\${folder##*/}"
  case $seen in *"$nl$path$nl"*) ;; *) seen="$seen$path$nl"; set -- "$@" "$path" ;; esac
  dir=\${path%.jsonl}/subagents
  case $look$subs in 1*"$nl$dir$nl"*|0*) ;; *) [ -d "$dir" ] && subs="$subs$dir$nl" ;; esac
done <<EOF
$procs
EOF
[ $# -gt 0 ] || exit 0

# Which transcripts to read, and from where: unchanged ones not at all, new or shrunk ones in
# full (up to a budget a look), grown ones from a little before the last read's end.
grown= full=
while read -r tag rest; do
  case $tag in
    Z|G) printf '%s %s\\n' "$tag" "$rest" ;;
    W) grown="$grown$rest$nl" ;;
    F) full="$full$rest$nl" ;;
  esac
done <<EOF
$(wc -c "$@" 2>/dev/null | awk -v known="$known" "$lib"'
  BEGIN { remember() }
  { size_and_path() }
  path !~ /[.]jsonl$/ { next }
  {
    id = name(path)
    if (!(id in bytes) || size < bytes[id]) {
      if (budget && budget + size > ${FULL_READ_BYTES}) next
      budget += size + 1
      print "Z " id " " size; print "G " id " *"; print "F " path
      next
    }
    print "Z " id " " size
    if (size > bytes[id]) { from = bytes[id] - ${SLACK - 1}; print "W " (from > 1 ? from : 1) " " path }
  }')
EOF

# What each grown transcript gained, ending a line that is still being written.
[ -n "$grown" ] && printf '%s' "$grown" | while read -r from path; do
  printf '\\n==> %s %s <==\\n' "$from" "$path"
  tail -c +"$from" "$path" 2>/dev/null
done | awk -v mark="$mark" "$lib $skip"'
  index($0, mark) && substr($0, length($0)) == "}" { last[file] = $0 }
  END { for (f in last) print "G " name(f) " + " last[f] }'
IFS=$nl
set -f
[ -n "$full" ] && LC_ALL=C grep -F "$mark" $full /dev/null 2>/dev/null | awk "$lib"'
  { i = index($0, ":{"); last[substr($0, 1, i - 1)] = substr($0, i + 1) }
  END { for (f in last) print "G " name(f) " * " last[f] }'
# The sub-agents of busy sessions that wrote lately, and which of them changed.
agents=
[ "$subs" != "$nl" ] && agents=$(find $subs -name 'agent-*.jsonl' -mmin -${QUIET_MINUTES} -exec wc -c {} + 2>/dev/null | awk -v known="$known" "$lib"'
  BEGIN { remember() }
  { size_and_path() }
  path !~ /\\/subagents\\/agent-[^\\/]*[.]jsonl$/ { next }
  {
    agent = name(path); session = path; sub(/\\/subagents\\/[^\\/]*$/, "", session)
    print "T " name(session) " " agent " " size
    if (agent in bytes && bytes[agent] == size) next
    print "C " path
    if (agent in bytes) next
    print "R " path
    meta = substr(path, 1, length(path) - 6) ".meta.json"
    if ((getline line < meta) > 0) print "M " agent " " line
    close(meta)
  }')
unset IFS
set +f

changed= new=
while read -r tag rest; do
  case $tag in
    T|M) printf '%s %s\\n' "$tag" "$rest" ;;
    C) changed="$changed$rest$nl" ;;
    R) new="$new$rest$nl" ;;
  esac
done <<EOF
$agents
EOF

IFS=$nl
set -f
# A sub-agent is done once its last message hands its report back or ends its turn, or is the
# answer to the hand-back (small even when the report is too long to read here), or once the
# user interrupts it. A message after that starts it again.
[ -n "$changed" ] && tail -c 65536 $changed /dev/null 2>/dev/null | awk "$lib"'
  BEGIN { FS = "\\n" }
  /^==> .* <==$/ { file = substr($0, 5, length($0) - 8); if (file != "/dev/null") last[file] = "run"; back = 0; cut = 1; next }
  cut { cut = 0; next }
  index($0, "\\"role\\":\\"assistant\\"") {
    back = index($0, "\\"name\\":\\"SubagentHandback\\"") > 0
    last[file] = (back || index($0, "\\"stop_reason\\":\\"end_turn\\"")) ? "done" : "run"
    next
  }
  index($0, "\\"role\\":\\"user\\"") {
    last[file] = (back || index($0, "\\"toolEndsTurn\\":true") || index($0, "[Request interrupted by user")) ? "done" : "run"
    back = 0
  }
  END { for (f in last) print "A " name(f) " " last[f] }'
[ -n "$new" ] && head -n 1 $new /dev/null 2>/dev/null | awk "$lib"'
  BEGIN { FS = "\\n" }
  /^==> .* <==$/ { file = substr($0, 5, length($0) - 8); next }
  file != "" && match($0, /"timestamp":"[^"]*"/) { print "B " name(file) " " substr($0, RSTART + 13, RLENGTH - 14); file = "" }'
unset IFS
set +f
`;

// Claude Code runs every Bash command (foreground or background) as
//   <shell> -c source …/shell-snapshots/snapshot-<shell>-….sh … && eval '<command>' < /dev/null && pwd -P >| …
const SNAPSHOT = /[\\/]shell-snapshots[\\/]snapshot-/;
const ID = /^[0-9A-Za-z-]+$/;
// A project folder's name, as Claude Code makes it from a path (no slashes, no "..").
const FOLDER = /^[0-9A-Za-z_-][0-9A-Za-z._-]*$/;

// ps's elapsed time, [[dd-]hh:]mm:ss, in seconds.
export function elapsed(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text ?? "");
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : 0;
}

// The command Claude Code was asked to run, unquoted from its eval '…' word. macOS's ps
// prints a newline in it as \012.
export function shellCommand(args) {
  args = args.replace(/\\012/g, "\n");
  const at = args.indexOf(" eval '");
  if (at < 0) return args.replace(/\s+/g, " ").trim();
  let out = "";
  let i = at + 6;
  while (i < args.length && args[i] !== " ") {
    const c = args[i];
    if (c === "'") {
      const end = args.indexOf("'", i + 1);
      if (end < 0) { out += args.slice(i + 1); break; }
      out += args.slice(i + 1, end);
      i = end + 1;
    } else if (c === "\"") {
      let j = i + 1;
      for (; j < args.length && args[j] !== "\""; j++) {
        if (args[j] === "\\" && j + 1 < args.length) j++;
        out += args[j];
      }
      i = j + 1;
    } else if (c === "\\") {
      out += args[i + 1] ?? "";
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

// Claude Code's own rule (it restores goals the same way on resume): the last goal_status
// record decides. Met, failed and cleared ("/goal clear" writes met) mean no goal.
// Undefined when the line can't be read (cut short, or still being written): no news.
export function goalOf(line) {
  let a;
  try { a = JSON.parse(line)?.attachment; } catch { return undefined; }
  if (a?.type !== "goal_status") return undefined;
  if (a.met || a.failed || typeof a.condition !== "string" || !a.condition.trim()) return null;
  return { condition: a.condition.trim(), check: a.sentinel ? "" : String(a.reason ?? "").trim() };
}

const text = (value, n = 200) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, n) : "";

// One machine's probe output. `read`: what earlier probes of that machine learned about each
// transcript, id → { bytes, goal, folder } for a session, { bytes, state, started, meta } for
// a sub-agent. The result's `read` replaces it, and holds only what this probe saw.
export function parseProbe(output, at = Date.now(), read = new Map()) {
  const procs = new Map();
  const sessions = new Map();
  const logs = new Map();
  const folders = new Map();
  const sizes = new Map();
  const records = new Map();
  const full = new Set();
  const listed = new Map();
  const states = new Map();
  const starts = new Map();
  const metas = new Map();
  for (const line of String(output ?? "").split("\n")) {
    let m;
    if ((m = /^P\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line))) {
      procs.set(m[1], { pid: m[1], parent: m[2], started: at - elapsed(m[3]) * 1000, args: m[4] });
    } else if ((m = /^S (\d+) (.+)$/.exec(line))) {
      try { sessions.set(m[1], JSON.parse(m[2])); } catch { /* caught mid-write; next look */ }
    } else if ((m = /^L (\d+) (\S+) ?(\S*)$/.exec(line))) {
      logs.set(m[1], m[2]);
      if (m[3]) folders.set(m[2], m[3]);
    } else if ((m = /^Z (\S+) (\d+)$/.exec(line))) {
      sizes.set(m[1], Number(m[2]));
    } else if ((m = /^G (\S+) ([*+]) ?(.*)$/.exec(line))) {
      if (m[2] === "*") full.add(m[1]);
      if (m[3]) records.set(m[1], m[3]);
    } else if ((m = /^T (\S+) (\S+) (\d+)$/.exec(line))) {
      if (!listed.has(m[1])) listed.set(m[1], new Map());
      listed.get(m[1]).set(m[2], Number(m[3]));
    } else if ((m = /^A (\S+) (run|done)$/.exec(line))) {
      states.set(m[1], m[2]);
    } else if ((m = /^B (\S+) (\S+)$/.exec(line))) {
      const time = Date.parse(m[2]);
      if (Number.isFinite(time)) starts.set(m[1], time);
    } else if ((m = /^M (\S+) (.+)$/.exec(line))) {
      try { metas.set(m[1], JSON.parse(m[2])); } catch { /* not readable; described by its id */ }
    }
  }
  const next = new Map();
  const goals = new Map();
  for (const [id, bytes] of sizes) {
    // A record that can't be read says nothing; a full read that found none clears the goal.
    let goal = read.get(id)?.goal ?? null;
    if (records.has(id)) {
      const found = goalOf(records.get(id));
      if (found !== undefined) goal = found;
    } else if (full.has(id)) {
      goal = null;
    }
    goals.set(id, goal);
    next.set(id, { bytes, goal, folder: folders.get(id) ?? null });
  }
  const subagents = new Map();
  for (const [session, list] of listed) {
    const running = [];
    for (const [id, bytes] of list) {
      const before = read.get(id);
      const state = states.get(id) ?? before?.state ?? "done";
      const started = starts.get(id) ?? before?.started ?? at;
      const meta = metas.get(id) ?? before?.meta ?? null;
      next.set(id, { bytes, state, started, meta });
      if (state === "run") {
        running.push({ id, type: text(meta?.agentType, 60), description: text(meta?.description), background: meta?.requestShape === "background", started });
      }
    }
    subagents.set(session, running.sort((a, b) => a.started - b.started || a.id.localeCompare(b.id)));
  }
  return { procs, sessions, logs, goals, subagents, read: next, at };
}

// The probe's arguments: the foreground process IDs, then what is already read. Only plain
// numbers, ids and folder names go to the shell.
export function probeArgs(targets, read = new Map()) {
  return [
    ...new Set(targets.map(target => String(target.pid)).filter(pid => /^\d+$/.test(pid))),
    ...[...read].filter(([id, seen]) => ID.test(id) && Number.isSafeInteger(seen.bytes))
      .map(([id, seen]) => `${id}=${seen.bytes}${FOLDER.test(seen.folder ?? "") ? `@${seen.folder}` : ""}`),
  ];
}

// address → { at, session, goal, shells, subagents } for the terminals probed on one
// machine. targets: [{ address, pid }] with pid the terminal's foreground process: Claude
// Code itself, or a wrapper that started it. The nearest session under it is the agent's.
export function workOf(targets, probe) {
  const roots = new Map(targets.map(target => [String(target.pid), target.address]));
  const place = pid => {
    for (let p = pid, depth = 0; p && depth <= 3; p = probe.procs.get(p)?.parent, depth++) {
      if (roots.has(p)) return { root: p, depth };
    }
    return null;
  };
  const found = new Map();
  for (const [pid, proc] of probe.procs) {
    const where = place(pid);
    if (!where) continue;
    const entry = found.get(where.root) ?? { pid: null, depth: Infinity, shells: [] };
    found.set(where.root, entry);
    if ((probe.sessions.has(pid) || probe.logs.has(pid)) && where.depth < entry.depth) Object.assign(entry, { pid, depth: where.depth });
    // A snapshot shell under another one (below the agent) is that command's own work.
    if (where.depth > 0 && SNAPSHOT.test(proc.args) && !(where.depth > 1 && SNAPSHOT.test(probe.procs.get(proc.parent)?.args ?? ""))) {
      entry.shells.push({ text: shellCommand(proc.args), started: proc.started });
    }
  }
  const out = new Map();
  for (const [root, entry] of found) {
    const session = probe.sessions.get(entry.pid);
    const id = probe.logs.get(entry.pid);
    out.set(roots.get(root), {
      at: probe.at,
      session: session ? { status: typeof session.status === "string" ? session.status : null } : null,
      goal: (id && probe.goals.get(id)) ?? null,
      shells: entry.shells.sort((a, b) => a.started - b.started),
      subagents: (id && probe.subagents.get(id)) ?? [],
    });
  }
  return out;
}

// Agent rows to probe, by machine (null: this computer). Only plain numeric IDs are sent.
export function probeTargets(rows) {
  const out = new Map();
  for (const row of rows) {
    const pid = String(row.pid ?? "");
    if (row.kind !== "agent" || !row.available || !/^\d+$/.test(pid)) continue;
    if (!out.has(row.machine)) out.set(row.machine, []);
    out.get(row.machine).push({ address: row.address, pid });
  }
  return out;
}

// What a reading says, without times: redraw only when this changes.
export function signature(work) {
  return JSON.stringify([...work].sort(([a], [b]) => a.localeCompare(b)).map(([address, info]) =>
    [address, info.session?.status ?? null, info.goal?.condition ?? null, info.goal?.check ?? null,
      info.shells.map(shell => shell.text), info.subagents.map(sub => [sub.id, sub.description])]));
}
