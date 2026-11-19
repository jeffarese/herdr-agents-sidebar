// The window behind each machine's +: choose a folder, then a shell or an agent to start there.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { theme, knownAgents, machines, spaces, panes, focused, run, exec, home, closeOverlay, props, shared, setShared } from "herdr";
import { newSessionAction } from "./model.js";
import {
  RECENT_KEY, LAST_KEY, SCAN_KEY, AGENTS_KEY, SCAN_MS, SCAN, LIST, GROUPS, machineKey, basename, tilde,
  parseScan, parseList, pathQuery, knownFolders, searchFolders, insideFolders, remember, placement,
} from "./folders.js";

export const LAUNCHER = { width: 380, height: 520 };
const ART = "mods/agent-sidebar/";
const glyph = (name, size = 14) => svg(`${ART}${name}.svg`).size(size).flex_none();
const ROW = 30;
// Programs shown before the list scrolls.
const PROGRAMS_SHOWN = 6;
const NEXT_MACHINE = "agent_sidebar::NextMachine";
const PREV_MACHINE = "agent_sidebar::PrevMachine";

export function initLauncher(view, initial, cx) {
  view.query = "";
  view.index = 0;
  view.handle = cx.focus_handle();
  view.scroll = ScrollHandle.new();
  view.input = InputState.new({ placeholder: "Search folders or type a path…" });
  view.input.on("change", (_e, cx) => typed(view, view.input.value(), cx));
  view.input.on("submit", () => start(view, highlighted(view)));
  view.input.focus();
  // The window binds ⇥ to "focus the next control", which takes the key before on_key_down
  // hears it. Bindings in the launcher's own key context come first (the keymap is the app's:
  // once is enough).
  if (!globalThis.sessionLauncherKeys) {
    globalThis.sessionLauncherKeys = true;
    const keys = context => [
      { keystroke: "tab", action: NEXT_MACHINE, context },
      { keystroke: "shift-tab", action: PREV_MACHINE, context },
    ];
    // The search field's own context too, in case it binds ⇥ for itself.
    try { cx.bind_keys?.([...keys("SessionLauncher"), ...keys("SessionLauncher > Input")]); }
    catch { cx.bind_keys?.(keys("SessionLauncher")); }
  }
  // A popup can take the keyboard after its first frame.
  cx.timer?.after?.(300, () => view.input.focus());
  useMachine(view, initial.machine ?? null, initial, cx);
}

// Everything that belongs to one machine: on opening, and again each time ⇥ or a click in the
// header moves to another. What was typed stays, so the same search runs there.
function useMachine(view, machine, initial, cx) {
  view.machine = machine;
  view.key = machineKey(machine);
  // A space's own +: the session joins that space, whatever its folder.
  view.space = initial.space ?? null;
  view.chosen = initial.folder ? { path: initial.folder, tag: initial.tag ?? "Picked" } : null;
  view.index = 0;
  // "tab" or "space" once the person picks one, kept across folders; null follows the folder.
  view.where = null;
  // The program Enter starts: "shell" or a program key once ⌥↑↓ moves it; null: the last started.
  view.program = null;
  view.listing = null; // LIST's answer for the folder a typed path names
  view.listed = null; // which folder that is
  view.failed = false;
  view.scanned = shared(SCAN_KEY)?.[view.key] ?? null;
  view.home = machine == null ? home() : view.scanned?.home ?? null;
  // The last answer shows at once; a fresh one replaces it.
  view.choices = (shared(AGENTS_KEY)?.[view.key] ?? []).filter(agent => agent.installed);
  view.loading = !view.choices.length;
  view.scroll.scroll_to_item(0);
  // Answers that arrive after the person moved to another machine are kept, not shown.
  const key = view.key;
  cx.spawn(async cx => {
    let all = null;
    try {
      all = await knownAgents({ on: machine });
      setShared(AGENTS_KEY, { ...shared(AGENTS_KEY), [key]: all });
    } catch { /* Said below, if still on this machine. */ }
    if (view.machine !== machine) return;
    if (all) view.choices = all.filter(agent => agent.installed);
    else view.failed = true;
    view.loading = false;
    cx.notify();
  });
  if (!view.scanned || Date.now() - view.scanned.at > SCAN_MS) cx.spawn(async cx => {
    try {
      const result = await exec("sh", ["-c", SCAN], { on: machine, timeout: 8000 });
      if (result.code !== 0) return;
      const found = parseScan(result.stdout);
      const scanned = { ...found, at: Date.now() };
      setShared(SCAN_KEY, { ...shared(SCAN_KEY), [key]: scanned });
      if (view.machine !== machine) return;
      view.scanned = scanned;
      view.home ??= found.home;
      cx.notify();
    } catch { /* The open and recent folders are still offered. */ }
  });
  const path = pathQuery(view.query);
  if (path) list(view, path.dir, cx);
}

