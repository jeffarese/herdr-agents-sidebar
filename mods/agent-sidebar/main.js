import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { agents, terminals, panes, spaces, machines, focused, theme, settings, run, hc, notify, setAgentOrder, nextCommand, openOverlay, props, shared, setShared, updates, exec, pickFolder } from "herdr";
import { build, groups, counts, WORDS, BACKGROUND, modelName, fitWhere, activityText, tokens, canMove, moveArgs, canReply, stale, ended, remember, resumeAction, organizeBrief, organizePlan, ORGANIZE_SYSTEM, ORGANIZE_SCHEMA, openAction, closeAction, duration, backgroundLines, machineOf, shortPath, holdDone, dropLeaving } from "./model.js";
import { PROBE, PROBE_MS, KIND, machineKind, parseProbe, probeArgs, probeTargets, workOf, signature } from "./background.js";
import { initLauncher, renderLauncher, LAUNCHER } from "./launcher.js";

const ART = "mods/agent-sidebar/";
const glyph = (name, size = 14) => svg(`${ART}${name}.svg`).size(size).flex_none();
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
const DENSITY_KEY = "agent-sidebar.density";
const ROW = { compact: 28, expanded: 40 };
// "status": sections by what each session is doing; "space": a section for each of Herdr's
// spaces. The person's choice too.
const GROUP_KEY = "agent-sidebar.group";
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
// Asks Claude (Sonnet, low effort) through Claude Code's own print mode on this computer: no
// tools, no session kept. PATH as a login would have it: the app's own may lack it.
const ORGANIZE_SH = 'command -v claude >/dev/null 2>&1 || PATH="$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"; exec claude "$@" < /dev/null';
const ORGANIZE_ARGS = ["-p", "--model", "sonnet", "--effort", "low", "--tools", "", "--no-session-persistence", "--strict-mcp-config", "--output-format", "json"];
const NAME_MS = 15000;
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
const HEIGHT = { host: 30, hostState: 10, hostGap: 6, away: 24, section: 22, folder: 20, empty: 29 };
// A host heading and the space above it.
const hostHeight = (group, first, firstAway) => isAway(group) ? HEIGHT.away + (firstAway && !first ? HEIGHT.hostGap : 0)
  : HEIGHT.host + (hostState(group) ? HEIGHT.hostState : 0) + (first ? 0 : HEIGHT.hostGap);
