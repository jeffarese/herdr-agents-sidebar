import { sidebarButton } from "./sidebar-rail.js";
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { agents, terminals, panes, spaces, machines, focused, theme, settings, run, hc, notify, setAgentOrder, nextCommand, openOverlay, props, shared, setShared, updates, exec, pickFolder, readTextFile, home, window, appHome, keys } from "herdr";
import { build, groups, counts, WORDS, BACKGROUND, modelName, fitWhere, activityText, tokens, canMove, movable, moveArgs, canReply, canRename, renameAction, NAMES_KEY, stale, ended, remember, resumeAction, organizeBrief, organizePlan, previewOf, latestCodex, organizeAnswer, ORGANIZE_SYSTEM, ORGANIZE_SCHEMA, folderKey, DENSITY_KEY, GROUP_KEY, SETTINGS_KEY, settingsOf, STALE_SESSION_MS, openAction, closeAction, duration, backgroundLines, machineOf, shortPath, holdDone, dropLeaving, statFigures, statsText } from "./model.js";
import { PROBE, PROBE_MS, KIND, CHANGES, PULLS, STATS, STATS_MS, STATS_STALE_MS, parseChanges, parsePulls, machineKind, parseProbe, parseStats, snapshotStats, probeArgs, probeTargets, workOf, signature } from "./background.js";
import { initLauncher, renderLauncher, LAUNCHER } from "./launcher.js";
import { initSettings, renderSettings, SETTINGS } from "./settings.js";
import { demo } from "./demo.js";

const ART = "mods/agent-sidebar/";
const glyph = (name, size = 14) => svg(`${ART}${name}.svg`).size(size).flex_none();
// "cmd-g" as it is pressed: "⌘G" on a Mac, "Ctrl+G" elsewhere.
function keyLabel(stroke, mac) {
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super" };
  const parts = stroke.trim().split(/\s+/)[0].split("-");
  const key = parts.pop() || "-";
  const held = new Set(parts.map(m => ({ secondary: mac ? "cmd" : "ctrl", super: "cmd", control: "ctrl", option: "alt" })[m] ?? m));
  return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), key.length === 1 ? key.toUpperCase() : key].join(mac ? "" : "+");
}
// Beside a remote machine's name: it is reached through herdr-core, elsewhere.
const remoteMark = (color, key) => div().id(`remote-${key}`).flex_none().flex().items_center().tooltip("Remote: reached through herdr-core")
  .child(glyph("globe", 12).text_color(color));
const hostState = host => host.layout === "ready" ? "" : host.layout === "loading" ? "Connecting…" : "Unavailable";
// A machine that can't be reached: one quiet line after the others, its sessions behind a click.
const isAway = host => host.remote && host.layout === "unavailable";
// Below this width the sidebar is a rail of icons.
const RAIL = 210;
const WIDE = 320;
// The mark of an agent whose turn ended but whose work goes on, by its first reason.
const HOLD = { shell: "terminal", agents: "agent", goal: "goal" };
// The ✕ stays armed this long after its first click; a second click sooner than a double
// click's is ignored.
const ARMED_MS = 4000;
const DOUBLE_CLICK_MS = 400;
// A machine is asked at most this often, however often its agents change status.
const PROBE_GAP_MS = 1000;
// "compact": one line per session; "expanded": two, the second saying where it works. The
// person's choice, so every copy (and layout) shows the same.
const ROW = { compact: 28, expanded: 40 };
// "status": sections by what each session is doing; "space": a section for each of Herdr's
// spaces. The person's choice too.
// What kind of machine each one is ("" for this computer), for its icon: asked once a start,
// and kept so the next start shows it at once.
const KINDS_KEY = "agent-sidebar.kinds";
const KIND_ICON = { laptop: "laptop", desktop: "computer", server: "server" };
const KIND_RETRY_MS = 60000;
// A space's color, as Herdr's own Spaces list keeps and cycles it.
const SPACE_COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
// A session being moved has this long to lose its pane before the move is given up.
const MOVE_MS = 8000;
// Claude Code sessions that ended, newest first, to reopen: { title, cwd, machine, session, at }.
const CLOSED_KEY = "agent-sidebar.closed";
// The effort a session runs with, as a scale: the more of it, the warmer. Low is the plain
// gray of the rest, then blue, green, yellow and red, and the most is also heavier.
const EFFORT_COLOR = { low: "muted", medium: "ansi4", high: "ansi2", xhigh: "ansi3", max: "ansi1" };
// Asks Claude through Claude Code's own print mode on this computer, or Codex through its exec
// mode: no tools or a read-only sandbox, and no session kept. PATH as a login would have it:
// the app's own may lack it. Codex takes its schema from a file and leaves its answer in one.
const CODEX_SH = `command -v codex >/dev/null 2>&1 || PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
dir=$(mktemp -d) || exit 1
trap 'rm -rf "$dir"' EXIT
printf '%s' "$1" > "$dir/schema.json"
shift
codex exec --skip-git-repo-check --ephemeral --sandbox read-only --color never --output-schema "$dir/schema.json" -o "$dir/answer.json" "$@" < /dev/null > "$dir/log" 2>&1 || { tail -c 300 "$dir/log" >&2; exit 1; }
cat "$dir/answer.json"
`;
const ASKED = { claude: "Claude", codex: "Codex" };
const ORGANIZE_SH = 'command -v claude >/dev/null 2>&1 || PATH="$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"; exec claude "$@" < /dev/null';
const organizeArgs = cfg => ["-p", "--model", cfg.organizeModel, "--effort", cfg.organizeEffort, "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--output-format", "json"];
const NAME_MS = 15000;
// How often each machine is asked what its folders changed, and (through GitHub) for their
// pull requests; and how many folders at most.
const CHANGES_MS = 30000;
const PULLS_MS = 300000;
const GIT_FOLDERS = 24;
const PULL_COLOR = { open: "ansi2", draft: "dim", merged: "ansi5", closed: "ansi1" };
const GROUPINGS = ["status", "space", "project"];
const GROUP_TIP = { status: "Grouped by status · click for spaces", space: "Grouped by space · click for projects (spaces of one name, on every machine)", project: "Grouped by project · click for status" };
const hex = n => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
// Sessions under a folder heading sit this much further in.
const GROUPED_INDENT = 10;
// A status change: the new mark fades and slides in; news that wants you (Needs you, Done)
// also tints its row for a moment. Native transitions; a change is fresh for SETTLE_MS.
const MARK_IN = { duration: 380, easing: "ease-out" };
const TINT_OUT = { duration: 1600, easing: "ease-out" };
const SETTLE_MS = 2200;
// When the list changes, rows and headings that moved slide from where they were to where they
// are now, and the ones in between make room. Heights here must match what is drawn.
const SLIDE = { duration: 300, easing: "ease-out" };
// Something new in a list that was already shown fades in where it lands.
const ENTER = { duration: 240, easing: "ease-out" };
const SLIDE_MS = 700;
const HEIGHT = { host: 30, hostState: 10, hostGap: 14, away: 24, section: 22, sectionGap: 6, folder: 20, empty: 29 };
// A host heading and the space above it.
const hostHeight = (group, first, firstAway) => isAway(group) ? HEIGHT.away + (firstAway && !first ? HEIGHT.hostGap : 0)
  : HEIGHT.host + (hostState(group) ? HEIGHT.hostState : 0) + (first ? 0 : HEIGHT.hostGap);
const NEWS = new Set(["blocked", "done"]);
// A machine's figures (model.js statFigures), each a glyph, a gap and "100%" at most, and the
// gap between two.
const STAT_WIDTH = 34;
const STAT_GAP = 7;
// What a reading shows, without its time: the heading redraws only when this changes.
const statsKey = r => r ? statFigures(r).map(f => `${f.key}:${f.text}:${f.level}`).join(" ") : "";
// Per-copy conveniences only (folded hosts and sections). Storage can be missing or throw.
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not kept */ } },
};