// The machines ⇥ moves between: the ready ones, and the one shown even if it is not.
function hosts(view) {
  return machines().filter(host => host.layout === "ready" || (host.name ?? null) === view.machine);
}

function switchMachine(view, machine, cx) {
  if (machine === view.machine) return;
  useMachine(view, machine, {}, cx);
  view.input.focus();
}

function cycleMachine(view, by, cx) {
  const names = hosts(view).filter(host => host.layout === "ready").map(host => host.name ?? null);
  if (!names.length) return;
  const at = names.indexOf(view.machine);
  const next = at < 0 ? (by > 0 ? 0 : names.length - 1) : (at + by + names.length) % names.length;
  switchMachine(view, names[next], cx);
}

function typed(view, value, cx) {
  const before = view.query;
  if (value === before) return;
  // "/" after a search, or after part of a name in a path, goes into the folder chosen:
  // "herd/" → "~/workspace/herdr/", "~/src/ap/" → "~/src/api/".
  if (value === `${before}/` && before.trim()) {
    const { folder } = current(view);
    if (folder && (!pathQuery(before) || folder.tag !== "This folder")) {
      value = `${tilde(folder.path, view.home)}/`.replace(/^\/\/$/, "/");
      // Set first: if set_value reports a change too, it finds nothing new.
      view.query = value;
      view.input.set_value(value);
    }
  }
  view.query = value;
  view.index = 0;
  view.scroll.scroll_to_item(0);
  const path = pathQuery(value);
  if (path && path.dir !== view.listed) list(view, path.dir, cx);
  cx.notify();
}

// Asks the machine what is inside the folder a typed path names.
function list(view, dir, cx) {
  const machine = view.machine;
  view.listed = dir;
  view.listing = null;
  cx.spawn(async cx => {
    let listing;
    try {
      const result = await exec("sh", ["-c", LIST, "sh", dir], { on: machine, timeout: 6000 });
      listing = result.code === 0 ? parseList(result.stdout) : { missing: true };
    } catch { listing = { missing: true }; }
    // The person may have typed on into another folder, or moved to another machine, meanwhile.
    if (view.listed !== dir || view.machine !== machine) return;
    view.listing = listing;
    view.home ??= listing.home ?? null;
    cx.notify();
  });
}

// The folders on show, and the one picked with where a session there would open.
function current(view) {
  const path = pathQuery(view.query);
  const folders = path
    ? (view.listing?.missing ? [] : insideFolders(view.listing, path.leaf))
    : searchFolders(knownFolders({
      machine: view.machine, chosen: view.chosen, focused: focused(), spaces: spaces(), panes: panes(),
      recent: shared(RECENT_KEY)?.[view.key] ?? [], scanned: view.scanned?.folders ?? [], home: view.home,
    }), view.query, view.home);
  const index = Math.min(view.index, Math.max(0, folders.length - 1));
  const folder = folders[index] ?? null;
  const { match, fallback } = placement(folder?.path, view.machine, spaces(), panes(), focused());
  const asked = view.space ? spaces().find(space => space.id === view.space) ?? null : null;
  const tabSpace = asked ?? match ?? fallback;
  const where = !tabSpace ? "space" : view.where ?? (asked || match ? "tab" : "space");
  return { path, folders, index, folder, tabSpace, where };
}

// What Enter starts: the program last started on this machine, else a shell.
function preferred(view) {
  const last = shared(LAST_KEY)?.[view.key];
  return last && last !== "shell" ? view.choices.find(agent => agent.key === last) ?? null : null;
}

