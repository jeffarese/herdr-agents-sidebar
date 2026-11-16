import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { agents, terminals, panes, spaces, machines, focused, theme, settings, run, setAgentOrder, nextCommand, openOverlay, props, shared, setShared, updates, exec, pickFolder } from "herdr";
import { build, groups, counts, WORDS, BACKGROUND, openAction, closeAction, duration, backgroundLines, machineOf, shortPath, holdDone } from "./model.js";
import { PROBE, PROBE_MS, parseProbe, probeArgs, probeTargets, workOf, signature } from "./background.js";
import { initLauncher, renderLauncher, LAUNCHER } from "./launcher.js";

const ART = "mods/agent-sidebar/";
const glyph = (name, size = 14) => svg(`${ART}${name}.svg`).size(size).flex_none();
const hostState = host => host.layout === "ready" ? "" : host.layout === "loading" ? "Connecting…" : "Unavailable";
// Below this width the sidebar is a rail of icons.
const RAIL = 210;
const WIDE = 320;
const FILTERS = [["all", "All"], ["blocked", "Needs you"], ["working", "Working"], ["done", "Done"]];
const EMPTY = { blocked: "Nothing needs you", working: "Nothing is working", done: "Nothing finished yet" };
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
const ROW = { compact: 28, expanded: 42 };
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
const HEIGHT = { section: 24, folder: 20, empty: 31 };
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
    this.query = "";
    this.filter = "all";
    this.selected = null;
    this.hovered = null;
    this.width = Infinity;
    // Host keys ("local", "remote:work") and section keys ("local:idle").
    this.folded = new Set(store.get("folded", []));
    // address → the status each row was shown with, and the changes still animating.
    this.shown = null;
    this.fresh = new Map();
    // Key (host, section, folder or row) → where it was drawn, and the slides still running.
    this.ys = null;
    this.moves = new Map();
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
    this.input = InputState.new({ placeholder: "Search sessions or hosts…" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.selected = null;
      this.scroll.scroll_to_item(0);
      cx.notify();
    });
    this.input.on("submit", () => this.open(this.visible.find(r => r.address === this.selected) ?? this.visible[0]));
    // "focus" from pane.go; "new" (bind a key to agent-sidebar.new) opens the launcher for the
    // focused machine; "browse" comes from the launcher, which closes for the system's picker.
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.input.focus();
        else if (command === "new") this.launch(spaces().find(space => space.id === focused()?.space)?.machine ?? null, {}, "dialog");
        else if (command === "browse") this.browse();
        else if (command === "density") this.toggleDensity();
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
    cx.spawn(async cx => {
      let wake = () => {};
      for (;;) {
        this.probe(() => wake());
        // A second, or less when an answer arrives.
        await Promise.race([cx.sleep(1000), new Promise(resolve => { wake = resolve; })]);
        if (this.changed) {
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
    if (action) run(action.name, action.args);
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
  // when the view itself changed (search, filter, width, density): that is a new list, not a move.
  slide(t, children, keys, heights, compact, now) {
    for (const [key, move] of this.moves) if (now - move.at > SLIDE_MS) this.moves.delete(key);
    const ys = new Map();
    let y = 0;
    keys.forEach((key, i) => {
      if (key) ys.set(key, y);
      y += heights[i];
    });
    const view = [this.query, this.filter, this.expanded, this.width, this.single, compact].join("|");
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

  // Search and filters reveal everything they match, even inside folded hosts and sections.
  isOpen(key) {
    return !this.folded.has(key) || Boolean(this.query.trim()) || this.filter !== "all";
  }

  chooseFilter(filter, cx) {
    this.filter = this.filter === filter && filter !== "all" ? "all" : filter;
    this.selected = null;
    this.scroll.scroll_to_item(0);
    cx.notify();
  }

  clearSearch(cx) {
    this.input.set_value("");
    this.query = "";
    this.selected = null;
    cx.notify();
  }

  // Back from the rail to the width Herdr's own sidebar toggle remembered.
  expand() {
    setShared("sidebar.collapsed", false);
    run("layout.resize", { id: "sidebar", px: Math.max(240, Number(shared("sidebar.width")) || WIDE) });
  }

  // Settings and Add machine live here, so the sidebar needs no footer.
  extras(t, compact) {
    const add = h_flex().id("add-machine").h(28).flex_none().rounded(6).items_center().gap(8)
      .role("button").accessibility_label("Add machine").tooltip("Connect another machine")
      .cursor_pointer().text_size(11.5).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => run("mod.open", { name: "machine-add" }))
      .child(glyph("plus", 13));
    return compact ? [add.mt(6).justify_center(), this.settingsButton(t).mx_auto()]
      : [add.mt(10).px(8).child("Add machine")];
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
    return [row.title, context, host, state, ...backgroundLines(row, now), row.inner ? "" : row.address, row.cwd, from].filter(Boolean).join("\n");
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
    const room = Math.floor(((Number.isFinite(this.width) ? this.width : WIDE) - 104 - indent) / 6.5);
    const detail = !expanded && !(grouped && !row.inner) && folder && !row.title.toLowerCase().includes(folder.toLowerCase())
      && row.title.length + folder.length + 2 <= room ? folder : "";
    const where = row.inner ? row.space : [shortPath(row.cwd), row.branch].filter(Boolean).join(" · ");
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
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(where || " "))
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
      .tooltip(tip).on_click(() => this.open(row))
      .when(Boolean(tint), el => el.child(tint))
      .when(Boolean(row.parent), el => el.child(glyph("sub", 11).ml(-2).mr(-4).text_color(t.dim)))
      .child(this.program(t, row, expanded ? 18 : 16))
      .child(text)
      .when(row.pinned && section !== "pinned" && !pinning, el => el.child(glyph("pin", 11).text_color(t.dim)))
      .when(goal, el => el.child(div().id(`goal-${row.address}`).flex_none().tooltip(`Goal: ${row.goal.condition}`)
        .child(glyph("goal", 11).text_color(t.dim))))
      .when(pinning && !armed && Boolean(row.cwd), el => el.child(here))
      .when(pinning && !armed, el => el.child(pin))
      .when(pinning, el => el.child(close))
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
    // Sessions, as the filters count them: a session's own sub-agents are part of it.
    const n = section.entries.filter(entry => !entry.row.inner).length;
    return h_flex().id(`section-${key}`).h(24).flex_none().pl(10).pr(8).gap(6).items_center()
      .role("button").accessibility_label(`${section.label}, ${n} ${n === 1 ? "session" : "sessions"}, ${open ? "expanded" : "collapsed"}`)
      .cursor_pointer().rounded(5).text_size(10.5).font_medium()
      .hover(s => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(key, cx))
      .child(div().text_color(color).child(section.label))
      .child(div().text_color(t.dim).child(String(n)))
      .child(div().flex_1())
      .child(glyph(open ? "chevron-down" : "chevron-right", 10).text_color(t.dim));
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

  host(t, group, compact, first) {
    const open = this.isOpen(group.key);
    const color = group.remote ? t.ansi4 : t.accent;
    const state = hostState(group);
    const add = this.newButton(t, group);
    const label = `${group.remote ? "Remote" : "Local"} host ${group.label}, ${counts(group.rows).all} sessions${state ? `, ${state}` : ""}, ${open ? "expanded" : "collapsed"}`;
    const root = h_flex().id(`host-${group.key}`).flex_none().items_center()
      .role("button").accessibility_label(label).cursor_pointer()
      .tooltip(`${group.remote ? "Remote host" : "Local machine"}: ${group.label}${state ? ` · ${state}` : ""}`)
      .on_click((_e, cx) => this.toggle(group.key, cx));
    if (compact) return root.h(30).px(6).gap(4).justify_center().when(!first, el => el.mt(4).border_t(1).border_color(t.border))
      .child(glyph(group.remote ? "server" : "computer", 14).text_color(color)).child(add);
    return root.h(state ? 42 : 34).px(8).gap(8).rounded(6)
      .when(!first, el => el.mt(10))
      .hover(s => s.bg(t.hover))
      .child(glyph(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))
      .child(glyph(group.remote ? "server" : "computer", 15).text_color(color))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().min_w(0).truncate().font_semibold().text_size(12).text_color(t.foreground).child(group.label))
          .child(div().flex_none().px(4).py(1).rounded(4).bg(t.raised).text_size(8.5).font_semibold().text_color(color).child(group.remote ? "REMOTE" : "LOCAL")))
        .when(Boolean(state), el => el.child(div().text_size(10).text_color(group.layout === "loading" ? t.muted : t.blocked).child(state))))
      .when(!open, el => el.children(this.summary(t, group)))
      .child(div().flex_none().min_w(14).text_size(10.5).text_color(t.muted).text_right().child(String(counts(group.rows).all)))
      .child(add);
  }

  // The search field, with a clear button once something is typed.
  search(t) {
    return h_flex().h(30).flex_none().mx(10).pl(9).pr(4).gap(7).rounded(7).bg(t.background).border(1).border_color(t.border).items_center()
      .child(glyph("search", 13).text_color(t.muted))
      .child(Input.new(this.input).accessibility_label("Search sessions or hosts").flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
      .when(Boolean(this.query), el => el.child(div().id("clear-search").size(20).flex_none().rounded(4).flex().items_center().justify_center()
        .role("button").accessibility_label("Clear search").tooltip("Clear search")
        .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.clearSearch(cx)).child(glyph("x", 12))));
  }

  chips(t, tally) {
    return h_flex().h(34).flex_none().px(10).gap(3).items_center()
      .children(FILTERS.map(([id, label]) => {
        const count = tally[id];
        const on = this.filter === id;
        const tint = id !== "all" && count ? t[id] : t.dim;
        return h_flex().id(`filter-${id}`).h(24).px(7).gap(5).rounded(6).items_center()
          .role("button").aria_selected(on).accessibility_label(`${label}: ${count} sessions`)
          .cursor_pointer().text_size(10.5).text_color(on ? t.foreground : t.muted)
          .when(on, el => el.bg(t.selected)).when(!on, el => el.hover(s => s.bg(t.hover)))
          .on_click((_e, cx) => this.chooseFilter(id, cx)).child(label)
          .child(div().text_size(10).font_medium().text_color(tint).child(String(count)));
      }));
  }

  render() {
    if (this.launcher) return renderLauncher(this);
    const t = /** @type {Record<string, import("gpui-kit").Color>} */ (theme());
    const hosts = machines();
    const now = Date.now();
    const all = holdDone(build({ agents: agents(), terminals: terminals(), panes: panes(), spaces: spaces(), machines: hosts, focused: focused(), work: this.work, now }), this.shown ?? new Map());
    this.notice(all, now);
    // Background work starts or ends when an agent's status changes: ask its machine again.
    const reported = new Map();
    for (const row of all) {
      if (row.kind === "agent" && !row.inner) reported.set(row.machine, `${reported.get(row.machine) ?? ""} ${row.address}:${row.reported}:${row.pid}`);
    }
    for (const [machine, key] of reported) if (this.reported?.get(machine) !== key) this.stale.add(machine);
    this.reported = reported;
    this.rows = all;
    const tally = counts(all);
    const sections = groups(all, hosts, this.query, this.filter);
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
    };
    if (this.single && compact) push(h_flex().h(30).flex_none().justify_center().items_center().child(this.newButton(t, local)));
    sections.forEach((group, i) => {
      if (!this.single) push(this.host(t, group, compact, i === 0), `host:${group.key}`, (hostState(group) ? 42 : 34) + (i === 0 ? 0 : 10));
      // A host folded back when there were several must not hide everything now.
      if (!this.single && !this.isOpen(group.key)) return;
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
          const grouped = open && !this.expanded && Boolean(folder.key) && folder.sessions > 1;
          if (grouped) push(this.folderHeading(t, group, section, folder), `folder:${group.key}:${section.id}:${folder.key}`, HEIGHT.folder);
          for (const entry of folder.entries) if (open || entry.row.focused) add(entry.row, this.row(t, entry, section.id, now, grouped));
        }
      }
      if (!group.rows.length) push(div().pl(this.single ? 10 : 29).pr(12).pt(2).pb(6).text_size(11).text_color(t.muted)
        .child(group.layout === "ready" ? "No sessions yet · use + to start one" : group.layout === "loading" ? "Loading sessions…" : "Sessions appear when this host reconnects"), `empty:${group.key}`, HEIGHT.empty);
    });
    this.slide(t, children, keys, heights, compact, now);
    // Not while searching or filtering: there the list is results.
    if (!this.query.trim() && this.filter === "all") children.push(...this.extras(t, compact));
    setAgentOrder(this.visible.filter(r => r.kind === "agent" && !r.inner).map(r => r.address));
    // Drawn at their start: the next frame draws them at their end.
    let started = false;
    for (const change of [...this.fresh.values(), ...this.moves.values()]) if (change.step === 0) { change.step = 1; started = true; }
    if (started) this.pulse?.();
    const iconButton = (id, icon, tip, action) => div().id(id).size(26).flex_none().rounded(6).flex().items_center().justify_center()
      .role("button").accessibility_label(tip)
      .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(action).child(glyph(icon, 15));
    const empty = v_flex().px(14).py(24).gap(6)
      .child(div().text_size(12).child(this.query.trim() ? "No matching sessions" : EMPTY[this.filter] ?? "No sessions"))
      .child(div().text_size(11).text_color(t.muted).child(this.query.trim() ? "Try a task, shell, project, or host name." : "Choose All to see every session."));
    return v_flex().id("agent-sidebar").size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        const width = size.width / Number(settings().zoom ?? 1);
        if (this.width !== width) { this.width = width; cx.notify(); }
      })
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          // First Escape clears the search; the next returns to the current session.
          if (this.query) this.clearSearch(cx);
          else this.open(this.visible.find(r => r.focused));
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
        .child(h_flex().h(40).flex_none().pl(16).pr(10).gap(8).items_center()
          .child(div().font_semibold().text_size(15).child("Sessions"))
          .child(div().text_size(12).text_color(t.muted).child(String(tally.all)))
          .child(div().flex_1())
          .when(this.single, el => el.child(this.newButton(t, local, 26)))
          .child(this.densityButton(t))
          .child(this.settingsButton(t)))
        .child(this.search(t))
        .child(this.chips(t, tally)))
      .when(compact, el => el.child(h_flex().h(34).flex_none().justify_center().items_center()
        .child(iconButton("expand-agents", "panel-left", "Expand sessions", () => this.expand()))))
      .child(v_flex().id("host-agent-list").flex_1().min_h(0).px(6).pt(compact ? 0 : 2).pb(12).overflow_y_scrollbar().track_scroll(this.scroll)
        .role("list_box").accessibility_label(this.single ? "Sessions grouped by status" : "Sessions grouped by machine, then by status")
        .children(children)
        .when(!sections.length && !compact, el => el.child(empty)));
  }
}