export default class AgentSidebar extends View {
  init(_props, cx) {
    // Herdr's per-copy/overlay parameters come from props(), not GPUI's init argument.
    const initial = props() ?? {};
    this.launcher = Boolean(initial.launcher);
    if (this.launcher) { initLauncher(this, initial, cx); return; }
    // The gear's window is this mod too, showing its settings.
    if (initial.settings) { initSettings(this); return; }
    // What the sidebar shows: the app, or example sessions for the README's picture (demo.js),
    // which ask no machine anything.
    const example = initial.demo ? demo(Date.now()) : null;
    this.demo = Boolean(example);
    this.x = example ? {
      machines: () => example.machines, panes: () => example.panes, agents: () => [], terminals: () => example.terminals,
      spaces: () => example.spaces, focused: () => example.focused, shared: key => example.shared[key],
    } : { machines, panes, agents, terminals, spaces, focused, shared };
    this.cfg = settingsOf(this.x.shared(SETTINGS_KEY));
    this.selected = null;
    this.hovered = null;
    this.width = Infinity;
    // Host keys ("local", "remote:work") and section keys ("local:idle").
    this.folded = new Set(store.get("folded", []));
    // Unreachable hosts whose sessions were asked for. Not kept: once back, a host is as it was.
    this.revealed = new Set();
    // Moving sessions to another space. `moving`: { addresses, title, from, machine } while a
    // space is being chosen; `pending`: moves under way; `drag`: a press that may become one.
    this.moving = null;
    this.pending = [];
    // New spaces a move makes, to name once Herdr shows them: { id, name, at }.
    this.naming = [];
    // The suggestion for the spaces (Claude's or Codex's, `asker`): null, "asking", or
    // { renames, moves } to apply.
    this.asker = "Claude";
    this.plan = null;
    // The moves of that suggestion the person took out, and which asking an answer is for.
    this.skip = new Set();
    this.asks = 0;
    // Sessions parked by a move, until Herdr shows them in their new space: not "leaving".
    this.parked = new Set();
    this.drag = null;
    this.hoveredSection = null;
    // The session a message is being written to, in the field under its row.
    this.replying = null;
    this.reply = InputState.new({ placeholder: "Message, then Enter" });
    this.reply.on("submit", (_e, cx) => { this.send(); cx?.notify?.(); });
    // The session being renamed, in the field under its row.
    this.renaming = null;
    this.renameInput = InputState.new({ placeholder: "Name (empty resets)" });
    this.renameInput.on("submit", (_e, cx) => { this.commitRename(); cx?.notify?.(); });
    // address → what was last seen of each Claude Code session, to tell when one ended.
    this.known = new Map();
    this.closedOpen = Boolean(store.get("closedOpen", false));
    // address → the status each row was shown with, and the changes still animating.
    this.shown = null;
    this.fresh = new Map();
    // Key (host, section, folder or row) → where it was drawn, and the slides still running.
    this.ys = null;
    this.moves = new Map();
    // Sessions on their way out (model.js dropLeaving), and the terminals that had a pane.
    this.leaving = new Map();
    this.placed = new Set();
    // A transition runs from what one render shows to what the next one does: a change is drawn
    // at its start, and this redraws it a frame later at its end.
    cx.spawn(async cx => {
      for (;;) {
        await new Promise(resolve => { this.pulse = resolve; });
        await cx.sleep(32);
        cx.notify();
      }
    });
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    // "focus" from pane.go (Up, Down and Enter then pick a session); "new" (bind a key to agent-sidebar.new) opens the launcher for the
    // focused machine; "browse" comes from the launcher, which closes for the system's picker.
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        else if (command === "new") this.launch(this.x.spaces().find(space => space.id === this.x.focused()?.space)?.machine ?? null, {}, "dialog");
        else if (command === "browse") this.browse();
        else if (command === "density") this.toggleDensity();
        else if (command === "group") this.toggleGroup();
        else if (command === "settings") this.openSettings();
        // The README's picture: a copy with example sessions, to take a shot of.
        else if (command === "demo") openOverlay({ mod: "agent-sidebar", kind: "dialog", width: 340, height: 892, props: { demo: true } });
        // Asks Claude; again, puts its suggestion (or the asking) away.
        else if (command === "organize") this.plan ? this.dismissPlan() : this.organize();
        cx.notify();
      }
    });
    // Ages ("4m") are data, not animation: once every 30 s is as often as they change. The
    // agent grid (a mod of its own) gets a button in the header once it is installed.
    this.grid = false;
    const lookForGrid = cx => cx.spawn(async cx => {
      const found = Boolean(await readTextFile(`${appHome()}/mods/agent-grid/mod.json`).catch(() => null));
      if (found !== this.grid) { this.grid = found; cx.notify(); }
    });
    lookForGrid(cx);
    cx.timer.every(30000, cx => { lookForGrid(cx); cx.notify(); });
    // Background work Herdr's status can't see (background.js), asked of each machine every
    // PROBE_MS, and again within a second of one of its agents changing status, which is
    // when such work starts or ends. Machines are asked separately: a slow one holds up none.
    this.work = new Map(); // address → the last reading
    this.read = new Map(); // machine → what its transcripts held at the last reading
    this.asked = new Map(); // machine → when it was last asked
    this.asking = new Set(); // machines whose answer is on its way
    this.stale = new Set(); // machines to ask again as soon as allowed
    this.kinds = new Map(); // machine → true once it said what it is, else when it was asked
    this.git = new Map(); // machine → { changes, pulls: folder → what git and GitHub said, asked, pulled: when }
    this.stats = new Map(); // machine → { reading: how busy it was (background.js STATS), asked: when, asking }
    if (example) Object.assign(this, { work: example.work, git: example.git, stats: example.stats });
    cx.spawn(async cx => {
      let wake = () => {};
      for (;;) {
        if (!this.demo) {
          this.probe(() => wake());
          this.askKinds(() => wake());
          this.askGit(() => wake());
          this.askStats(() => wake());
          this.finishMoves();
        }
        // A second, or less when an answer arrives or a move is under way.
        await Promise.race([cx.sleep(this.pending.length || this.naming.length ? 250 : 1000), new Promise(resolve => { wake = resolve; })]);
        // A session held back as leaving comes back if it is still there after LEAVE_MS.
        if (this.changed || this.leaving.size || this.pending.length || this.naming.length) {
          this.changed = false;
          cx.notify();
        }
      }
    });
  }

  // Asks every machine that is due. `answered` is called as each answer arrives.
  probe(answered) {
    const targets = probeTargets(this.rows ?? []);
    for (const address of [...this.work.keys()]) if (!targets.has(machineOf(address))) this.work.delete(address);
    for (const machine of [...this.read.keys()]) if (!targets.has(machine)) this.read.delete(machine);
    const now = Date.now();
    for (const [machine, list] of targets) {
      const since = now - (this.asked.get(machine) ?? 0);
      if (this.asking.has(machine) || since < PROBE_GAP_MS || (since < PROBE_MS && !this.stale.has(machine))) continue;
      this.stale.delete(machine);
      this.asked.set(machine, now);
      this.asking.add(machine);
      this.ask(machine, list).finally(() => {
        this.asking.delete(machine);
        answered();
      });
    }
  }

  // One small sh script on the machine. Never throws: a machine that can't be asked, or
  // whose script fails, keeps its last reading, which build() stops trusting once it is old.
  async ask(machine, targets) {
    const known = this.read.get(machine);
    let result;
    try {
      result = await exec("sh", ["-c", PROBE, "sh", ...probeArgs(targets, known)], { on: machine, timeout: 15000 });
    } catch {
      return;
    }
    if (result.code !== 0) return;
    const probe = parseProbe(result.stdout, Date.now(), known);
    this.read.set(machine, probe.read);
    const before = signature(this.work);
    for (const address of [...this.work.keys()]) if (machineOf(address) === machine) this.work.delete(address);
    for (const [address, info] of workOf(targets, probe)) this.work.set(address, info);
    if (signature(this.work) !== before) this.changed = true;
  }

  // Asks each reachable machine once what it is (background.js KIND). One that can't say is
  // asked again a minute later, and keeps the icon of its place (this computer, or a remote).
  askKinds(answered) {
    const now = Date.now();
    for (const host of this.x.machines()) {
      const name = host.name ?? null;
      const asked = this.kinds.get(name);
      if (host.layout !== "ready" || asked === true || now - (asked ?? 0) < KIND_RETRY_MS) continue;
      this.kinds.set(name, now);
      exec("sh", ["-c", KIND], { on: name, timeout: 10000 }).then(result => {
        const kind = result.code === 0 ? machineKind(result.stdout) : null;
        if (!kind) return;
        this.kinds.set(name, true);
        if (this.x.shared(KINDS_KEY)?.[name ?? ""] === kind) return;
        setShared(KINDS_KEY, { ...shared(KINDS_KEY), [name ?? ""]: kind });
        this.changed = true;
        answered();
      }).catch(() => { /* asked again later */ });
    }
  }

  // Asks each machine what its sessions' folders changed (git, every CHANGES_MS) and for the
  // pull request of each branch that isn't the main one (the GitHub CLI, every PULLS_MS).
  askGit(answered) {
    const now = Date.now();
    const byMachine = new Map();
    for (const row of this.rows ?? []) {
      if (!row.available || row.inner || !row.cwd || !row.cwd.startsWith("/")) continue;
      if (!byMachine.has(row.machine)) byMachine.set(row.machine, new Map());
      const folders = byMachine.get(row.machine);
      const key = folderKey(row.cwd);
      if (folders.size < GIT_FOLDERS || folders.has(key)) folders.set(key, folders.get(key) || Boolean(row.branch && !/^(main|master|HEAD)$/.test(row.branch)));
    }
    for (const machine of [...this.git.keys()]) if (!byMachine.has(machine)) this.git.delete(machine);
    for (const [machine, folders] of byMachine) {
      if (!this.git.has(machine)) this.git.set(machine, { changes: new Map(), pulls: new Map(), asked: 0, pulled: 0 });
      const state = this.git.get(machine);
      const ask = (script, list, timeout, apply) => exec("sh", ["-c", script, "sh", ...list], { on: machine, timeout })
        .then(result => { if (result.code === 0) { apply(result.stdout); this.changed = true; answered(); } }).catch(() => { /* asked again later */ });
      if (this.cfg.changes && now - state.asked >= CHANGES_MS) {
        state.asked = now;
        const list = [...folders.keys()];
        ask(CHANGES, list, 15000, out => { state.changes = parseChanges(out, list); });
      }
      const branches = [...folders].filter(([, branch]) => branch).map(([folder]) => folder);
      if (this.cfg.pulls && branches.length && now - state.pulled >= PULLS_MS) {
        state.pulled = now;
        ask(PULLS, branches, 30000, out => { state.pulls = parsePulls(out, branches); });
      }
    }
  }

  // Asks each machine whose heading shows (render's `this.headed`) how busy it is, every
  // STATS_MS: nothing while the figures are off, in a rail, or with no machine headings. This
  // computer's are herdr-stats' own when its sampler runs, read from its snapshot; otherwise,
  // and on every other machine, the STATS script measures them.
  askStats(answered) {
    const due = this.cfg.stats ? this.headed ?? [] : [];
    for (const machine of [...this.stats.keys()]) if (!due.includes(machine)) this.stats.delete(machine);
    const now = Date.now();
    for (const machine of due) {
      if (!this.stats.has(machine)) this.stats.set(machine, { reading: null, asked: 0, asking: false });
      const state = this.stats.get(machine);
      if (state.asking || now - state.asked < STATS_MS) continue;
      Object.assign(state, { asked: now, asking: true });
      this.measure(machine).then(reading => {
        if (!reading) return;
        const before = statsKey(state.reading);
        state.reading = reading;
        if (statsKey(reading) !== before) { this.changed = true; answered(); }
      }).catch(() => { /* asked again later; the last reading goes stale */ }).finally(() => { state.asking = false; });
    }
  }

  async measure(machine) {
    if (machine == null) {
      const cache = window()?.platform === "macos" ? "Library/Caches" : ".cache";
      const snap = snapshotStats(await readTextFile(`${home()}/${cache}/herdr-stats/snapshot.json`).catch(() => null));
      if (snap) return snap;
    }
    const result = await exec("sh", ["-c", STATS], { on: machine, timeout: 10000 });
    return result.code === 0 ? parseStats(result.stdout) : null;
  }

  // The launcher: a folder, then a shell or an agent to start there. At the pointer from a +,
  // centered from the keyboard. `extra`: { folder, tag } to start from.
  launch(machine, extra = {}, kind = "popup") {
    if (!this.x.machines().some(host => (host.name ?? null) === machine && host.layout === "ready")) return;
    openOverlay({ mod: "agent-sidebar", kind, width: LAUNCHER.width, height: LAUNCHER.height, props: { launcher: true, machine, ...extra } });
  }

  async browse() {
    let folder = null;
    try { folder = await pickFolder({ prompt: "Choose" }); } catch { /* no picker here */ }
    if (folder) this.launch(null, { folder, tag: "Picked" }, "dialog");
  }

  open(row) {
    const action = openAction(row);
    if (action) run(action.name, action.args);
  }

  // Only after the ✕ was armed by a first click (see row()).
  close(row) {
    const action = closeAction(row);
    if (!action) return;
    this.leaving.set(row.address, Date.now());
    run(action.name, action.args);
  }

  // Status changes since the last render, to animate. Nothing animates on the first one.
  notice(rows, now) {
    for (const [address, change] of this.fresh) if (now - change.at > SETTLE_MS) this.fresh.delete(address);
    const shown = new Map(rows.filter(row => !row.inner).map(row => [row.address, row.status]));
    if (this.shown) {
      for (const [address, status] of shown) {
        const was = this.shown.get(address);
        if (was && was !== status) this.fresh.set(address, { from: was, to: status, at: now, step: 0 });
      }
    }
    this.shown = shown;
  }

  // Rows and headings whose place changed since the last render slide there from the old one:
  // drawn at the old place now, at the new one a frame later, with a transition between. Not
  // when the view itself changed (width, density): that is a new list, not a move.
  slide(t, children, keys, heights, compact, now) {
    for (const [key, move] of this.moves) if (now - move.at > SLIDE_MS) this.moves.delete(key);
    const ys = new Map();
    let y = 0;
    keys.forEach((key, i) => {
      if (key) ys.set(key, y);
      y += heights[i];
    });
    const view = [this.expanded, this.bySpace, this.byProject, Boolean(this.moving), this.replying, this.renaming, this.plan === "asking" ? 1 : this.plan ? 2 : 0, this.width, this.single, compact].join("|");
    if (this.ys && this.view === view && !compact && this.cfg.animations) {
      for (const [key, now_] of ys) {
        const was = this.ys.get(key);
        if (was === undefined) this.moves.set(key, { offset: 0, enter: true, at: now, step: 0 });
        else if (was !== now_) this.moves.set(key, { offset: was - now_, at: now, step: 0 });
      }
    } else this.moves.clear();
    this.ys = ys;
    this.view = view;
    keys.forEach((key, i) => {
      const move = key && this.moves.get(key);
      if (!move) return;
      // A slide is an element of its own, so it starts at the old place rather than easing there.
      // Solid while it moves, so it passes over the rows it crosses instead of through them.
      const start = move.step === 0;
      children[i] = v_flex().id(`slide-${key}-${move.at}`).flex_none().relative()
        .when(move.enter, el => el.opacity(start ? 0 : 1).transition("opacity", ENTER))
        .when(!move.enter, el => el.bg(t.chrome).rounded(6).top(start ? move.offset : 0).transition("top", SLIDE))
        .child(children[i]);
    });
  }

  toggleDensity() {
    setShared(DENSITY_KEY, this.x.shared(DENSITY_KEY) === "expanded" ? "compact" : "expanded");
  }

  // Choosing where sessions go: every space they can go to takes the next click (or the drop).
  // `from`: the space they are in, which is no destination.
  startMove(rows, title, from, dragged = false) {
    const list = rows.filter(movable);
    if (!list.length) return;
    this.moving = { addresses: list.map(row => row.address), title, from, machine: list[0].machine, dragged };
  }

  // Parks each session's pane; finishMoves() labels it into the space once the pane is gone.
  moveTo(space) {
    const moving = this.moving;
    this.moving = null;
    this.drag = null;
    for (const address of moving?.addresses ?? []) {
      const row = (this.rows ?? []).find(row => row.address === address);
      if (!canMove(row, space) || this.pending.some(move => move.address === address)) continue;
      this.pending.push({ address, row, space, at: Date.now() });
      if (row.pane) run("terminal.park", { terminal: address });
    }
  }

  finishMoves() {
    const now_ = Date.now();
    for (const space of this.naming.slice()) {
      const shown = this.x.spaces().some(other => other.id === space.id);
      if (shown) run("space.rename", { id: space.id, name: space.name });
      if (shown || now_ - space.at > NAME_MS) this.naming.splice(this.naming.indexOf(space), 1);
    }
    if (!this.pending.length) return;
    const placed = new Set(this.x.panes().filter(pane => pane.terminal).map(pane => pane.terminal));
    const now = Date.now();
    for (const move of this.pending.slice()) {
      const gone = !placed.has(move.address);
      if (!gone && now - move.at < MOVE_MS) continue;
      this.pending.splice(this.pending.indexOf(move), 1);
      const name = move.name ?? this.x.spaces().find(space => space.id === move.space)?.name ?? "the space";
      // Still there: nothing was changed. Parked but not labeled: it runs on without a pane,
      // listed here under "No space", where a click peeks at it.
      const failed = body => notify({ title: `Could not move ${move.row.title}`, body, level: "warning" });
      if (!gone) { failed("Its pane did not close. Nothing was changed."); continue; }
      this.parked.add(move.address);
      hc(moveArgs(move.row, move.space, `tb${hex(32)}`)).then(result => {
        if (result.code !== 0) failed(`It is still running, without a pane: find it under No space. ${String(result.stderr ?? "").trim().slice(0, 120)}`);
        else if (!move.quiet) notify({ title: `Moved ${move.row.title} to ${name}`, level: "success", timeout: 2500 });
        if (result.code === 0 && move.created && !this.naming.some(space => space.id === move.space)) this.naming.push({ id: move.space, name: move.name, at: Date.now() });
      }).catch(() => failed("It is still running, without a pane: find it under No space."));
    }
  }

  // Sends what was typed to the session, as `hc send` does: pasted, then Enter.
  send() {
    const address = this.replying;
    const text = this.reply.value().trim();
    this.replying = null;
    this.reply.set_value("");
    const row = (this.rows ?? []).find(row => row.address === address);
    if (!text || !canReply(row)) return;
    const failed = why => notify({ title: `Could not send to ${row.title}`, body: String(why ?? "").trim().slice(0, 160), level: "warning" });
    // "--": a message that starts with a dash is still a message.
    hc(["send", "--", address, text]).then(result => { if (result.code !== 0) failed(result.stderr || result.stdout); }).catch(failed);
  }

  replyField(t, row, indent) {
    return h_flex().id(`reply-${row.address}`).h(28).flex_none().ml(indent).mr(4).mb(2).pl(8).pr(6).gap(6).rounded(6)
      .bg(t.background).border(1).border_color(t.border).items_center()
      .child(glyph("reply", 12).text_color(t.muted))
      .child(Input.new(this.reply).accessibility_label(`Message to ${row.title}`).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
      .child(div().flex_none().text_size(10).text_color(t.dim).child("Esc cancels"));
  }

  startRename(row) {
    if (!canRename(row)) return;
    this.drag = null;
    if (this.moving?.dragged) this.moving = null;
    if (this.replying) { this.replying = null; this.reply.set_value(""); }
    const current = row.customName ?? row.title ?? "";
    this.renaming = row.address;
    this.renameInput.set_value(current);
    this.renameInput.set_selected_range?.({ start: 0, end: current.length });
    this.renameInput.focus();
  }

  // Renames the session through Herdr's pane.rename when it has a pane, or keeps the name in
  // shared state when it runs without one. An empty name gives its automatic title back.
  commitRename() {
    const address = this.renaming;
    const name = this.renameInput.value().trim();
    this.renaming = null;
    this.renameInput.set_value("");
    const row = (this.rows ?? []).find(r => r.address === address);
    if (!canRename(row)) return;
    const action = renameAction(row, name);
    const saved = this.x.shared(NAMES_KEY);
    if (action) {
      run(action.name, action.args);
      if (saved && Object.hasOwn(saved, address)) {
        const next = { ...saved };
        delete next[address];
        setShared(NAMES_KEY, next);
      }
      return;
    }
    const next = { ...(saved ?? {}) };
    if (name) next[address] = name;
    else delete next[address];
    setShared(NAMES_KEY, next);
  }

  renameField(t, row, indent) {
    return h_flex().id(`rename-${row.address}`).h(28).flex_none().ml(indent).mr(4).mb(2).pl(8).pr(6).gap(6).rounded(6)
      .bg(t.background).border(1).border_color(t.border).items_center()
      .child(glyph("pencil", 12).text_color(t.muted))
      .child(Input.new(this.renameInput).accessibility_label(`Rename ${row.title}`).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
      .child(div().flex_none().text_size(10).text_color(t.dim).child("Esc cancels"));
  }

  // Closes every session idle for too long (the settings say how long), on a second click.
  cleanUp(t, list) {
    const armed = Date.now() - (this.armedClean ?? 0) < ARMED_MS;
    const n = `${list.length} ${list.length === 1 ? "session" : "sessions"}`;
    const long = { 1: "a day", 3: "3 days", 7: "a week" }[this.cfg.cleanupDays];
    return h_flex().id("clean-up").h(26).flex_none().rounded(6).px(8).gap(8).items_center()
      .role("button").accessibility_label(armed ? `Click again to close ${n}` : `Close ${n} idle for over ${long}`)
      .tooltip(list.slice(0, 8).map(row => row.title).join("\n") + (list.length > 8 ? `\n+${list.length - 8} more` : ""))
      .cursor_pointer().text_size(11.5).text_color(armed ? t.blocked : t.dim).when(armed, el => el.bg(t.blocked + "26"))
      .hover(s => s.bg(armed ? t.blocked + "33" : t.hover).text_color(armed ? t.blocked : t.foreground))
      .on_hover((inside, cx) => { if (!inside && this.armedClean) { this.armedClean = 0; cx.notify(); } })
      .on_click((_e, cx) => {
        if (!armed) this.armedClean = Date.now();
        else if (Date.now() - this.armedClean > DOUBLE_CLICK_MS) {
          this.armedClean = 0;
          for (const row of list) this.close(row);
        }
        cx.notify();
      })
      .child(glyph("x", 13))
      .child(armed ? `Click again to close ${n}` : `Close ${n} idle for over ${long}`);
  }

  // Claude Code sessions that ended: a click starts one again where it left off.
  closedList(t, closed, now) {
    const open = this.closedOpen;
    const heading = h_flex().id("closed").h(HEIGHT.section).flex_none().mt(6).pl(10).pr(8).gap(6).items_center()
      .role("button").accessibility_label(`Recently closed, ${closed.length}, ${open ? "expanded" : "collapsed"}`)
      .cursor_pointer().rounded(5).text_size(10.5).font_medium().hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.closedOpen = !open; store.set("closedOpen", this.closedOpen); cx.notify(); })
      .child(div().text_color(t.muted).child("Recently closed"))
      .child(div().text_color(t.dim).child(String(closed.length)))
      .child(div().flex_1())
      .child(glyph(open ? "chevron-down" : "chevron-right", 10).text_color(t.dim));
    if (!open) return [heading];
    const forget = entry => setShared(CLOSED_KEY, (this.x.shared(CLOSED_KEY) ?? []).filter(other => other.session !== entry.session));
    return [heading, ...closed.map(entry => h_flex().id(`closed-${entry.session}`).h(26).flex_none().rounded(6).pl(8).pr(6).gap(8).items_center()
      .role("button").accessibility_label(`Reopen ${entry.title}`).cursor_pointer().hover(s => s.bg(t.hover))
      .tooltip([`Reopen ${entry.title}`, this.single ? "" : entry.machine ?? "Local", entry.cwd, `claude --resume ${entry.session}`].filter(Boolean).join("\n"))
      .on_click((_e, cx) => {
        const action = resumeAction(entry, this.x.machines(), this.x.spaces(), this.x.focused());
        if (!action) return;
        run(action.name, action.args);
        forget(entry);
        cx.notify();
      })
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(entry.title))
      .when(!this.single && entry.machine != null, el => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(entry.machine)))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(duration(now - entry.at)))
      .child(div().id(`forget-${entry.session}`).size(18).flex_none().rounded(4).flex().items_center().justify_center()
        .role("button").accessibility_label(`Forget ${entry.title}`).tooltip("Forget")
        .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); forget(entry); cx.notify(); }).child(glyph("x", 11))))];
  }

  // Asks Claude how it would arrange the sessions into spaces, and shows what that changes.
  // Nothing moves until Apply.
  organize(answered = () => {}) {
    if (this.plan === "asking") return;
    const rows = this.rows ?? [];
    const { prompt, ids } = organizeBrief(rows, this.x.spaces());
    if (!ids.size) return;
    this.plan = "asking";
    this.skip = new Set();
    // An answer to an asking that was dismissed is dropped.
    const ask = ++this.asks;
    const failed = why => { if (ask !== this.asks) return; this.plan = null; notify({ title: "Could not organize the sessions", body: String(why ?? "").trim().slice(0, 200), level: "warning" }); };
    const cfg = this.cfg;
    const codex = cfg.organizeWith === "codex";
    const who = this.asker = ASKED[cfg.organizeWith];
    const schema = JSON.stringify(ORGANIZE_SCHEMA);
    // Codex is given the latest model of the family chosen, as its own list has it.
    const asking = !codex ? exec("sh", ["-c", ORGANIZE_SH, "sh", ...organizeArgs(cfg), "--json-schema", schema, "--system-prompt", ORGANIZE_SYSTEM, prompt], { on: null, timeout: 120000 })
      : (cfg.organizeCodex === "auto" ? Promise.resolve(null) : readTextFile(`${home()}/.codex/models_cache.json`).then(cache => latestCodex(cache, cfg.organizeCodex)).catch(() => null))
        .then(model => exec("sh", ["-c", CODEX_SH, "sh", schema, ...(model ? ["-m", model] : []), "-c", `model_reasoning_effort="${cfg.organizeEffort}"`, `${ORGANIZE_SYSTEM}\n\n${prompt}`], { on: null, timeout: 180000 }));
    asking.then(result => {
      const answer = organizeAnswer(result.stdout);
      if (ask !== this.asks) return;
      if (result.code !== 0 || !answer) return failed(result.stderr || `${who} gave no answer. Is \`${codex ? "codex" : "claude"}\` installed and signed in on this computer?`);
      const plan = organizePlan(this.rows ?? rows, this.x.spaces(), answer, ids, machine => `${machine == null ? "" : `${machine}/`}sp${hex(32)}`);
      if (plan.renames.length || plan.moves.length) this.plan = plan;
      else { this.plan = null; notify({ title: "Already organized", body: `${who} would leave every session where it is.`, level: "info", timeout: 3000 }); }
    }).catch(failed).finally(() => { this.changed = true; answered(); });
  }

  dismissPlan() {
    this.plan = null;
    this.asks++;
    this.skip = new Set();
  }

  applyPlan() {
    const plan = this.plan;
    this.plan = null;
    if (!plan || plan === "asking") return;
    for (const rename of plan.renames) run("space.rename", { id: rename.id, name: rename.to });
    for (const move of plan.moves) {
      if (this.skip.has(move.address)) continue;
      const row = (this.rows ?? []).find(row => row.address === move.address);
      if (!canMove(row, move.to) || this.pending.some(other => other.address === move.address)) continue;
      this.pending.push({ address: move.address, row, space: move.to, name: move.name, created: move.created, quiet: true, at: Date.now() });
      if (row.pane) run("terminal.park", { terminal: move.address });
    }
  }

  organizeButton(t) {
    const asking = this.plan === "asking";
    const codex = this.cfg.organizeWith === "codex";
    const model = codex ? (this.cfg.organizeCodex === "auto" ? "its own model" : `latest ${this.cfg.organizeCodex}`) : this.cfg.organizeModel;
    const tip = asking ? `Asking ${this.asker}…` : `Organize into spaces with ${ASKED[this.cfg.organizeWith]} (${model}, ${this.cfg.organizeEffort} effort): previews, then asks`;
    return div().id("organize").size(26).flex_none().rounded(6).flex().items_center().justify_center()
      .role("button").accessibility_label(tip).cursor_pointer().text_color(asking ? t.accent : t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { this.organize(); cx.notify(); })
      .child(asking ? glyph("sparkles", 15).loop("opacity", { from: 0.35, to: 1, period: 1200 }) : glyph("sparkles", 15));
  }

  // Over the list while Claude is asked, and while its suggestion is shown: the list below is
  // then the sessions as it would leave them, to apply or dismiss.
  planBanner(t, preview) {
    const button = (id, label, strong, action) => div().id(id).h(22).px(9).flex_none().rounded(5).flex().items_center().text_size(11).font_medium()
      .role("button").accessibility_label(label).cursor_pointer()
      .when(strong, el => el.bg(t.accent).text_color(t.background).hover(s => s.opacity(0.88)))
      .when(!strong, el => el.text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { action(); cx.notify(); }).child(label);
    const dismiss = () => this.dismissPlan();
    const box = v_flex().id("plan").flex_none().mx(2).mb(4).px(9).py(8).gap(5).rounded(6).bg(t.raised).border(1).border_color(t.accent + "55");
    if (!preview) {
      return box.child(h_flex().gap(7).items_center()
        .child(glyph("sparkles", 13).text_color(t.accent).loop("opacity", { from: 0.35, to: 1, period: 1100 }))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().child(`Asking ${this.asker} how to arrange them…`))
        .child(button("plan-dismiss", "Cancel", false, dismiss)));
    }
    const count = (n, one, many) => n ? `${n} ${n === 1 ? one : many}` : "";
    const summary = [count(preview.moved.size, "session moves", "sessions move"), count(preview.created.size, "new space", "new spaces"),
      count(preview.renamed.size, "space renamed", "spaces renamed")].filter(Boolean).join(" · ") || "Nothing would change";
    return box
      .child(h_flex().gap(7).items_center()
        .child(glyph("sparkles", 13).text_color(t.accent))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().child(`${this.asker}'s suggestion, previewed below`)))
      .child(div().text_size(11).text_color(t.muted).child(summary))
      .child(div().text_size(10.5).text_color(t.dim).child("Highlighted sessions would move. Click one to leave it where it is. Nothing changes until you apply; Esc dismisses."))
      .child(h_flex().gap(6).mt(1).items_center()
        .child(button("plan-apply", "Apply", true, () => this.applyPlan()))
        .child(button("plan-dismiss", "Dismiss", false, dismiss)));
  }

  recolor(space) {
    const colors = this.x.shared("space.colors") ?? {};
    const next = SPACE_COLORS[(SPACE_COLORS.indexOf(colors[space] ?? SPACE_COLORS[0]) + 1) % SPACE_COLORS.length];
    setShared("space.colors", { ...colors, [space]: next });
  }

  // Herdr's own menu for a space: Rename, its worktrees, Close (which Herdr confirms).
  spaceMenu(space) {
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: space } } });
  }

  // A press on a row or a space heading that moves onto another element is a drag: a session
  // dragged onto a space moves there; a space dragged onto another takes its place in the order.
  press(drag) {
    // A new press: whatever an earlier drag left behind is over.
    this.dragged = null;
    this.drag = this.moving ? null : { ...drag, over: drag.home, moved: false };
  }

  dragOver(key, cx, e = null) {
    const drag = this.drag;
    if (!drag) return;
    // Released outside the list: not a drag anymore.
    if (e && e.pressed_button !== "left") { this.release(cx); return; }
    if (drag.over === key) return;
    drag.over = key;
    drag.moved = true;
    if (drag.row && !this.moving) this.startMove([drag.row], drag.row.title, drag.row.spaceId, true);
    cx.notify();
  }

  // The release. On a space heading (`section`), or on a session of another space (`onto`):
  // the drop. Anywhere else: the drag is over.
  release(cx, group = null, section = null, onto = null) {
    const drag = this.drag;
    this.drag = null;
    if (!drag?.moved) return;
    // A press that left and came back is no click.
    this.dragged = drag.home;
    const space = section?.space || onto?.spaceId || null;
    if (drag.row && space && (section ? this.isTarget(group, section) : canMove(drag.row, space))) {
      if (!this.moving) this.startMove([drag.row], drag.row.title, drag.row.spaceId, true);
      this.moveTo(space);
    }
    else if (drag.row && this.moving?.dragged) this.moving = null;
    else if (drag.space && space && space !== drag.space && drag.machine === (group.name ?? null)) {
      const index = this.x.spaces().findIndex(other => other.id === space);
      if (index !== -1) run("space.move", { id: drag.space, index: index + 1 });
    }
    cx.notify();
  }

  // A click that ended a drag does nothing.
  clicked(home) {
    const dragged = this.dragged === home;
    this.dragged = null;
    return !dragged;
  }

  isTarget(group, section) {
    const moving = this.moving;
    return Boolean(moving && section.space && section.space !== moving.from && moving.machine === (group.name ?? null));
  }

  // Status, then spaces, then projects, and round again.
  toggleGroup() {
    setShared(GROUP_KEY, GROUPINGS[(GROUPINGS.indexOf(this.groupBy()) + 1) % GROUPINGS.length]);
  }

  groupBy() {
    return GROUPINGS.includes(this.x.shared(GROUP_KEY)) ? this.x.shared(GROUP_KEY) : "status";
  }

  // Sessions of one status working in the same folder, when there are several.
  folderHeading(t, group, section, folder) {
    return h_flex().id(`folder-${group.key}:${section.id}:${folder.key}`).h(20).flex_none().pl(12).pr(8).gap(5).items_center()
      .text_size(10.5).text_color(t.muted).tooltip(folder.path || "No folder")
      .accessibility_label(`${folder.label}, ${folder.sessions} sessions`)
      .child(glyph("folder", 11).text_color(t.dim))
      .child(div().min_w(0).truncate().child(folder.label))
      .child(div().flex_none().text_color(t.dim).child(String(folder.sessions)));
  }

  toggle(key, cx) {
    this.folded.has(key) ? this.folded.delete(key) : this.folded.add(key);
    store.set("folded", [...this.folded]);
    cx.notify();
  }

  isOpen(key) {
    return !this.folded.has(key);
  }

  // An unreachable host is closed until asked for; any other is open until folded.
  hostOpen(group) {
    return isAway(group) ? this.revealed.has(group.key) : this.isOpen(group.key);
  }

  // Settings and Add machine live here, so the sidebar needs no footer.
  extras(t, compact) {
    const add = h_flex().id("add-machine").h(26).flex_none().rounded(6).items_center().gap(8)
      .role("button").accessibility_label("Add machine").tooltip("Connect another machine")
      .cursor_pointer().text_size(11.5).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => run("mod.open", { name: "machine-add" }))
      .child(glyph("plus", 13));
    if (!this.cfg.addMachine) return compact ? [this.settingsButton(t).mt(6).mx_auto()] : [];
    return compact ? [add.mt(6).justify_center(), this.settingsButton(t).mx_auto()]
      : [add.mt(6).px(8).child("Add machine")];
  }

  // A window over the app, from the gear or a key (bind one to agent-sidebar.settings).
  openSettings() {
    openOverlay({ mod: "agent-sidebar", kind: "dialog", width: SETTINGS.width, height: SETTINGS.height, props: { settings: true } });
  }

  // Opens the agent grid (herdr-agent-grid-mod): every agent as a card, over the window.
  gridButton(t) {
    const bound = keys().find(k => k.section === "global" && k.action === "mod.open:agent-grid")?.keys;
    const tip = `All agents as cards${bound ? ` (${keyLabel(bound, window()?.platform === "macos")})` : ""}`;
    return div().id("agent-grid").size(26).flex_none().rounded(6).flex().items_center().justify_center()
      .role("button").accessibility_label(tip)
      .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click(() => run("mod.open", { name: "agent-grid" }))
      .child(glyph("grid", 15));
  }

  // The sidebar's own settings (settings.js), in a window. Herdr's are a click further, inside
  // it; an update that is ready still shows here.
  settingsButton(t) {
    const ready = Boolean(updates().app.ready);
    const tip = ready ? "Sessions settings · Herdr update ready" : "Sessions settings";
    return div().id("settings").relative().size(26).flex_none().rounded(6).flex().items_center().justify_center()
      .role("button").accessibility_label(tip)
      .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click(() => this.openSettings())
      .child(glyph("settings", 15))
      .when(ready, el => el.child(div().absolute().top(5).right(5).size(6).rounded(3).bg(t.accent)));
  }

  // The status mark at the end of a row. Its section header already names the status,
  // so marks stay small; shells and programs get none.
  mark(t, row, section) {
    // A change gets an element of its own: a transition runs from what that element showed last,
    // so reusing the old one would run from the old mark, fully shown, and look like no change.
    const fresh = this.fresh.get(row.address);
    const entering = fresh?.step === 0;
    const box = h_flex().id(`mark-${row.address}-${fresh?.at ?? "settled"}`).relative().w(14).flex_none().items_center().justify_center()
      .opacity(entering ? 0 : 1).left(entering ? 5 : 0)
      .transition("opacity", MARK_IN).transition("left", MARK_IN);
    if (!row.available) return box.tooltip("Unavailable").child(glyph("offline", 11).text_color(t.muted));
    // Under Idle the heading says it: a ring on every row reads as a column of radio buttons.
    if (row.kind !== "agent" && row.status === "idle" || section === "idle" && row.status === "idle" && !row.background.length) return box;
    // Its turn ended, but something it started is still going: say what, quietly pulsing.
    if (row.background.length) return box.tooltip(row.background.map(reason => BACKGROUND[reason]).join(" · "))
      .child(glyph(HOLD[row.background[0]], 12).text_color(t.working).loop("opacity", { from: 0.4, to: 1, period: 1600 }));
    const word = WORDS[row.status];
    if (row.status === "working") return box.tooltip(word).child(glyph("spinner", 12).text_color(t.working).spin(900));
    if (row.status === "blocked") return box.tooltip(word).child(div().size(14).rounded(4).bg(t.blocked + "26")
      .text_size(10).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!"));
    if (row.status === "done") return box.tooltip(word).child(glyph("check", 12).text_color(t.done));
    return box.tooltip(word).child(div().size(7).rounded(4).border(1.5).border_color(row.status === "idle" ? (t.idle ?? t.dim) : t.dim));
  }

  program(t, row, size = 16) {
    const p = row.program;
    if (!p?.icon) return row.kind === "agent" ? glyph("agent", size).text_color(t.muted) : svg("icons/shell.svg").size(size).flex_none().text_color(t.muted);
    return p.tint ? svg(p.icon).size(size).flex_none().text_color(t.foreground)
      : image(p.icon).w(size).h(size).flex_none();
  }

  tip(row, now) {
    // With one machine there is nothing to tell apart.
    const host = this.single ? "" : row.machine == null ? "Local" : `Remote · ${row.machine}`;
    const kind = row.inner ? (row.inBackground ? "Sub-agent, in the background" : "Sub-agent")
      : row.kind === "shell" ? "Shell" : row.kind === "process" ? "Program" : "Agent";
    const context = [...new Set([kind, row.space === row.title ? "" : row.space, !row.inner && row.program?.name].filter(Boolean))].join(" · ");
    const word = !row.background.length ? WORDS[row.status]
      : row.background.some(reason => reason !== "goal") ? "Cooking in the background" : "Goal active";
    const state = !row.available ? "Unavailable" : row.kind === "agent" && row.since ? `${word} · ${duration(now - row.since)}` : word;
    const from = !row.parent ? "" : row.inner ? `Inside ${row.parent}` : `Started from ${row.parent}`;
    const git = this.gitOf(row);
    const changed = git.changes && (git.changes.added || git.changes.removed)
      ? `Uncommitted: +${git.changes.added} −${git.changes.removed} in ${git.changes.files} ${git.changes.files === 1 ? "file" : "files"}` : "";
    const pull = git.pull ? `Pull request #${git.pull.number} · ${git.pull.state}${git.pull.url ? `\n${git.pull.url}` : ""}` : "";
    return [row.title, context, host, state, activityText(row), this.usesText(row), changed, pull, ...backgroundLines(row, now), row.inner ? "" : row.address, row.cwd, from].filter(Boolean).join("\n");
  }

  // What git and GitHub said of the folder a session works in.
  gitOf(row) {
    const state = row.inner || !row.cwd ? null : this.git?.get(row.machine);
    const key = folderKey(row.cwd);
    return { changes: state?.changes.get(key) ?? null, pull: state?.pulls.get(key) ?? null };
  }

  // "+120 −8 #42" after an expanded row's folder: lines changed since the last commit, and the
  // branch's pull request in its state's color.
  gitTag(t, row, parts = this.gitParts(row)) {
    if (!parts.length) return null;
    return h_flex().id(`git-${row.address}`).flex_none().gap(4).items_center().text_size(10.5)
      .children(parts.map(part => div().text_color(t[part.color] ?? t.dim).child(part.text)));
  }

  // Its words and their color keys, so a row can tell how much room they take.
  gitParts(row) {
    const found = this.gitOf(row);
    const changes = this.cfg.changes ? found.changes : null;
    const pull = this.cfg.pulls ? found.pull : null;
    return [
      changes?.added > 0 ? { text: `+${changes.added}`, color: "ansi2" } : null,
      changes?.removed > 0 ? { text: `−${changes.removed}`, color: "ansi1" } : null,
      pull ? { text: `#${pull.number}`, color: PULL_COLOR[pull.state] ?? "dim" } : null,
    ].filter(Boolean);
  }

  // "Opus 5.5 · xhigh effort · 159k context": what the session's last turn ran with, and how
  // much context it was sent, when its machine said.
  usesText(row) {
    const name = modelName(row.model);
    const used = tokens(row.context);
    return name ? [name.label, row.effort ? `${row.effort} effort` : "", used ? `${used} context` : ""].filter(Boolean).join(" · ") : "";
  }

  // The same, at a glance, in words: `label` is the model's name and `context` its tokens, or
  // none where there is no room. The effort is what differs most: a little brighter than the
  // rest, and bolder from xhigh up. Colored by level only when the settings say so, since the
  // list's colors otherwise all mean a status.
  uses(t, row, label, context = "", effort = row.effort ?? "") {
    if (!label && !effort) return null;
    return h_flex().id(`uses-${row.address}`).flex_none().gap(3).items_center().text_size(10.5).text_color(t.dim).tooltip(this.usesText(row))
      .when(Boolean(label), el => el.child(div().child(label)))
      .when(Boolean(label && effort), el => el.child(div().child("·")))
      .when(Boolean(effort), el => el.child(div().id(`effort-${row.address}`).text_color(this.cfg.effortColors ? t[EFFORT_COLOR[effort]] ?? t.muted : t.muted)
        .when(effort === "xhigh", el => el.font_medium()).when(effort === "max", el => el.font_semibold()).child(effort)))
      .when(Boolean(context), el => el.child(div().child("·")).child(div().child(context)));
  }

  // `grouped`: under a folder heading, which already says where it works.
  row(t, entry, section, now, grouped = false) {
    const { row, depth } = entry;
    const expanded = this.expanded;
    const on = row.focused;
    const picked = this.selected === row.address;
    const hovered = this.hovered === row.address && row.available;
    // A sub-agent inside a session has no terminal to pin.
    // In a preview a session that would move says where from, and a click takes it out or back in.
    const leaves = this.preview?.moved.get(row.address);
    const stays = Boolean(this.preview) && this.skip.has(row.address);
    const pinning = hovered && !row.inner && !this.preview;
    const quiet = row.kind === "agent" && (row.status === "idle" || row.status === "unknown") && !on;
    // Where it works: a sub-agent's kind, else its folder. On the second line when expanded;
    // otherwise beside the title, unless a folder heading says it, the title already does, or
    // it doesn't fit: a folder cut to "her…" says nothing. About 6.5 px a character at this
    // size, after icon, age and mark.
    const folder = row.inner ? row.space : row.cwd ? (shortPath(row.cwd) === "~" ? "~" : row.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop()) : "";
    const indent = 8 + depth * 14 + (grouped ? GROUPED_INDENT : 0);
    // Its model and effort, in words. Expanded, on the second line, always: the name in full
    // ("Opus 5.5") where the folder leaves room, else its family, and a folder too long for what
    // is left gives way from its start. Compact, after the title when both fit, else the effort
    // alone, else only in the tooltip; the folder comes after that.
    const cfg = this.cfg;
    const known = cfg.model || cfg.effort ? modelName(row.model) : null;
    // With the model off, the effort stands alone.
    const name = known && (cfg.model ? known : { family: "", label: "" });
    const effort = known && cfg.effort && row.effort ? row.effort : "";
    const px = (Number.isFinite(this.width) ? this.width : WIDE) - 104 - indent;
    const said = label => [label, effort].filter(Boolean).join(" · ");
    // What it is doing or asking, while it works or needs you: in place of the folder, which
    // stays in the tooltip.
    const doing = cfg.activity ? activityText(row) : "";
    const used = cfg.context ? tokens(row.context) : "";
    // Lines changed and the pull request: beside the folder, so not while it gives way to `doing`.
    // On an idle row they are as quiet as its title.
    const changed = expanded && !doing ? this.gitParts(row) : [];
    const git = changed.length ? this.gitTag(t, row, changed).when(quiet, el => el.opacity(0.6)) : null;
    // By project, sessions of several machines share a list: one elsewhere says where.
    const elsewhere = this.byProject && row.machine != null && !row.inner ? row.machine : "";
    let context = "";
    let model = "";
    let shown = Boolean(name);
    let where = row.inner ? row.space : [shortPath(row.cwd), row.branch].filter(Boolean).join(" · ");
    let room = Math.floor(px / 6.5);
    if (expanded && name) {
      const line = Math.floor(px / 5.6);
      // The model gives way first: to what it is doing or asks, said in full, or to the end of
      // its folder, its branch and what it changed. The tooltip keeps it.
      const first = doing || where;
      const least = doing || (row.inner ? where : fitWhere(shortPath(row.cwd), row.branch, 0));
      const tag = changed.length ? changed.map(part => part.text).join(" ").length + 1 : 0;
      model = first.length + tag + said(name.label).length + 2 <= line ? name.label
        : least.length + tag + said(name.family).length + 2 <= line ? name.family : null;
      shown = model !== null;
      context = shown && used && first.length + tag + said(model).length + used.length + 5 <= line ? used : "";
      if (!row.inner && !doing) where = fitWhere(shortPath(row.cwd), row.branch, line - tag - (shown ? said(model).length + 2 : 0));
    } else if (name) {
      const fits = [said(name.family), effort].filter(Boolean).find(text => row.title.length + text.length + 2 <= room);
      shown = Boolean(fits);
      model = fits === effort ? "" : name.family;
      if (fits) room -= fits.length + 2;
    }
    if (expanded && doing) where = doing;
    const detail = expanded ? "" : doing ? (row.title.length + doing.length + 2 <= room ? doing : "")
      : !(grouped && !row.inner) && folder && !row.title.toLowerCase().includes(folder.toLowerCase())
        && row.title.length + folder.length + 2 <= room ? folder : "";
    const uses = shown ? this.uses(t, row, model, context, effort) : null;
    const tip = this.tip(row, now);
    const pin = div().id(`pin-${row.address}`).size(18).flex_none().rounded(4).flex().items_center().justify_center()
      .role("button").accessibility_label(row.pinned ? `Unpin ${row.title}` : `Pin ${row.title}`)
      .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(row.pinned ? "Unpin" : "Pin: keep it above idle sessions")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run("terminal.pin", { terminal: row.address, pinned: !row.pinned });
        // The row moves away from under the pointer, and no hover-out comes.
        this.hovered = null;
        cx.notify();
      })
      .child(glyph(row.pinned ? "pin-off" : "pin", 12));
    // Another session where this one works: the launcher, with its folder picked.
    const here = div().id(`here-${row.address}`).size(18).flex_none().rounded(4).flex().items_center().justify_center()
      .role("button").accessibility_label(`New session in ${row.cwd}`)
      .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip("New shell or agent in this folder")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.launch(row.machine, { folder: row.cwd, tag: "This session" });
        this.hovered = null;
        cx.notify();
      })
      .child(glyph("plus", 13));
    // A message to it, typed in a field that opens under the row.
    const reply = div().id(`reply-to-${row.address}`).size(18).flex_none().rounded(4).flex().items_center().justify_center()
      .role("button").accessibility_label(`Send a message to ${row.title}`)
      .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Send it a message")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (this.renaming) { this.renaming = null; this.renameInput.set_value(""); }
        this.replying = row.address;
        this.reply.set_value("");
        this.reply.focus();
        this.hovered = null;
        cx.notify();
      })
      .child(glyph("reply", 12));
    // Rename the session, typed in a field that opens under the row.
    const rename = div().id(`rename-to-${row.address}`).size(18).flex_none().rounded(4).flex().items_center().justify_center()
      .role("button").accessibility_label(`Rename ${row.title}`)
      .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Rename")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.startRename(row);
        this.hovered = null;
        cx.notify();
      })
      .child(glyph("pencil", 12));
    // To another space: every space it can go to then takes the click.
    const others = movable(row) && this.x.spaces().filter(space => (space.machine ?? null) === row.machine && space.id !== row.spaceId).length > 0;
    const move = div().id(`move-${row.address}`).size(18).flex_none().rounded(4).flex().items_center().justify_center()
      .role("button").accessibility_label(`Move ${row.title} to another space`)
      .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Move to another space · or drag it onto one")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.startMove([row], row.title, row.spaceId);
        this.hovered = null;
        cx.notify();
      })
      .child(glyph("move", 12));
    // Closing takes two deliberate clicks: the first turns ✕ into a red Close, the second closes.
    // A stray click, or a double click, on a row's right end never ends a session.
    const armed = this.armed?.address === row.address && Date.now() - this.armed.at < ARMED_MS;
    const close = div().id(`close-${row.address}`).h(18).flex_none().rounded(4).flex().items_center().justify_center()
      .role("button").accessibility_label(armed ? `Click again to close ${row.title}` : `Close ${row.title}`)
      .cursor_pointer().tooltip(armed ? "Click again to close" : "Close")
      .when(armed, el => el.px(6).bg(t.blocked + "26").text_color(t.blocked).text_size(10.5).font_medium().child("Close"))
      .when(!armed, el => el.w(18).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).child(glyph("x", 12)))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (!armed) this.armed = { address: row.address, at: Date.now() };
        else if (Date.now() - this.armed.at > DOUBLE_CLICK_MS) {
          this.armed = null;
          this.hovered = null;
          this.close(row);
        }
        cx.notify();
      });
    const age = cfg.age && row.kind === "agent" && row.since && row.available ? duration(now - row.since) : "";
    // An open /goal, unless the mark already says so.
    const goal = Boolean(row.goal) && row.background[0] !== "goal" && !pinning;
    // Fresh news: a wash of its color, drawn under the row's content, fading out.
    const fresh = this.fresh.get(row.address);
    const tint = fresh && NEWS.has(fresh.to) && t[fresh.to]
      ? div().id(`tint-${row.address}-${fresh.at}`).absolute().inset_0().rounded(6).bg(t[fresh.to] + "24")
        .opacity(fresh.step === 0 ? 1 : 0).transition("opacity", TINT_OUT)
      : null;
    const title = div().min_w(0).truncate().text_size(12.5)
      .text_color(quiet || !row.available ? t.muted : t.foreground)
      .when(on, el => el.font_medium()).child(row.title);
    const text = expanded
      ? v_flex().flex_1().min_w(0).gap(1)
        .child(title)
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(doing ? t.muted : t.dim).child([elsewhere, where].filter(Boolean).join(" · ") || " "))
          .when(Boolean(git), el => el.child(git))
          .when(Boolean(uses), el => el.child(uses)))
      : h_flex().flex_1().min_w(0).gap(5).items_center()
        .child(title)
        .when(Boolean(detail), el => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(detail)));
    return h_flex().id(`agent-${row.address}`).h(expanded ? ROW.expanded : ROW.compact).flex_none().min_w(0)
      .role("list_box_option").aria_selected(on || picked).accessibility_label(tip)
      .relative().rounded(6)
      .pl(indent).pr(6).gap(8).items_center()
      .when(row.available, el => el.cursor_pointer())
      .when(on || picked, el => el.bg(t.selected))
      .when(!on && !picked, el => el.hover(s => s.bg(t.hover)))
      .on_hover((inside, cx) => {
        if (inside) this.hovered = row.address;
        else if (this.hovered === row.address) this.hovered = null;
        if (!inside && this.armed?.address === row.address) this.armed = null;
        cx.notify();
      })
      .tooltip(leaves !== undefined ? `Would move here from ${leaves} · click to leave it there` : stays ? "Stays where it is · click to move it after all" : tip)
      .on_click((_e, cx) => {
        if (!this.clicked(`row:${row.address}`)) return;
        if (leaves !== undefined) this.skip.add(row.address);
        else if (stays) this.skip.delete(row.address);
        else return this.open(row);
        cx?.notify?.();
      })
      .when(leaves !== undefined, el => el.bg(t.accent + "22"))
      .when(movable(row) && !this.preview, el => el.on_mouse_down("left", () => this.press({ row, home: `row:${row.address}` })))
      .on_mouse_move((e, cx) => this.dragOver(`row:${row.address}`, cx, e))
      .on_mouse_up("left", (_e, cx) => this.release(cx, null, null, row))
      .when(this.moving?.addresses.includes(row.address) || this.pending.some(move => move.address === row.address), el => el.opacity(0.5))
      .when(Boolean(tint), el => el.child(tint))
      // One line joins a session's sub-agents: down from under its icon, with a branch to each
      // one's icon and a rounded corner at the last.
      .when(depth > 0, el => {
        const high = expanded ? ROW.expanded : ROW.compact;
        const arm = expanded ? 4 : 5;
        const color = t.dim + "80";
        const at = d => indent - (depth - d) * 14 - (expanded ? 5 : 6);
        const x = at(depth);
        for (const d of entry.rails ?? []) el = el.child(div().absolute().left(at(d)).top(0).w(1).h(high).bg(color));
        if (entry.last) return el.child(div().absolute().left(x).top(0).w(arm).h(high / 2 + 0.5).border_l(1).border_b(1).rounded_bl(6).border_color(color));
        return el
          .child(div().absolute().left(x).top(0).w(1).h(high).bg(color))
          .child(div().absolute().left(x + 1).top(high / 2 - 0.5).w(arm - 1).h(1).bg(color));
      })
      // Idle, its icon steps back with its title: the bright ones are the sessions that matter now.
      .child(this.program(t, row, expanded ? 18 : 16).when(quiet || !row.available, el => el.opacity(0.5)))
      .child(text)
      .when(row.pinned && section !== "pinned" && !pinning, el => el.child(glyph("pin", 11).text_color(t.dim)))
      .when(goal, el => el.child(div().id(`goal-${row.address}`).flex_none().tooltip(`Goal: ${row.goal.condition}`)
        .child(glyph("goal", 11).text_color(t.dim))))
      .when(pinning, el => el.child(h_flex().flex_none().gap(2).items_center()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .when(!armed && canReply(row), el => el.child(reply))
        .when(!armed && canRename(row), el => el.child(rename))
        .when(!armed && others, el => el.child(move))
        .when(!armed && Boolean(row.cwd), el => el.child(here))
        .when(!armed, el => el.child(pin))
        .child(close)))
      .when(!expanded && !pinning && Boolean(elsewhere), el => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(elsewhere)))
      .when(leaves !== undefined, el => el.child(div().id(`moves-${row.address}`).flex_none().max_w(110).truncate().text_size(10.5).text_color(t.accent).child(`from ${leaves}`)))
      .when(stays, el => el.child(div().id(`stays-${row.address}`).flex_none().text_size(10.5).text_color(t.dim).child("stays")))
      .when(!expanded && !pinning && Boolean(uses) && leaves === undefined && !stays, el => el.child(uses))
      .when(!pinning && Boolean(age), el => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(age)))
      .child(this.mark(t, row, section));
  }

  railRow(t, row) {
    const color = !row.available ? t.dim : row.kind !== "agent" && row.status === "idle" ? null : t[row.status] ?? t.dim;
    return h_flex().id(`agent-${row.address}`).h(28).flex_none().rounded(6).px(6).gap(4).items_center().justify_center()
      .role("list_box_option").aria_selected(row.focused).accessibility_label(this.tip(row, Date.now()))
      .when(row.available, el => el.cursor_pointer())
      .when(row.focused, el => el.bg(t.selected)).when(!row.focused, el => el.hover(s => s.bg(t.hover)))
      .tooltip(this.tip(row, Date.now())).on_click(() => this.open(row))
      .child(this.program(t, row, 17))
      .child(div().size(5).rounded(3).when(Boolean(color), el => el.bg(color))
        .when(row.background.length > 0, el => el.loop("opacity", { from: 0.4, to: 1, period: 1600 })));
  }

  // A status heading wears the mark its sessions' rows do: the spinner for Cooking, the check
  // for Done, the ! for Needs you; Pinned a pin and Idle the ring.
  sectionMark(t, id) {
    if (id === "working") return glyph("spinner", 11).spin(900);
    if (id === "done") return glyph("check", 11);
    if (id === "blocked") return div().size(13).rounded(4).bg(t.blocked + "26").text_size(9.5).font_bold()
      .flex().items_center().justify_center().child("!");
    if (id === "pinned") return glyph("pin", 11);
    return div().size(7).rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  }

  // A section's heading is a quiet label: a mark carries the status's color, so the colors in
  // the list are the sessions' own marks. Its chevron shows while it is folded or pointed at.
  // `first`: the first under its machine, with no space above it.
  section(t, group, section, first = true) {
    const key = `${group.key}:${section.id}`;
    const open = this.isOpen(key);
    // A status's section (Needs you leads whatever the grouping): its status's mark, in its
    // color. Not a space's or a project's.
    const byStatus = !/^(space|project):/.test(section.id);
    const pointed = this.hoveredSection === key;
    // Sessions: a session's own sub-agents are part of it.
    const n = section.entries.filter(entry => !entry.row.inner).length;
    // One of Herdr's spaces (not "No space"): it has Herdr's color, and things to do with it.
    const space = section.space || null;
    const dot = space ? t[this.x.shared("space.colors")?.[space] ?? SPACE_COLORS[0]] : null;
    // While sessions are being moved, a space they can go to says so and takes the click.
    const target = this.isTarget(group, section);
    const hovered = this.hoveredSection === key && Boolean(space) && !this.moving && !this.preview;
    const fresh = this.preview?.created.has(space) ? "new" : this.preview?.renamed.has(space) ? `was ${this.preview.renamed.get(space)}` : "";
    const act = (id, icon, tip, action) => div().id(`${id}-${key}`).size(18).flex_none().rounded(4).flex().items_center().justify_center()
      .role("button").accessibility_label(`${tip}: ${section.label}`).cursor_pointer().text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.hoveredSection = null; action(); cx.notify(); })
      .child(glyph(icon, 12));
    const rows = section.entries.map(entry => entry.row);
    return h_flex().id(`section-${key}`).h(HEIGHT.section).flex_none().pl(10).pr(8).gap(6).items_center()
      .when(!first, el => el.mt(HEIGHT.sectionGap))
      .role("button").accessibility_label(target ? `Move ${this.moving.title} to ${section.label}`
        : `${section.label}, ${n} ${n === 1 ? "session" : "sessions"}, ${open ? "expanded" : "collapsed"}`)
      .cursor_pointer().rounded(5).text_size(10.5).font_medium()
      .when(target, el => el.bg(t.selected).tooltip(`Move ${this.moving.title} here`))
      .when(Boolean(space) && !target, el => el.tooltip("Double-click to rename · right-click for more · drag to reorder"))
      .hover(s => s.bg(t.hover))
      .on_hover((inside, cx) => {
        if (inside) this.hoveredSection = key;
        else if (this.hoveredSection === key) this.hoveredSection = null;
        cx.notify();
      })
      .on_click((e, cx) => {
        if (!this.clicked(`section:${key}`)) return;
        if (target) { this.moveTo(space); cx.notify(); return; }
        // The second click of a double one: the first folded it, this unfolds it again.
        if (space && e?.click_count === 2 && !this.preview) run("space.rename", { id: space });
        this.toggle(key, cx);
      })
      .when(Boolean(space) && !this.preview, el => el
        .on_mouse_down("right", () => this.spaceMenu(space))
        .on_mouse_down("left", () => this.press({ space, machine: group.name ?? null, home: `section:${key}` })))
      .on_mouse_move((e, cx) => this.dragOver(`section:${key}`, cx, e))
      .on_mouse_up("left", (_e, cx) => this.release(cx, group, section))
      .when(Boolean(dot), el => el.child(div().id(`color-${key}`).size(8).flex_none().rounded(4).bg(dot).cursor_pointer().tooltip("Change color")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); if (!this.preview) this.recolor(space); cx.notify(); })))
      .when(byStatus, el => el.child(div().id(`status-${key}`).size(14).flex_none().flex().items_center().justify_center()
        .text_color(section.status ? t[section.status] : t.dim).child(this.sectionMark(t, section.id))))
      .child(div().min_w(0).truncate().text_color(target ? t.foreground : t.muted).child(section.label))
      .child(div().flex_none().text_color(t.dim).child(String(n)))
      .when(Boolean(fresh), el => el.child(div().id(`fresh-${key}`).flex_none().max_w(120).truncate().px(4).rounded(4).bg(t.accent + "22").text_size(9.5).text_color(t.accent).child(fresh)))
      .child(div().flex_1())
      .when(target, el => el.child(div().flex_none().text_size(10).text_color(t.accent).child("Move here")))
      .when((section.space !== undefined || section.project) && !open && !target && !hovered, el => el.children(this.summary(t, { rows })))
      .when(hovered, el => el
        .child(act("space-new", "plus", "New shell or agent in this space", () => this.launch(group.name ?? null, { space })))
        .when(n > 0 && this.x.spaces().some(other => (other.machine ?? null) === (group.name ?? null) && other.id !== space),
          el => el.child(act("space-merge", "merge", "Move all its sessions to another space", () => this.startMove(rows, `all of ${section.label}`, space))))
        .child(act("space-more", "more", "Rename, worktrees, close", () => this.spaceMenu(space))))
      .when(!hovered && (!open || pointed), el => el.child(glyph(open ? "chevron-down" : "chevron-right", 10).text_color(t.dim)));
  }

  // What a folded host holds, by urgency: "! 2  ◌ 3  ✓ 1".
  summary(t, group) {
    const tally = counts(group.rows);
    const item = (status, mark) => tally[status] ? h_flex().flex_none().gap(3).items_center().text_size(10).text_color(t[status])
      .tooltip(`${tally[status]} ${WORDS[status].toLowerCase()}`).child(mark).child(String(tally[status])) : null;
    return [
      item("blocked", glyph("attention", 11)),
      item("working", glyph("spinner", 11)),
      item("done", glyph("check", 11)),
    ].filter(Boolean);
  }

  // A machine's +: the launcher for a shell or an agent there.
  newButton(t, group, size = 22) {
    const state = hostState(group);
    return div().id(`new-${group.key}`).size(size).flex_none().rounded(5).flex().items_center().justify_center()
      .role("button").accessibility_label(`New session on ${group.label}`)
      .text_color(state ? t.dim : t.muted).tooltip(state ? `Cannot start a session: ${state}` : `New shell or agent on ${group.label}`)
      .when(!state, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.launch(group.name ?? null);
      }).child(glyph("plus", 14));
  }

  // `firstAway`: the first of the unreachable hosts, which sit together after the others.
  host(t, group, compact, first, firstAway) {
    const open = this.hostOpen(group);
    if (isAway(group)) return this.away(t, group, compact, open, firstAway && !first);
    const color = group.remote ? t.ansi4 : t.accent;
    const state = hostState(group);
    const add = this.newButton(t, group);
    const space = this.bySpace && !state ? this.newSpaceButton(t, group) : null;
    const kind = this.x.shared(KINDS_KEY)?.[group.name ?? ""];
    const icon = KIND_ICON[kind] ?? (group.remote ? "server" : "computer");
    const reading = this.statsOf(group);
    const busy = reading ? statsText(reading) : "";
    const label = `${group.remote ? "Remote" : "Local"} host ${group.label}, ${counts(group.rows).all} sessions${state ? `, ${state}` : ""}${busy ? `, ${busy}` : ""}, ${open ? "expanded" : "collapsed"}`;
    const root = h_flex().id(`host-${group.key}`).flex_none().items_center()
      .role("button").accessibility_label(label).cursor_pointer()
      .tooltip(`${group.remote ? "Remote host" : "Local machine"}: ${group.label}${KIND_ICON[kind] ? ` · ${kind}` : ""}${state ? ` · ${state}` : ""}${busy ? `\n${busy}` : ""}`)
      .on_click((_e, cx) => this.toggle(group.key, cx));
    if (compact) return root.flex_col().py(3).gap(2).justify_center().when(!first, el => el.mt(4).border_t(1).border_color(t.border))
      .child(glyph(icon, 14).text_color(color)).child(add);
    const summary = open ? [] : this.summary(t, group);
    // The figures take the room the name leaves, and go when there is too little (the tooltip
    // keeps them). Roughly: the padding, chevron and icon; the name and its tag; the summary,
    // count and buttons at the end.
    const room = this.width - 12 - 50 - Math.ceil(group.label.length * 7) - (group.remote ? 18 : 0)
      - summary.length * 30 - 60 - (space ? 30 : 0) - 8;
    const shown = reading ? statFigures(reading).slice(0, Math.max(0, Math.floor((room + STAT_GAP) / (STAT_WIDTH + STAT_GAP)))) : [];
    const tones = [t.muted, t.ansi3 ?? t.working, t.ansi1 ?? t.blocked];
    // Grouped by space, a machine's heading also starts a new space there. The machine is the
    // list's top level: larger than the sessions under it, and a line apart from the one above.
    return root.h(HEIGHT.host + (state ? HEIGHT.hostState : 0)).px(8).gap(8).rounded(6)
      .when(!first, el => el.mt(HEIGHT.hostGap).relative().child(this.divider(t)))
      .hover(s => s.bg(t.hover))
      .child(glyph(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))
      .child(glyph(icon, 15).text_color(color))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().min_w(0).truncate().font_semibold().text_size(13.5).text_color(t.foreground).child(group.label))
          .when(group.remote, el => el.child(remoteMark(color, group.key)))
          .when(shown.length > 0, el => el.child(h_flex().id(`stats-${group.key}`).flex_none().ml(2).gap(STAT_GAP).items_center().tooltip(busy)
            .children(shown.map(f => h_flex().id(`stat-${group.key}-${f.key}`).flex_none().gap(3).items_center()
              .child(glyph(f.key, 11).text_color(f.level ? tones[f.level] : t.dim))
              .child(div().min_w(19).text_size(10).text_color(tones[f.level]).child(f.text)))))))
        .when(Boolean(state), el => el.child(div().text_size(10).text_color(group.layout === "loading" ? t.muted : t.blocked).child(state))))
      .children(summary)
      .child(div().flex_none().min_w(14).text_size(10.5).text_color(t.muted).text_right().child(String(counts(group.rows).all)))
      .when(Boolean(space), el => el.child(space))
      .child(add);
  }

  // A hairline in the middle of the space above a machine's heading.
  divider(t) {
    return div().absolute().top(-HEIGHT.hostGap / 2 - 1).left(8).right(8).h(1).bg(t.border);
  }

  // The machine's last reading, while the figures are on and it is fresh.
  statsOf(group) {
    const reading = this.cfg.stats ? this.stats.get(group.name ?? null)?.reading : null;
    return reading && Date.now() - reading.at <= STATS_STALE_MS ? reading : null;
  }

  newSpaceButton(t, group, size = 22) {
    return div().id(`new-space-${group.key}`).size(size).flex_none().rounded(5).flex().items_center().justify_center()
      .role("button").accessibility_label(`New space on ${group.label}`).tooltip(`New space on ${group.label}`)
      .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: group.name ?? "" }); })
      .child(glyph("space-plus", size > 22 ? 15 : 14));
  }

  // An unreachable host: nothing can be opened or started there, so it gets one dim line. A
  // click shows the sessions it had when it was last seen.
  away(t, group, compact, open, gap) {
    const n = counts(group.rows).all;
    const had = n ? `${n} ${n === 1 ? "session" : "sessions"} when last seen` : "no sessions when last seen";
    const root = h_flex().id(`host-${group.key}`).flex_none().items_center().rounded(6)
      .role("button").accessibility_label(`Remote host ${group.label}, unavailable, ${had}, ${open ? "expanded" : "collapsed"}`)
      .cursor_pointer().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.muted))
      .tooltip(`${group.label} is unavailable · ${had}${n ? ` · click to ${open ? "hide" : "show"} them` : ""}`)
      .on_click((_e, cx) => {
        this.revealed.has(group.key) ? this.revealed.delete(group.key) : this.revealed.add(group.key);
        cx.notify();
      });
    if (compact) return root.h(22).justify_center().when(gap, el => el.mt(4)).child(glyph("offline", 12));
    return root.h(HEIGHT.away).px(8).gap(8).when(gap, el => el.mt(HEIGHT.hostGap).relative().child(this.divider(t)))
      .child(glyph(open ? "chevron-down" : "chevron-right", 11))
      .child(glyph("offline", 13))
      .child(div().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(group.label))
      .child(div().flex_none().text_size(10).child("Unavailable"))
      .child(div().flex_1())
      .when(n > 0, el => el.child(div().flex_none().text_size(10.5).child(String(n))));
  }

  render() {
    if (this.launcher) return renderLauncher(this);
    if (this.panel) return renderSettings(this);
    const cfg = this.cfg = settingsOf(this.x.shared(SETTINGS_KEY));
    const t = /** @type {Record<string, import("gpui-kit").Color>} */ (theme());
    const hosts = this.x.machines();
    const now = Date.now();
    const shownPanes = this.x.panes();
    const placed = new Set(shownPanes.filter(pane => pane.terminal).map(pane => pane.terminal));
    const built = build({ agents: this.x.agents(), terminals: this.x.terminals(), panes: shownPanes, spaces: this.x.spaces(), machines: hosts, focused: this.x.focused(), work: this.work, names: this.x.shared(NAMES_KEY) ?? {}, now });
    for (const address of this.parked) if (placed.has(address) || !built.some(row => row.address === address)) this.parked.delete(address);
    const staying = new Set([...this.pending.map(move => move.address), ...this.parked]);
    const all = holdDone(dropLeaving(built, this.leaving, this.placed, placed, now, staying), this.shown ?? new Map());
    this.placed = placed;
    this.notice(all, now);
    if (!cfg.animations) this.fresh.clear();
    // Background work starts or ends when an agent's status changes: ask its machine again.
    const reported = new Map();
    for (const row of all) {
      if (row.kind === "agent" && !row.inner) reported.set(row.machine, `${reported.get(row.machine) ?? ""} ${row.address}:${row.reported}:${row.pid}`);
    }
    for (const [machine, key] of reported) if (this.reported?.get(machine) !== key) this.stale.add(machine);
    this.reported = reported;
    this.rows = all;
    // Sessions whose terminal is gone from a machine that answers have ended: kept to reopen.
    const gone = ended(this.known, new Set(this.x.terminals().filter(terminal => terminal.state === "live").map(terminal => terminal.address)),
      new Set(hosts.filter(host => host.layout === "ready").map(host => host.name ?? null)));
    if (gone.length) setShared(CLOSED_KEY, gone.reduce((list, seen) => remember(list, seen, now), this.x.shared(CLOSED_KEY) ?? []));
    for (const row of all) if (row.kind === "agent" && !row.inner && row.available && row.session) this.known.set(row.address, { title: row.title, cwd: row.cwd, machine: row.machine, session: row.session });
    if (this.replying && !canReply(all.find(row => row.address === this.replying))) this.replying = null;
    if (this.renaming && !canRename(all.find(row => row.address === this.renaming))) this.renaming = null;
    // What the settings leave out of the list is still there: a sub-agent still holds its session
    // in Working, and a shell is still found by its address.
    const listed = cfg.subagents && cfg.shells ? all : all.filter(row => (cfg.subagents || !row.inner) && (cfg.shells || row.kind === "agent"));
    const tally = counts(listed);
    // Sessions move between spaces, so choosing where shows the spaces whatever the grouping.
    if (this.moving && !this.moving.addresses.some(address => all.some(row => row.address === address))) this.moving = null;
    // Claude's suggestion is looked at as the spaces it would make: the same list, as it would be.
    const preview = this.plan && this.plan !== "asking" ? previewOf(listed, this.x.spaces(), this.plan, this.skip) : null;
    this.preview = preview;
    this.bySpace = this.groupBy() === "space" || Boolean(this.moving) || Boolean(preview);
    this.byProject = !this.bySpace && this.groupBy() === "project";
    const sections = groups(preview ? preview.rows : listed, hosts, this.bySpace ? "space" : this.byProject ? "project" : "status", preview ? preview.spaces : this.x.spaces())
      .filter(group => cfg.away || !isAway(group));
    const compact = this.width < RAIL;
    this.expanded = this.x.shared(DENSITY_KEY) === "expanded";
    // Only this computer: no host heading, which would only repeat it. Its + moves to the title bar.
    this.single = !hosts.some(host => host.name != null);
    // The machines whose heading shows, for askStats: their figures go beside the name, or only
    // into its tooltip when the name leaves no room.
    this.headed = this.single || compact ? [] : sections.filter(group => !group.flat && !isAway(group) && group.layout === "ready").map(group => group.name ?? null);
    const local = { layout: "loading", ...hosts.find(host => host.name == null), name: null, key: "local", label: "Local" };
    this.visible = [];
    this.positions = new Map();
    const children = [];
    // What each child is and how tall, for the slides.
    const keys = [];
    const heights = [];
    const push = (node, key = null, height = 0) => {
      children.push(node);
      keys.push(key);
      heights.push(height);
    };
    const rowHeight = compact ? ROW.compact : this.expanded ? ROW.expanded : ROW.compact;
    const add = (row, node) => {
      this.positions.set(row.address, children.length);
      this.visible.push(row);
      push(node, `row:${row.address}`, rowHeight);
      if (this.replying === row.address && !compact) push(this.replyField(t, row, 30), `reply:${row.address}`, 30);
      if (this.renaming === row.address && !compact) push(this.renameField(t, row, 30), `rename:${row.address}`, 30);
    };
    // While a space is being chosen: what is moving, and the way out.
    if (this.moving && !compact) push(h_flex().id("moving").h(26).flex_none().mx(2).mb(2).px(8).gap(6).rounded(6).bg(t.raised).items_center().text_size(11)
      .child(glyph("move", 12).text_color(t.accent))
      .child(div().flex_1().min_w(0).truncate().child(`Move ${this.moving.title} to…`))
      .child(div().id("moving-cancel").flex_none().px(5).h(18).rounded(4).flex().items_center().text_size(10.5).text_color(t.muted)
        .role("button").accessibility_label("Cancel the move").cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Cancel · Esc")
        .on_click((_e, cx) => { this.moving = null; cx.notify(); }).child("Cancel")), "moving", 28);
    if (this.plan && !compact) push(this.planBanner(t, preview), "plan", preview ? 108 : 40);
    if (this.single && compact) push(h_flex().h(30).flex_none().justify_center().items_center().child(this.newButton(t, local)));
    const firstAway = sections.findIndex(isAway);
    sections.forEach((group, i) => {
      // By project there is one list for every machine, under no heading.
      const headed = !this.single && !group.flat;
      if (headed) push(this.host(t, group, compact, i === 0, i === firstAway), `host:${group.key}`, hostHeight(group, i === 0, i === firstAway));
      // A host folded back when there were several must not hide everything now.
      if (headed && !this.hostOpen(group)) return;
      if (compact) {
        // Sub-agents stay in their session's tooltip: in a rail they would pass for sessions.
        for (const row of group.rows) if (!row.inner) add(row, this.railRow(t, row));
        return;
      }
      for (const [j, section] of group.sections.entries()) {
        push(this.section(t, group, section, j === 0), `section:${group.key}:${section.id}`, HEIGHT.section + (j ? HEIGHT.sectionGap : 0));
        // A folded section still shows the session you are in: clicking a session that is done
        // makes it idle, and it must not vanish into a folded Idle.
        const open = this.isOpen(`${group.key}:${section.id}`);
        for (const folder of section.folders) {
          // A heading only gathers: one session's folder is on its own row. Sessions with no
          // folder known are not a folder. Expanded, every row's second line names its folder, so
          // the sessions still sit together but under no heading.
          // Nor grouped by space: a space is the grouping.
          const grouped = cfg.folders && open && !this.expanded && !this.bySpace && !this.byProject && Boolean(folder.key) && folder.sessions > 1;
          if (grouped) push(this.folderHeading(t, group, section, folder), `folder:${group.key}:${section.id}:${folder.key}`, HEIGHT.folder);
          for (const entry of folder.entries) if (open || entry.row.focused) add(entry.row, this.row(t, entry, section.id, now, grouped));
        }
      }
      if (!group.rows.length) push(div().pl(headed ? 29 : 10).pr(12).pt(1).pb(5).text_size(11).text_color(t.muted)
        .child(group.layout === "ready" ? "No sessions yet · use + to start one" : group.layout === "loading" ? "Loading sessions…" : "Sessions appear when this host reconnects"), `empty:${group.key}`, HEIGHT.empty);
    });
    this.slide(t, children, keys, heights, compact, now);
    children.push(...this.extras(t, compact));
    if (!compact) {
      // Under everything, and only when there is something to close, or to reopen.
      const old = cfg.cleanup ? stale(all, now, cfg.cleanupDays * STALE_SESSION_MS) : [];
      if (old.length) children.push(this.cleanUp(t, old));
      const closed = (this.x.shared(CLOSED_KEY) ?? []).filter(entry => !all.some(row => row.session === entry.session)
        && hosts.some(host => (host.name ?? null) === (entry.machine ?? null)));
      if (cfg.closed && closed.length) children.push(...this.closedList(t, closed, now));
    }
    setAgentOrder(this.visible.filter(r => r.kind === "agent" && !r.inner).map(r => r.address));
    // Drawn at their start: the next frame draws them at their end.
    let started = false;
    for (const change of [...this.fresh.values(), ...this.moves.values()]) if (change.step === 0) { change.step = 1; started = true; }
    if (started) this.pulse?.();
    const fold = sidebarButton("agent-sidebar", this.width, { expandId: "expand-agents" });
    return v_flex().id("agent-sidebar").size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .track_focus(this.handle)
      .on_mouse_up("left", (_e, cx) => this.release(cx))
      .on_size_change((size, cx) => {
        const width = size.width / Number(settings().zoom ?? 1);
        if (this.width !== width) { this.width = width; cx.notify(); }
      })
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          // Out of a move; else back to the current session.
          this.selected = null;
          if (this.renaming) { this.renaming = null; this.renameInput.set_value(""); }
          else if (this.replying) { this.replying = null; this.reply.set_value(""); }
          else if (this.plan) this.dismissPlan();
          else if (this.moving) this.moving = null;
          else this.open(this.visible.find(r => r.focused));
        } else if (this.replying || this.renaming) {
          // Every other key is the field's.
          return;
        } else if (e.key === "enter") {
          const row = this.visible.find(r => r.address === this.selected);
          if (!row) return;
          this.open(row);
        } else if (e.key === "f2") {
          const row = this.visible.find(r => r.address === this.selected);
          if (!canRename(row)) return;
          this.startRename(row);
        } else if (e.key === "down" || e.key === "up") {
          if (!this.visible.length) return;
          const current = this.visible.findIndex(r => r.address === this.selected);
          const index = current < 0 ? (e.key === "down" ? 0 : this.visible.length - 1)
            : (current + (e.key === "down" ? 1 : -1) + this.visible.length) % this.visible.length;
          this.selected = this.visible[index].address;
          this.scroll.scroll_to_item(this.positions.get(this.selected));
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      .when(!compact, el => el
        // Narrow, the buttons keep their room: the title gives way, and under 270 px the count goes.
        .child(h_flex().id("sessions-header").h(34).flex_none().pl(16).pr(10).gap(4).items_center()
          .child(div().min_w(0).truncate().font_semibold().text_size(14).child("Sessions"))
          .when(this.width >= 270, el => el.child(div().id("sessions-count").flex_none().ml(2).text_size(11.5).text_color(t.muted).child(String(tally.all))))
          .child(div().flex_1())
          .when(this.single && this.bySpace, el => el.child(this.newSpaceButton(t, local, 26)))
          .when(this.single || this.byProject, el => el.child(this.newButton(t, local, 26)))
          .when(this.cfg.organize, el => el.child(this.organizeButton(t)))
          .when(this.grid, el => el.child(this.gridButton(t)))
          .child(this.settingsButton(t))
          .when(fold, el => el.child(fold))))
      .when(compact && fold, el => el.child(h_flex().h(32).flex_none().justify_center().items_center().child(fold)))
      .child(v_flex().id("host-agent-list").flex_1().min_h(0).px(compact ? 2 : 6).pt(compact ? 0 : 2).pb(12).overflow_y_scrollbar().track_scroll(this.scroll)
        .role("list_box").accessibility_label(`Sessions grouped by ${this.single || this.byProject ? "" : "machine, then by "}${this.bySpace ? "space" : this.byProject ? "project" : "status"}`)
        .children(children));
  }
}