// The program ⇥ moved to, else the preferred one. Null is a shell.
function highlighted(view) {
  if (view.program === "shell") return null;
  return view.choices.find(agent => agent.key === view.program) ?? preferred(view);
}

function cycle(view, by) {
  const programs = [null, ...view.choices];
  const at = programs.indexOf(highlighted(view));
  const next = programs[(Math.max(0, at) + by + programs.length) % programs.length];
  view.program = next?.key ?? "shell";
}

function start(view, program) {
  const { folder, where, tabSpace } = current(view);
  if (!folder) return;
  const action = newSessionAction(view.machine, machines(), spaces(), focused(), program,
    { folder: folder.path === "~" ? null : folder.path, space: where === "tab" ? tabSpace.id : null });
  if (!action) return;
  if (folder.path !== "~") setShared(RECENT_KEY, { ...shared(RECENT_KEY), [view.key]: remember(shared(RECENT_KEY)?.[view.key], folder.path) });
  setShared(LAST_KEY, { ...shared(LAST_KEY), [view.key]: program?.key ?? "shell" });
  closeOverlay(props().overlay);
  run(action.name, action.args);
}

// The system's picker belongs to this computer and outlives a popup: the sidebar opens it,
// then this launcher again with the folder picked.
function browse() {
  closeOverlay(props().overlay);
  run("agent-sidebar.browse");
}

function move(view, by, count) {
  if (!count) return;
  view.index = (Math.min(view.index, count - 1) + by + count) % count;
  view.scroll.scroll_to_item(view.positions?.get(view.index) ?? view.index);
}

function onKey(view, e, cx) {
  const { folders } = current(view);
  const programs = [null, ...view.choices];
  // ⌥1–9: Herdr's own keys take ⌘ and ⌃ with digits (tabs and spaces).
  const pick = e.modifiers?.alt && !e.modifiers.platform && !e.modifiers.control && /^[1-9]$/.exec(e.key ?? "");
  const arrow = e.key === "down" ? 1 : e.key === "up" ? -1 : 0;
  if (arrow && e.modifiers?.alt) cycle(view, arrow);
  else if (arrow) move(view, arrow, folders.length);
  else if (e.key === "tab") cycleMachine(view, e.modifiers?.shift ? -1 : 1, cx);
  else if (pick && Number(pick[0]) <= programs.length) start(view, programs[Number(pick[0]) - 1]);
  else if (e.keystroke === "cmd-o" && view.machine == null) browse();
  else return;
  cx.stop_propagation();
  cx.notify();
}