const NEWS = new Set(["blocked", "done"]);
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
    // Claude's suggestion for the spaces: null, "asking", or { renames, moves } to apply.
    this.plan = null;
    // Sessions parked by a move, until Herdr shows them in their new space: not "leaving".
    this.parked = new Set();
    this.drag = null;
    this.hoveredSection = null;
    // The session a message is being written to, in the field under its row.
    this.replying = null;
    this.reply = InputState.new({ placeholder: "Message, then Enter" });
    this.reply.on("submit", (_e, cx) => { this.send(); cx?.notify?.(); });
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
        else if (command === "new") this.launch(spaces().find(space => space.id === focused()?.space)?.machine ?? null, {}, "dialog");
        else if (command === "browse") this.browse();
        else if (command === "density") this.toggleDensity();
        else if (command === "group") this.toggleGroup();
        cx.notify();
      }
    });
    // Ages ("4m") are data, not animation: once every 30 s is as often as they change.
    cx.timer.every(30000, cx => cx.notify());
    // Background work Herdr's status can't see (background.js), asked of each machine every
    // PROBE_MS, and again within a second of one of its agents changing status, which is
    // when such work starts or ends. Machines are asked separately: a slow one holds up none.
    this.work = new Map(); // address → the last reading
    this.read = new Map(); // machine → what its transcripts held at the last reading
    this.asked = new Map(); // machine → when it was last asked
    this.asking = new Set(); // machines whose answer is on its way
    this.stale = new Set(); // machines to ask again as soon as allowed
    this.kinds = new Map(); // machine → true once it said what it is, else when it was asked
    cx.spawn(async cx => {
      let wake = () => {};
      for (;;) {
        this.probe(() => wake());
        this.askKinds(() => wake());
        this.finishMoves();
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
    for (const host of machines()) {
      const name = host.name ?? null;
      const asked = this.kinds.get(name);
      if (host.layout !== "ready" || asked === true || now - (asked ?? 0) < KIND_RETRY_MS) continue;
      this.kinds.set(name, now);
      exec("sh", ["-c", KIND], { on: name, timeout: 10000 }).then(result => {
        const kind = result.code === 0 ? machineKind(result.stdout) : null;
        if (!kind) return;
        this.kinds.set(name, true);
        if (shared(KINDS_KEY)?.[name ?? ""] === kind) return;
        setShared(KINDS_KEY, { ...shared(KINDS_KEY), [name ?? ""]: kind });
        this.changed = true;
        answered();
      }).catch(() => { /* asked again later */ });
    }
  }

  // The launcher: a folder, then a shell or an agent to start there. At the pointer from a +,
  // centered from the keyboard. `extra`: { folder, tag } to start from.
  launch(machine, extra = {}, kind = "popup") {
    if (!machines().some(host => (host.name ?? null) === machine && host.layout === "ready")) return;
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
    const view = [this.expanded, this.bySpace, Boolean(this.moving), this.replying, typeof this.plan, this.width, this.single, compact].join("|");
    if (this.ys && this.view === view && !compact) {
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
    setShared(DENSITY_KEY, shared(DENSITY_KEY) === "expanded" ? "compact" : "expanded");
  }

  densityButton(t) {
    const expanded = this.expanded;
    const tip = expanded ? "Compact: one line per session" : "Expanded: show each session's folder";
    return div().id("density").size(26).flex_none().rounded(6).flex().items_center().justify_center()
      .role("button").aria_selected(expanded).accessibility_label(tip)
      .cursor_pointer().text_color(expanded ? t.foreground : t.muted).when(expanded, el => el.bg(t.selected))
      .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { this.toggleDensity(); cx.notify(); })
      .child(glyph("rows", 15));
  }

  // Choosing where sessions go: every space they can go to takes the next click (or the drop).
  // `from`: the space they are in, which is no destination.
  startMove(rows, title, from, dragged = false) {
    const movable = rows.filter(row => row.available && !row.inner);
    if (!movable.length) return;
    this.moving = { addresses: movable.map(row => row.address), title, from, machine: movable[0].machine, dragged };
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
      const shown = spaces().some(other => other.id === space.id);
      if (shown) run("space.rename", { id: space.id, name: space.name });
      if (shown || now_ - space.at > NAME_MS) this.naming.splice(this.naming.indexOf(space), 1);
    }
    if (!this.pending.length) return;
    const placed = new Set(panes().filter(pane => pane.terminal).map(pane => pane.terminal));
    const now = Date.now();
    for (const move of this.pending.slice()) {
      const gone = !placed.has(move.address);
      if (!gone && now - move.at < MOVE_MS) continue;
      this.pending.splice(this.pending.indexOf(move), 1);
      const name = move.name ?? spaces().find(space => space.id === move.space)?.name ?? "the space";
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
    hc(["send", address, text]).then(result => { if (result.code !== 0) failed(result.stderr || result.stdout); }).catch(failed);
  }

  replyField(t, row, indent) {
    return h_flex().id(`reply-${row.address}`).h(28).flex_none().ml(indent).mr(4).mb(2).pl(8).pr(6).gap(6).rounded(6)
      .bg(t.background).border(1).border_color(t.border).items_center()
      .child(glyph("reply", 12).text_color(t.muted))
      .child(Input.new(this.reply).accessibility_label(`Message to ${row.title}`).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
      .child(div().flex_none().text_size(10).text_color(t.dim).child("Esc cancels"));
  }

  // Closes every session idle for over a day, on a second click.
  cleanUp(t, list) {
    const armed = Date.now() - (this.armedClean ?? 0) < ARMED_MS;
    const n = `${list.length} ${list.length === 1 ? "session" : "sessions"}`;
    return h_flex().id("clean-up").h(26).flex_none().rounded(6).px(8).gap(8).items_center()
      .role("button").accessibility_label(armed ? `Click again to close ${n}` : `Close ${n} idle for over a day`)
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
      .child(armed ? `Click again to close ${n}` : `Close ${n} idle for over a day`);
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
    const forget = entry => setShared(CLOSED_KEY, (shared(CLOSED_KEY) ?? []).filter(other => other.session !== entry.session));
    return [heading, ...closed.map(entry => h_flex().id(`closed-${entry.session}`).h(26).flex_none().rounded(6).pl(8).pr(6).gap(8).items_center()
      .role("button").accessibility_label(`Reopen ${entry.title}`).cursor_pointer().hover(s => s.bg(t.hover))
      .tooltip([`Reopen ${entry.title}`, this.single ? "" : entry.machine ?? "This computer", entry.cwd, `claude --resume ${entry.session}`].filter(Boolean).join("\n"))
      .on_click((_e, cx) => {
        const action = resumeAction(entry, machines(), spaces(), focused());
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
    const { prompt, ids } = organizeBrief(rows, spaces());
    if (!ids.size) return;
    this.plan = "asking";
    const failed = why => { this.plan = null; notify({ title: "Could not organize the sessions", body: String(why ?? "").trim().slice(0, 200), level: "warning" }); };
    exec("sh", ["-c", ORGANIZE_SH, "sh", ...ORGANIZE_ARGS, "--json-schema", JSON.stringify(ORGANIZE_SCHEMA), "--system-prompt", ORGANIZE_SYSTEM, prompt], { on: null, timeout: 120000 }).then(result => {
      let answer = null;
      try { const out = JSON.parse(result.stdout); answer = out.structured_output ?? JSON.parse(out.result); } catch { /* said below */ }
      if (result.code !== 0 || !answer) return failed(result.stderr || "Claude Code gave no answer. Is `claude` installed and signed in on this computer?");
      const plan = organizePlan(this.rows ?? rows, spaces(), answer, ids, machine => `${machine == null ? "" : `${machine}/`}sp${hex(32)}`);
      if (plan.renames.length || plan.moves.length) this.plan = plan;
      else { this.plan = null; notify({ title: "Already organized", body: "Claude would leave every session where it is.", level: "info", timeout: 3000 }); }
    }).catch(failed).finally(() => { this.changed = true; answered(); });
  }

  applyPlan() {
    const plan = this.plan;
    this.plan = null;
    if (!plan || plan === "asking") return;
    for (const rename of plan.renames) run("space.rename", { id: rename.id, name: rename.to });
    for (const move of plan.moves) {
      const row = (this.rows ?? []).find(row => row.address === move.address);
      if (!canMove(row, move.to) || this.pending.some(other => other.address === move.address)) continue;
      this.pending.push({ address: move.address, row, space: move.to, name: move.name, created: move.created, quiet: true, at: Date.now() });
      if (row.pane) run("terminal.park", { terminal: move.address });
    }
  }

  organizeButton(t) {
    const asking = this.plan === "asking";
    const tip = asking ? "Asking Claude…" : "Organize into spaces with Claude (Sonnet, low effort): suggests, then asks";
    return div().id("organize").size(26).flex_none().rounded(6).flex().items_center().justify_center()
      .role("button").accessibility_label(tip).cursor_pointer().text_color(asking ? t.accent : t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { this.organize(); cx.notify(); })
      .child(asking ? glyph("sparkles", 15).loop("opacity", { from: 0.35, to: 1, period: 1200 }) : glyph("sparkles", 15));
  }

  // What Claude suggests, to apply or dismiss. `height`: what it takes in the list.
  planPanel(t, plan) {
    const lines = [
      ...plan.renames.map(rename => `Rename ${rename.from} to ${rename.to}`),
      ...[...new Set(plan.moves.map(move => move.to))].map(to => {
        const group = plan.moves.filter(move => move.to === to);
        return `${group[0].created ? "New space" : "To"} ${group[0].name}: ${group.map(move => move.title).join(", ")}`;
      }),
    ];
    const shown = lines.slice(0, 7);
    const button = (id, label, strong, action) => div().id(id).h(20).px(8).flex_none().rounded(5).flex().items_center().text_size(10.5).font_medium()
      .role("button").accessibility_label(label).cursor_pointer()
      .text_color(strong ? t.foreground : t.muted).when(strong, el => el.bg(t.selected)).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { action(); cx.notify(); }).child(label);
    const node = v_flex().id("plan").flex_none().mx(2).mb(4).p(8).gap(4).rounded(6).bg(t.raised)
      .child(h_flex().gap(6).items_center().text_size(11).font_medium()
        .child(glyph("sparkles", 12).text_color(t.accent)).child(div().child("Claude suggests")))
      .children(shown.map(line => div().min_w(0).truncate().text_size(11).text_color(t.muted).tooltip(line).child(line)))
      .when(lines.length > shown.length, el => el.child(div().text_size(10.5).text_color(t.dim).child(`+${lines.length - shown.length} more`)))
      .child(h_flex().gap(6).mt(2).items_center()
        .child(button("plan-apply", `Apply ${plan.moves.length ? `· moves ${plan.moves.length}` : ""}`.trim(), true, () => this.applyPlan()))
        .child(button("plan-dismiss", "Dismiss", false, () => { this.plan = null; })));
    return { node, height: 16 + 18 + shown.length * 20 + (lines.length > shown.length ? 20 : 0) + 26 + 4 };
  }

  recolor(space) {
    const colors = shared("space.colors") ?? {};
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
    this.drag = this.moving ? null : { ...drag, over: drag.home, moved: false };
  }

  dragOver(key, cx) {
    const drag = this.drag;
    if (!drag || drag.over === key) return;
    drag.over = key;
    drag.moved = true;
    if (drag.row && !this.moving) this.startMove([drag.row], drag.row.title, drag.row.spaceId, true);
    cx.notify();
  }

  // The release. On a space heading (`section`): the drop. Anywhere else: the drag is over.
  release(cx, group = null, section = null) {
    const drag = this.drag;
    this.drag = null;
    if (!drag?.moved) return;
    // A press that left and came back is no click.
    this.dragged = drag.home;
    const space = section?.space || null;
    if (drag.row && space && this.isTarget(group, section)) this.moveTo(space);
    else if (drag.row && this.moving?.dragged) this.moving = null;
    else if (drag.space && space && space !== drag.space && drag.machine === (group.name ?? null)) {
      const index = spaces().findIndex(other => other.id === space);
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

  toggleGroup() {
    setShared(GROUP_KEY, shared(GROUP_KEY) === "space" ? "status" : "space");
  }

  groupButton(t) {
    const on = this.bySpace;
    const tip = on ? "Group by status" : "Group by space";
    return div().id("group").size(26).flex_none().rounded(6).flex().items_center().justify_center()
      .role("button").aria_selected(on).accessibility_label(tip)
      .cursor_pointer().text_color(on ? t.foreground : t.muted).when(on, el => el.bg(t.selected))
      .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { this.toggleGroup(); cx.notify(); })
      .child(glyph("spaces", 15));
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

  // Back from the rail to the width Herdr's own sidebar toggle remembered.
  expand() {
    setShared("sidebar.collapsed", false);
    run("layout.resize", { id: "sidebar", px: Math.max(240, Number(shared("sidebar.width")) || WIDE) });
  }

  // Settings and Add machine live here, so the sidebar needs no footer.
  extras(t, compact) {
    const add = h_flex().id("add-machine").h(26).flex_none().rounded(6).items_center().gap(8)
      .role("button").accessibility_label("Add machine").tooltip("Connect another machine")
      .cursor_pointer().text_size(11.5).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => run("mod.open", { name: "machine-add" }))
      .child(glyph("plus", 13));
    return compact ? [add.mt(6).justify_center(), this.settingsButton(t).mx_auto()]
      : [add.mt(6).px(8).child("Add machine")];
  }

  settingsButton(t) {
    const ready = Boolean(updates().app.ready);
    return div().id("settings").relative().size(26).flex_none().rounded(6).flex().items_center().justify_center()
      .role("button").accessibility_label(ready ? "Settings, update ready" : "Settings")
      .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(ready ? "Settings · update ready" : "Settings").on_click(() => run("app.settings"))
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
    const host = this.single ? "" : row.machine == null ? "Local · This computer" : `Remote · ${row.machine}`;
    const kind = row.inner ? (row.inBackground ? "Sub-agent, in the background" : "Sub-agent")
      : row.kind === "shell" ? "Shell" : row.kind === "process" ? "Program" : "Agent";
    const context = [...new Set([kind, row.space === row.title ? "" : row.space, row.program?.name].filter(Boolean))].join(" · ");
    const word = !row.background.length ? WORDS[row.status]
      : row.background.some(reason => reason !== "goal") ? "Working in the background" : "Goal active";
    const state = !row.available ? "Unavailable" : row.kind === "agent" && row.since ? `${word} · ${duration(now - row.since)}` : word;
    const from = !row.parent ? "" : row.inner ? `Inside ${row.parent}` : `Started from ${row.parent}`;
    return [row.title, context, host, state, activityText(row), this.usesText(row), ...backgroundLines(row, now), row.inner ? "" : row.address, row.cwd, from].filter(Boolean).join("\n");
  }

  // "Opus 5.5 · xhigh effort · 159k context": what the session's last turn ran with, and how
  // much context it was sent, when its machine said.
  usesText(row) {
    const name = modelName(row.model);
    const used = tokens(row.context);
    return name ? [name.label, row.effort ? `${row.effort} effort` : "", used ? `${used} context` : ""].filter(Boolean).join(" · ") : "";
  }

  // The same, at a glance, in words: `label` is the model's name and `context` its tokens, or
  // none where there is no room. The effort has its level's color: it is what differs most.
  uses(t, row, label, context = "") {
    const effort = row.effort ?? "";
    if (!label && !effort) return null;
    return h_flex().id(`uses-${row.address}`).flex_none().gap(3).items_center().text_size(10.5).text_color(t.dim).tooltip(this.usesText(row))
      .when(Boolean(label), el => el.child(div().child(label)))
      .when(Boolean(label && effort), el => el.child(div().child("·")))
      .when(Boolean(effort), el => el.child(div().id(`effort-${row.address}`).text_color(t[EFFORT_COLOR[effort]] ?? t.muted)
        .when(effort === "max", el => el.font_semibold()).child(effort)))
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
    const pinning = hovered && !row.inner;
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
    const name = modelName(row.model);
    const effort = name && row.effort ? row.effort : "";
    const px = (Number.isFinite(this.width) ? this.width : WIDE) - 104 - indent;
    const said = label => [label, effort].filter(Boolean).join(" · ");
    // What it is doing or asking, while it works or needs you: in place of the folder, which
    // stays in the tooltip.
    const doing = activityText(row);
    const used = tokens(row.context);
    let context = "";
    let model = "";
    let shown = Boolean(name);
    let where = row.inner ? row.space : [shortPath(row.cwd), row.branch].filter(Boolean).join(" · ");
    let room = Math.floor(px / 6.5);
    if (expanded && name) {
      const line = Math.floor(px / 5.6);
      const first = doing || where;
      model = first.length + said(name.label).length + 2 <= line ? name.label : name.family;
      context = used && first.length + said(model).length + used.length + 5 <= line ? used : "";
      if (!row.inner && !doing) where = fitWhere(shortPath(row.cwd), row.branch, line - said(model).length - 2);
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
    const uses = shown ? this.uses(t, row, model, context) : null;
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
        this.replying = row.address;
        this.reply.set_value("");
        this.reply.focus();
        this.hovered = null;
        cx.notify();
      })
      .child(glyph("reply", 12));
    // To another space: every space it can go to then takes the click.
    const others = !row.inner && spaces().filter(space => (space.machine ?? null) === row.machine && space.id !== row.spaceId).length > 0;
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
    const age = row.kind === "agent" && row.since && row.available ? duration(now - row.since) : "";
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
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(doing ? t.muted : t.dim).child(where || " "))
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
      .tooltip(tip).on_click(() => { if (this.clicked(`row:${row.address}`)) this.open(row); })
      .when(row.available && !row.inner, el => el.on_mouse_down("left", () => this.press({ row, home: `row:${row.address}` })))
      .on_mouse_move((_e, cx) => this.dragOver(`row:${row.address}`, cx))
      .on_mouse_up("left", (_e, cx) => this.release(cx))
      .when(this.moving?.addresses.includes(row.address) || this.pending.some(move => move.address === row.address), el => el.opacity(0.5))
      .when(Boolean(tint), el => el.child(tint))
      .when(Boolean(row.parent), el => el.child(glyph("sub", 11).ml(-2).mr(-4).text_color(t.dim)))
      .child(this.program(t, row, expanded ? 18 : 16))
      .child(text)
      .when(row.pinned && section !== "pinned" && !pinning, el => el.child(glyph("pin", 11).text_color(t.dim)))
      .when(goal, el => el.child(div().id(`goal-${row.address}`).flex_none().tooltip(`Goal: ${row.goal.condition}`)
        .child(glyph("goal", 11).text_color(t.dim))))
      .when(pinning, el => el.child(h_flex().flex_none().gap(2).items_center()
        .when(!armed && canReply(row), el => el.child(reply))
        .when(!armed && others, el => el.child(move))
        .when(!armed && Boolean(row.cwd), el => el.child(here))
        .when(!armed, el => el.child(pin))
        .child(close)))
      .when(!expanded && !pinning && Boolean(uses), el => el.child(uses))
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

  section(t, group, section) {
    const key = `${group.key}:${section.id}`;
    const open = this.isOpen(key);
    const color = section.status ? t[section.status] : t.muted;
    // Sessions: a session's own sub-agents are part of it.
    const n = section.entries.filter(entry => !entry.row.inner).length;
    // One of Herdr's spaces (not "No space"): it has Herdr's color, and things to do with it.
    const space = section.space || null;
    const dot = space ? t[shared("space.colors")?.[space] ?? SPACE_COLORS[0]] : null;
    // While sessions are being moved, a space they can go to says so and takes the click.
    const target = this.isTarget(group, section);
    const hovered = this.hoveredSection === key && Boolean(space) && !this.moving;
    const act = (id, icon, tip, action) => div().id(`${id}-${key}`).size(18).flex_none().rounded(4).flex().items_center().justify_center()
      .role("button").accessibility_label(`${tip}: ${section.label}`).cursor_pointer().text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); this.hoveredSection = null; action(); cx.notify(); })
      .child(glyph(icon, 12));
    const rows = section.entries.map(entry => entry.row);
    return h_flex().id(`section-${key}`).h(HEIGHT.section).flex_none().pl(10).pr(8).gap(6).items_center()
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
        if (space && e?.click_count === 2) run("space.rename", { id: space });
        this.toggle(key, cx);
      })
      .when(Boolean(space), el => el
        .on_mouse_down("right", () => this.spaceMenu(space))
        .on_mouse_down("left", () => this.press({ space, machine: group.name ?? null, home: `section:${key}` })))
      .on_mouse_move((_e, cx) => this.dragOver(`section:${key}`, cx))
      .on_mouse_up("left", (_e, cx) => this.release(cx, group, section))
      .when(Boolean(dot), el => el.child(div().id(`color-${key}`).size(8).flex_none().rounded(4).bg(dot).cursor_pointer().tooltip("Change color")
        .on_click((_e, cx) => { cx.stop_propagation(); this.recolor(space); cx.notify(); })))
      .child(div().min_w(0).truncate().text_color(target ? t.foreground : color).child(section.label))
      .child(div().flex_none().text_color(t.dim).child(String(n)))
      .child(div().flex_1())
      .when(target, el => el.child(div().flex_none().text_size(10).text_color(t.accent).child("Move here")))
      .when(section.space !== undefined && !open && !target && !hovered, el => el.children(this.summary(t, { rows })))
      .when(hovered, el => el
        .child(act("space-new", "plus", "New shell or agent in this space", () => this.launch(group.name ?? null, { space })))
        .when(n > 0 && spaces().some(other => (other.machine ?? null) === (group.name ?? null) && other.id !== space),
          el => el.child(act("space-merge", "merge", "Move all its sessions to another space", () => this.startMove(rows, `all of ${section.label}`, space))))
        .child(act("space-more", "more", "Rename, worktrees, close", () => this.spaceMenu(space))))
      .when(!hovered, el => el.child(glyph(open ? "chevron-down" : "chevron-right", 10).text_color(t.dim)));
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
    const kind = shared(KINDS_KEY)?.[group.name ?? ""];
    const icon = KIND_ICON[kind] ?? (group.remote ? "server" : "computer");
    const label = `${group.remote ? "Remote" : "Local"} host ${group.label}, ${counts(group.rows).all} sessions${state ? `, ${state}` : ""}, ${open ? "expanded" : "collapsed"}`;
    const root = h_flex().id(`host-${group.key}`).flex_none().items_center()
      .role("button").accessibility_label(label).cursor_pointer()
      .tooltip(`${group.remote ? "Remote host" : "Local machine"}: ${group.label}${KIND_ICON[kind] ? ` · ${kind}` : ""}${state ? ` · ${state}` : ""}`)
      .on_click((_e, cx) => this.toggle(group.key, cx));
    if (compact) return root.h(30).px(6).gap(4).justify_center().when(!first, el => el.mt(4).border_t(1).border_color(t.border))
      .child(glyph(icon, 14).text_color(color)).child(add);
    // Grouped by space, a machine's heading also starts a new space there.
    return root.h(HEIGHT.host + (state ? HEIGHT.hostState : 0)).px(8).gap(8).rounded(6)
      .when(!first, el => el.mt(HEIGHT.hostGap))
      .hover(s => s.bg(t.hover))
      .child(glyph(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))
      .child(glyph(icon, 15).text_color(color))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().min_w(0).truncate().font_semibold().text_size(12).text_color(t.foreground).child(group.label))
          .child(div().flex_none().px(4).py(1).rounded(4).bg(t.raised).text_size(8.5).font_semibold().text_color(color).child(group.remote ? "REMOTE" : "LOCAL")))
        .when(Boolean(state), el => el.child(div().text_size(10).text_color(group.layout === "loading" ? t.muted : t.blocked).child(state))))
      .when(!open, el => el.children(this.summary(t, group)))
      .child(div().flex_none().min_w(14).text_size(10.5).text_color(t.muted).text_right().child(String(counts(group.rows).all)))
      .when(Boolean(space), el => el.child(space))
      .child(add);
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
    return root.h(HEIGHT.away).px(8).gap(8).when(gap, el => el.mt(HEIGHT.hostGap))
      .child(glyph(open ? "chevron-down" : "chevron-right", 11))
      .child(glyph("offline", 13))
      .child(div().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(group.label))
      .child(div().flex_none().text_size(10).child("Unavailable"))
      .child(div().flex_1())
      .when(n > 0, el => el.child(div().flex_none().text_size(10.5).child(String(n))));
  }

  render() {
    if (this.launcher) return renderLauncher(this);
    const t = /** @type {Record<string, import("gpui-kit").Color>} */ (theme());
    const hosts = machines();
    const now = Date.now();
    const shownPanes = panes();
    const placed = new Set(shownPanes.filter(pane => pane.terminal).map(pane => pane.terminal));
    const built = build({ agents: agents(), terminals: terminals(), panes: shownPanes, spaces: spaces(), machines: hosts, focused: focused(), work: this.work, now });
    for (const address of this.parked) if (placed.has(address) || !built.some(row => row.address === address)) this.parked.delete(address);
    const staying = new Set([...this.pending.map(move => move.address), ...this.parked]);
    const all = holdDone(dropLeaving(built, this.leaving, this.placed, placed, now, staying), this.shown ?? new Map());
    this.placed = placed;
    this.notice(all, now);
    // Background work starts or ends when an agent's status changes: ask its machine again.
    const reported = new Map();
    for (const row of all) {
      if (row.kind === "agent" && !row.inner) reported.set(row.machine, `${reported.get(row.machine) ?? ""} ${row.address}:${row.reported}:${row.pid}`);
    }
    for (const [machine, key] of reported) if (this.reported?.get(machine) !== key) this.stale.add(machine);
    this.reported = reported;
    this.rows = all;
    // Sessions whose terminal is gone from a machine that answers have ended: kept to reopen.
    const gone = ended(this.known, new Set(terminals().filter(terminal => terminal.state === "live").map(terminal => terminal.address)),
      new Set(hosts.filter(host => host.layout === "ready").map(host => host.name ?? null)));
    if (gone.length) setShared(CLOSED_KEY, gone.reduce((list, seen) => remember(list, seen, now), shared(CLOSED_KEY) ?? []));
    for (const row of all) if (row.kind === "agent" && !row.inner && row.available && row.session) this.known.set(row.address, { title: row.title, cwd: row.cwd, machine: row.machine, session: row.session });
    if (this.replying && !canReply(all.find(row => row.address === this.replying))) this.replying = null;
    const tally = counts(all);
    // Sessions move between spaces, so choosing where shows the spaces whatever the grouping.
    if (this.moving && !this.moving.addresses.some(address => all.some(row => row.address === address))) this.moving = null;
    this.bySpace = shared(GROUP_KEY) === "space" || Boolean(this.moving);
    const sections = groups(all, hosts, this.bySpace ? "space" : "status", spaces());
    const compact = this.width < RAIL;
    this.expanded = shared(DENSITY_KEY) === "expanded";
    // Only this computer: no host heading, which would only repeat it. Its + moves to the title bar.
    this.single = !hosts.some(host => host.name != null);
    const local = { layout: "loading", ...hosts.find(host => host.name == null), name: null, key: "local", label: "This computer" };
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
    };
    // While a space is being chosen: what is moving, and the way out.
    if (this.moving && !compact) push(h_flex().id("moving").h(26).flex_none().mx(2).mb(2).px(8).gap(6).rounded(6).bg(t.raised).items_center().text_size(11)
      .child(glyph("move", 12).text_color(t.accent))
      .child(div().flex_1().min_w(0).truncate().child(`Move ${this.moving.title} to…`))
      .child(div().id("moving-cancel").flex_none().px(5).h(18).rounded(4).flex().items_center().text_size(10.5).text_color(t.muted)
        .role("button").accessibility_label("Cancel the move").cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Cancel · Esc")
        .on_click((_e, cx) => { this.moving = null; cx.notify(); }).child("Cancel")), "moving", 28);
    if (this.plan && this.plan !== "asking" && !compact) {
      const panel = this.planPanel(t, this.plan);
      push(panel.node, "plan", panel.height);
    }
    if (this.single && compact) push(h_flex().h(30).flex_none().justify_center().items_center().child(this.newButton(t, local)));
    const firstAway = sections.findIndex(isAway);
    sections.forEach((group, i) => {
      if (!this.single) push(this.host(t, group, compact, i === 0, i === firstAway), `host:${group.key}`, hostHeight(group, i === 0, i === firstAway));
      // A host folded back when there were several must not hide everything now.
      if (!this.single && !this.hostOpen(group)) return;
      if (compact) {
        // Sub-agents stay in their session's tooltip: in a rail they would pass for sessions.
        for (const row of group.rows) if (!row.inner) add(row, this.railRow(t, row));
        return;
      }
      for (const section of group.sections) {
        push(this.section(t, group, section), `section:${group.key}:${section.id}`, HEIGHT.section);
        // A folded section still shows the session you are in: clicking a session that is done
        // makes it idle, and it must not vanish into a folded Idle.
        const open = this.isOpen(`${group.key}:${section.id}`);
        for (const folder of section.folders) {
          // A heading only gathers: one session's folder is on its own row. Sessions with no
          // folder known are not a folder. Expanded, every row's second line names its folder, so
          // the sessions still sit together but under no heading.
          // Nor grouped by space: a space is the grouping.
          const grouped = open && !this.expanded && !this.bySpace && Boolean(folder.key) && folder.sessions > 1;
          if (grouped) push(this.folderHeading(t, group, section, folder), `folder:${group.key}:${section.id}:${folder.key}`, HEIGHT.folder);
          for (const entry of folder.entries) if (open || entry.row.focused) add(entry.row, this.row(t, entry, section.id, now, grouped));
        }
      }
      if (!group.rows.length) push(div().pl(this.single ? 10 : 29).pr(12).pt(1).pb(5).text_size(11).text_color(t.muted)
        .child(group.layout === "ready" ? "No sessions yet · use + to start one" : group.layout === "loading" ? "Loading sessions…" : "Sessions appear when this host reconnects"), `empty:${group.key}`, HEIGHT.empty);
    });
    this.slide(t, children, keys, heights, compact, now);
    if (!compact) {
      // Only when there is something to close, or to reopen.
      const old = stale(all, now);
      if (old.length) children.push(this.cleanUp(t, old).mt(6));
      const closed = (shared(CLOSED_KEY) ?? []).filter(entry => !all.some(row => row.session === entry.session)
        && hosts.some(host => (host.name ?? null) === (entry.machine ?? null)));
      if (closed.length) children.push(...this.closedList(t, closed, now));
    }
    children.push(...this.extras(t, compact));
    setAgentOrder(this.visible.filter(r => r.kind === "agent" && !r.inner).map(r => r.address));
    // Drawn at their start: the next frame draws them at their end.
    let started = false;
    for (const change of [...this.fresh.values(), ...this.moves.values()]) if (change.step === 0) { change.step = 1; started = true; }
    if (started) this.pulse?.();
    const iconButton = (id, icon, tip, action) => div().id(id).size(26).flex_none().rounded(6).flex().items_center().justify_center()
      .role("button").accessibility_label(tip)
      .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(action).child(glyph(icon, 15));
    return v_flex().id("agent-sidebar").size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        const width = size.width / Number(settings().zoom ?? 1);
        if (this.width !== width) { this.width = width; cx.notify(); }
      })
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          // Out of a move; else back to the current session.
          this.selected = null;
          if (this.replying) { this.replying = null; this.reply.set_value(""); }
          else if (this.moving) this.moving = null;
          else this.open(this.visible.find(r => r.focused));
        } else if (e.key === "enter") {
          const row = this.visible.find(r => r.address === this.selected);
          if (!row) return;
          this.open(row);
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
        .child(h_flex().id("sessions-header").h(34).flex_none().pl(16).pr(10).gap(6).items_center()
          .child(div().font_semibold().text_size(14).child("Sessions"))
          .child(div().id("sessions-count").text_size(11.5).text_color(t.muted).child(String(tally.all)))
          .child(div().flex_1())
          .when(this.single && this.bySpace, el => el.child(this.newSpaceButton(t, local, 26)))
          .when(this.single, el => el.child(this.newButton(t, local, 26)))
          .child(this.organizeButton(t))
          .child(this.groupButton(t))
          .child(this.densityButton(t))
          .child(this.settingsButton(t))))
      .when(compact, el => el.child(h_flex().h(34).flex_none().justify_center().items_center()
        .child(iconButton("expand-agents", "panel-left", "Expand sessions", () => this.expand()))))
      .child(v_flex().id("host-agent-list").flex_1().min_h(0).px(6).pt(compact ? 0 : 2).pb(12).overflow_y_scrollbar().track_scroll(this.scroll)
        .role("list_box").accessibility_label(`Sessions grouped by ${this.single ? "" : "machine, then by "}${this.bySpace ? "space" : "status"}`)
        .children(children));
  }
}
