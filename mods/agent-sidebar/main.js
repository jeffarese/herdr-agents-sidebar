import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle } from "gpui-base";
import { agents, terminals, panes, spaces, machines, focused, theme, settings, run, setAgentOrder, nextCommand, openOverlay, props, shared, setShared, updates, exec, pickFolder } from "herdr";
import { build, groups, counts, WORDS, BACKGROUND, modelName, fitWhere, openAction, closeAction, duration, backgroundLines, machineOf, shortPath, holdDone, dropLeaving } from "./model.js";
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
        // A second, or less when an answer arrives.
        await Promise.race([cx.sleep(1000), new Promise(resolve => { wake = resolve; })]);
        // A session held back as leaving comes back if it is still there after LEAVE_MS.
        if (this.changed || this.leaving.size) {
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
    const view = [this.expanded, this.bySpace, this.width, this.single, compact].join("|");
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
    return [row.title, context, host, state, this.usesText(row), ...backgroundLines(row, now), row.inner ? "" : row.address, row.cwd, from].filter(Boolean).join("\n");
  }

  // "Opus 5.5 · xhigh effort": what the session's last turn ran with, when its machine said.
  usesText(row) {
    const name = modelName(row.model);
    return name ? [name.label, row.effort ? `${row.effort} effort` : ""].filter(Boolean).join(" · ") : "";
  }

  // The same, at a glance, in words: `label` is the model's name, or none where there is no
  // room for it. The effort is the brighter of the two: it is what differs between sessions.
  uses(t, row, label) {
    const effort = row.effort ?? "";
    if (!label && !effort) return null;
    return h_flex().id(`uses-${row.address}`).flex_none().gap(3).items_center().text_size(10.5).text_color(t.dim).tooltip(this.usesText(row))
      .when(Boolean(label), el => el.child(div().child(label)))
      .when(Boolean(label && effort), el => el.child(div().child("·")))
      .when(Boolean(effort), el => el.child(div().text_color(t.muted).child(effort)));
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
    let model = "";
    let shown = Boolean(name);
    let where = row.inner ? row.space : [shortPath(row.cwd), row.branch].filter(Boolean).join(" · ");
    let room = Math.floor(px / 6.5);
    if (expanded && name) {
      const line = Math.floor(px / 5.6);
      model = where.length + said(name.label).length + 2 <= line ? name.label : name.family;
      if (!row.inner) where = fitWhere(shortPath(row.cwd), row.branch, line - said(model).length - 2);
    } else if (name) {
      const fits = [said(name.family), effort].filter(Boolean).find(text => row.title.length + text.length + 2 <= room);
      shown = Boolean(fits);
      model = fits === effort ? "" : name.family;
      if (fits) room -= fits.length + 2;
    }
    const detail = !expanded && !(grouped && !row.inner) && folder && !row.title.toLowerCase().includes(folder.toLowerCase())
      && row.title.length + folder.length + 2 <= room ? folder : "";
    const uses = shown ? this.uses(t, row, model) : null;
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
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(where || " "))
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
    // A space's own color, as Herdr's tabs show it; folded, what it holds.
    const tint = section.space ? shared("space.colors")?.[section.space] : null;
    const dot = tint ? t[tint] : null;
    return h_flex().id(`section-${key}`).h(HEIGHT.section).flex_none().pl(10).pr(8).gap(6).items_center()
      .role("button").accessibility_label(`${section.label}, ${n} ${n === 1 ? "session" : "sessions"}, ${open ? "expanded" : "collapsed"}`)
      .cursor_pointer().rounded(5).text_size(10.5).font_medium()
      .hover(s => s.bg(t.hover))
      .on_click((_e, cx) => this.toggle(key, cx))
      .when(Boolean(dot), el => el.child(div().size(6).flex_none().rounded(3).bg(dot)))
      .child(div().min_w(0).truncate().text_color(color).child(section.label))
      .child(div().flex_none().text_color(t.dim).child(String(n)))
      .child(div().flex_1())
      .when(Boolean(section.space !== undefined) && !open, el => el.children(this.summary(t, { rows: section.entries.map(entry => entry.row) })))
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

  // `firstAway`: the first of the unreachable hosts, which sit together after the others.
  host(t, group, compact, first, firstAway) {
    const open = this.hostOpen(group);
    if (isAway(group)) return this.away(t, group, compact, open, firstAway && !first);
    const color = group.remote ? t.ansi4 : t.accent;
    const state = hostState(group);
    const add = this.newButton(t, group);
    const kind = shared(KINDS_KEY)?.[group.name ?? ""];
    const icon = KIND_ICON[kind] ?? (group.remote ? "server" : "computer");
    const label = `${group.remote ? "Remote" : "Local"} host ${group.label}, ${counts(group.rows).all} sessions${state ? `, ${state}` : ""}, ${open ? "expanded" : "collapsed"}`;
    const root = h_flex().id(`host-${group.key}`).flex_none().items_center()
      .role("button").accessibility_label(label).cursor_pointer()
      .tooltip(`${group.remote ? "Remote host" : "Local machine"}: ${group.label}${KIND_ICON[kind] ? ` · ${kind}` : ""}${state ? ` · ${state}` : ""}`)
      .on_click((_e, cx) => this.toggle(group.key, cx));
    if (compact) return root.h(30).px(6).gap(4).justify_center().when(!first, el => el.mt(4).border_t(1).border_color(t.border))
      .child(glyph(icon, 14).text_color(color)).child(add);
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
      .child(add);
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
    const all = holdDone(dropLeaving(built, this.leaving, this.placed, placed, now), this.shown ?? new Map());
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
    const tally = counts(all);
    this.bySpace = shared(GROUP_KEY) === "space";
    const sections = groups(all, hosts, this.bySpace ? "space" : "status");
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
          const grouped = open && !this.expanded && Boolean(folder.key) && folder.sessions > 1;
          if (grouped) push(this.folderHeading(t, group, section, folder), `folder:${group.key}:${section.id}:${folder.key}`, HEIGHT.folder);
          for (const entry of folder.entries) if (open || entry.row.focused) add(entry.row, this.row(t, entry, section.id, now, grouped));
        }
      }
      if (!group.rows.length) push(div().pl(this.single ? 10 : 29).pr(12).pt(1).pb(5).text_size(11).text_color(t.muted)
        .child(group.layout === "ready" ? "No sessions yet · use + to start one" : group.layout === "loading" ? "Loading sessions…" : "Sessions appear when this host reconnects"), `empty:${group.key}`, HEIGHT.empty);
    });
    this.slide(t, children, keys, heights, compact, now);
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
          // Back to the current session.
          this.selected = null;
          this.open(this.visible.find(r => r.focused));
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
          .when(this.single, el => el.child(this.newButton(t, local, 26)))
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