export function renderLauncher(view) {
  const t = theme();
  const available = machines().some(host => (host.name ?? null) === view.machine && host.layout === "ready");
  const { path, folders, index, folder, tabSpace, where } = current(view);
  const remote = view.machine != null;
  const programs = [null, ...view.choices];
  const usual = highlighted(view)?.key ?? null;
  const can = available && Boolean(folder);

  // Folders, under a heading per group while nothing is typed.
  const list = [];
  view.positions = new Map();
  const heading = text => list.push(div().h(24).flex_none().px(8).pt(6).text_size(10.5).font_medium().text_color(t.dim).child(text));
  let group = null;
  folders.forEach((entry, i) => {
    const label = path ? `${GROUPS.inside} ${tilde(view.listing?.dir ?? path.dir, view.home)}` : view.query.trim() ? null : GROUPS[entry.group];
    if (label && label !== group) heading(label);
    group = label;
    view.positions.set(i, list.length);
    list.push(folderRow(view, t, entry, i, i === index));
  });
  if (!folders.length) {
    const why = path ? (view.listing?.missing ? `No folder ${path.dir} on ${view.machine ?? "Local"}` : view.listing ? "No folder starts with that" : "Looking…")
      : "No folder matches. Type a path that starts with / or ~";
    list.push(div().px(8).py(10).text_size(11.5).text_color(t.muted).child(why));
  }

  const programRow = (program, i) => {
    const id = program ? `launch-${program.key}` : "launch-shell";
    const name = program ? program.name : "Shell";
    const icon = !program ? svg("icons/shell.svg").size(15).flex_none().text_color(t.muted)
      : !program.icon ? glyph("agent", 15).text_color(t.muted)
        : program.tint ? svg(program.icon).size(15).flex_none().text_color(t.foreground) : image(program.icon).size(15).flex_none();
    const on = (program?.key ?? null) === usual;
    const hint = on ? "↵" : i < 9 ? `⌥${i + 1}` : "";
    return h_flex().id(id).h(ROW).flex_none().px(8).gap(9).rounded(6).items_center()
      .role("button").aria_selected(on).accessibility_label(`Start ${name} in ${folder ? tilde(folder.path, view.home) : "no folder"} on ${view.machine ?? "Local"}`)
      .text_color(can ? t.foreground : t.muted)
      .when(on, el => el.bg(t.selected))
      .when(can && !on, el => el.hover(s => s.bg(t.hover)))
      .when(can, el => el.cursor_pointer())
      .on_click(() => start(view, program))
      .child(icon).child(div().flex_1().min_w(0).truncate().child(name))
      .when(Boolean(hint), el => el.child(div().flex_none().px(5).h(18).rounded(4).flex().items_center()
        .text_size(10).text_color(t.dim).when(hint === "↵", k => k.bg(t.raised).text_color(t.muted)).child(hint)));
  };
  const notice = !available ? "Host unavailable" : view.loading ? "Checking installed agents…"
    : view.failed ? "Could not check agents. A shell still starts." : !view.choices.length ? "No agents installed on this host" : "";
  const shown = Math.min(programs.length, PROGRAMS_SHOWN);

  return v_flex().id("session-launcher").w_full().h(LAUNCHER.height).min_h(0).p(8).gap(6).bg(t.popover).text_size(12.5)
    .track_focus(view.handle).key_context("SessionLauncher").on_key_down((e, cx) => onKey(view, e, cx))
    .on_action(NEXT_MACHINE, (_e, cx) => { cycleMachine(view, 1, cx); cx.stop_propagation(); cx.notify(); })
    .on_action(PREV_MACHINE, (_e, cx) => { cycleMachine(view, -1, cx); cx.stop_propagation(); cx.notify(); })
    .child(header(view, t, remote))
    .child(searchBox(view, t))
    .child(v_flex().id("launcher-folders").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(view.scroll)
      .role("list_box").accessibility_label("Folders").children(list))
    .child(div().h(1).flex_none().bg(t.border))
    .child(h_flex().h(26).flex_none().px(4).gap(6).items_center()
      .child(div().flex_none().text_size(11).text_color(t.muted).child("Start in"))
      .child(div().min_w(0).truncate().font_medium().text_color(folder ? t.foreground : t.dim)
        .child(folder ? basename(tilde(folder.path, view.home)) : "no folder"))
      .child(div().flex_1())
      .child(whereControl(view, t, tabSpace, where)))
    .child(v_flex().id("launcher-programs").h(shown * ROW).flex_none().min_h(0).overflow_y_scrollbar()
      .children(programs.map(programRow)))
    .when(Boolean(notice), el => el.child(div().px(8).text_size(11).text_color(t.muted).child(notice)))
    .child(h_flex().h(18).flex_none().px(4).gap(10).items_center().text_size(10).text_color(t.dim)
      .when(hosts(view).length > 1, el => el.child("⇥ machine"))
      .child("↑↓ folder").child("⌥↑↓ program").child("/ open folder").child("↵ start"));
}

// The machine it starts on. With more than one, each is a tab to click (or ⇥ to).
function header(view, t, remote) {
  const all = hosts(view);
  if (all.length < 2) return h_flex().h(26).px(4).gap(8).items_center()
    .child(glyph(remote ? "server" : "computer", 15).text_color(remote ? t.ansi4 : t.accent))
    .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(view.machine ?? "Local"))
    .when(remote, el => el.child(glyph("globe", 12).text_color(t.ansi4)))
    .child(div().flex_1())
    .child(div().text_size(10.5).text_color(t.dim).child("New session"));
  const chip = host => {
    const name = host.name ?? null;
    const on = name === view.machine;
    const ready = host.layout === "ready";
    const label = name ?? "Local";
    const tint = name == null ? t.accent : t.ansi4;
    return h_flex().id(`machine-${name ?? "local"}`).h(22).min_w(0).px(7).gap(6).rounded(5).items_center()
      .role("tab").aria_selected(on).accessibility_label(`New session on ${label}`).tooltip(ready ? label : `${label} · unavailable`)
      .text_size(11.5).text_color(on ? t.foreground : t.muted)
      .when(on, el => el.bg(t.selected).font_semibold())
      .when(!on && ready, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => {
        switchMachine(view, name, cx);
        cx.notify();
      }))
      .child(glyph(name == null ? "computer" : "server", 13).text_color(on && ready ? tint : t.muted))
      .child(div().min_w(0).truncate().child(label));
  };
  return h_flex().h(26).flex_none().min_w(0).gap(4).items_center()
    .child(h_flex().id("launcher-machines").min_w(0).p(2).gap(2).rounded(7).bg(t.background).border(1).border_color(t.border)
      .role("tab_list").accessibility_label("Machine").children(all.map(chip)))
    .child(div().flex_1())
    .child(div().flex_none().text_size(10.5).text_color(t.dim).child("New session"));
}

function folderRow(view, t, entry, i, on) {
  const shown = tilde(entry.path, view.home);
  const name = shown === "~" ? "Home" : basename(shown);
  const parent = shown === "~" || shown === "/" ? shown : shown.slice(0, Math.max(1, shown.length - basename(shown).length - 1));
  return h_flex().id(`folder-${i}`).h(ROW).flex_none().min_w(0).px(8).gap(8).rounded(6).items_center()
    .role("list_box_option").aria_selected(on).accessibility_label(`${shown}${entry.tag ? `, ${entry.tag}` : ""}`)
    .cursor_pointer().tooltip(shown)
    .when(on, el => el.bg(t.selected)).when(!on, el => el.hover(s => s.bg(t.hover)))
    .on_click((e, cx) => {
      view.index = i;
      // A double click starts what Enter would.
      if (e?.click_count >= 2) start(view, highlighted(view));
      cx?.notify();
    })
    .child(glyph(entry.tag === "This folder" ? "folder-open" : "folder", 14).text_color(on ? t.foreground : t.muted))
    .child(div().flex_none().max_w(170).truncate().text_color(t.foreground).when(on, el => el.font_medium()).child(name))
    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(name === shown ? "" : parent))
    .when(Boolean(entry.tag), el => el.child(div().flex_none().max_w(110).truncate().text_size(10).text_color(t.dim).child(entry.tag)));
}

function searchBox(view, t) {
  const button = (id, icon, tip, action) => div().id(id).size(22).flex_none().rounded(4).flex().items_center().justify_center()
    .role("button").accessibility_label(tip).tooltip(tip)
    .cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => { cx?.stop_propagation(); action(cx); }).child(glyph(icon, 13));
  return h_flex().h(32).flex_none().pl(9).pr(4).gap(7).rounded(7).bg(t.background).border(1).border_color(t.border).items_center()
    .child(glyph("search", 13).text_color(t.muted))
    .child(Input.new(view.input).accessibility_label("Search folders or type a path").flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
    .when(Boolean(view.query), el => el.child(button("launcher-clear", "x", "Clear", cx => {
      view.input.set_value("");
      typed(view, "", cx);
    })))
    .when(view.machine == null, el => el.child(button("launcher-browse", "folder-open", "Choose a folder… (⌘O)", () => browse())));
}

// A tab in a space there, or a space of its own. Without a space there, only a space.
function whereControl(view, t, tabSpace, where) {
  if (!tabSpace) return div().text_size(10.5).text_color(t.dim).child("New space");
  const chip = (id, label, tip, value) => div().id(id).h(20).px(7).max_w(150).rounded(4).flex().items_center()
    .role("button").aria_selected(where === value).accessibility_label(tip).tooltip(tip)
    .cursor_pointer().text_size(10.5).truncate()
    .text_color(where === value ? t.foreground : t.muted)
    .when(where === value, el => el.bg(t.selected)).when(where !== value, el => el.hover(s => s.bg(t.hover)))
    .on_click((_e, cx) => { view.where = value; cx?.notify(); })
    .child(label);
  return h_flex().flex_none().p(2).gap(2).rounded(6).bg(t.background).border(1).border_color(t.border)
    .child(chip("where-tab", `Tab in ${tabSpace.name}`, `A new tab in the space ${tabSpace.name}`, "tab"))
    .child(chip("where-space", "New space", "A new space of its own", "space"));
}
