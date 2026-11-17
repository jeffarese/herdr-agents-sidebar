// The sidebar's own settings, behind its gear: a popup. Every choice is kept in Herdr's shared
// state, so each copy of the sidebar follows it at once, on every layout.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, closeOverlay, props, shared, setShared, updates } from "herdr";
import { SETTINGS_KEY, DENSITY_KEY, GROUP_KEY, settingsOf } from "./model.js";

// A popup is only as tall as what is in it, and a list that scrolls has no height of its own:
// so the panel is given one, as the launcher is.
export const SETTINGS = { width: 300, height: 560 };
const ICONS = "mods/agent-sidebar/";

// What each switch is, in the order shown: [key, label, what it means].
const LAYOUT = [
  ["folders", "Folder headings", "Grouped by status with compact rows: sessions working in one folder sit under its name"],
  ["subagents", "Sub-agents", "Claude Code's own sub-agents, listed under their session"],
  ["shells", "Shells and programs", "Terminals that run no agent"],
  ["away", "Machines that are away", "One dim line for each machine Herdr can't reach, after the others"],
];
const ROWS = [
  ["model", "Model", "Opus 5.5, Fable 5.2…: the model of the session's last turn"],
  ["effort", "Effort", "low, medium, high, xhigh or max"],
  ["effortColors", "Color the effort by its level", "From gray through blue, green and yellow to red"],
  ["activity", "What it is doing or asking", "The last step of a session that works, or what one that needs you wants"],
  ["context", "Context size", "The tokens its last turn was sent, when there is room"],
  ["changes", "Lines changed", "Since the last commit in its folder: git is asked every half minute"],
  ["pulls", "Pull request", "Its branch's pull request: the GitHub CLI is asked every five minutes"],
  ["age", "Time in its state", "How long it has worked, waited or been idle"],
];
const UNDER = [
  ["addMachine", "Add machine", "The line that connects another machine"],
  ["closed", "Recently closed", "Claude Code sessions that ended, to reopen"],
  ["cleanup", "Clean up old sessions", "A line that closes every session idle for too long, on a second click"],
];

export function initSettings(view) {
  view.panel = true;
}

export function renderSettings(view) {
  const t = /** @type {Record<string, import("gpui-kit").Color>} */ (theme());
  const cfg = settingsOf(shared(SETTINGS_KEY));
  const set = (key, value) => setShared(SETTINGS_KEY, { ...shared(SETTINGS_KEY), [key]: value });
  const heading = label => div().mt(12).mb(3).px(6).text_size(9.5).font_semibold().text_color(t.dim).child(label.toUpperCase());
  // One of a few: the chosen one is raised.
  const choice = (id, label, options, value, pick) => v_flex().id(id).px(6).py(3).gap(4)
    .child(div().text_size(11.5).text_color(t.muted).child(label))
    .child(h_flex().h(26).p(2).gap(2).rounded(7).bg(t.background).border(1).border_color(t.border)
      .children(options.map(([key, name, tip]) => h_flex().id(`${id}-${key}`).flex_1().min_w(0).h_full().rounded(5).items_center().justify_center()
        .role("button").aria_selected(value === key).accessibility_label(`${label}: ${name}`).cursor_pointer()
        .text_size(11.5).text_color(value === key ? t.foreground : t.muted)
        .when(value === key, el => el.bg(t.selected).font_medium())
        .when(value !== key, el => el.hover(s => s.bg(t.hover).text_color(t.foreground)))
        .when(Boolean(tip), el => el.tooltip(tip))
        .on_click((_e, cx) => { pick(key); cx.notify(); })
        .child(name))));
  // On or off: the whole line is the switch.
  const toggle = ([key, label, tip], off = false) => {
    const on = Boolean(cfg[key]);
    return h_flex().id(`set-${key}`).h(28).flex_none().px(6).gap(8).rounded(6).items_center()
      .role("button").aria_selected(on).accessibility_label(`${label}: ${on ? "on" : "off"}`).tooltip(tip)
      .cursor_pointer().hover(s => s.bg(t.hover)).when(off, el => el.opacity(0.45))
      .on_click((_e, cx) => { set(key, !on); cx.notify(); })
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(on ? t.foreground : t.muted).child(label))
      .child(div().relative().w(26).h(14).flex_none().rounded(7).bg(on ? t.accent : t.border)
        .child(div().absolute().top(2).left(on ? 14 : 2).size(10).rounded(5).bg(on ? t.background : t.muted)));
  };
  const density = shared(DENSITY_KEY) === "expanded" ? "expanded" : "compact";
  const group = ["space", "project"].includes(shared(GROUP_KEY)) ? shared(GROUP_KEY) : "status";
  const ready = Boolean(updates().app.ready);
  const link = (id, label, action) => h_flex().id(id).h(26).px(8).gap(6).rounded(6).items_center()
    .role("button").accessibility_label(label).cursor_pointer().text_size(11.5).text_color(t.muted)
    .hover(s => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => { action(); cx.notify(); }).child(label);
  return v_flex().id("sidebar-settings").w_full().h(SETTINGS.height).min_h(0).bg(t.popover).text_color(t.foreground)
    .on_key_down((e, cx) => {
      if (e.key !== "escape") return;
      cx.stop_propagation();
      closeOverlay(props().overlay);
    })
    .child(h_flex().h(36).flex_none().pl(14).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg(`${ICONS}settings.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().font_semibold().text_size(13).child("Sessions settings")))
    .child(v_flex().id("sidebar-settings-list").flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar()
      .child(heading("Layout"))
      .child(choice("set-density", "Rows", [["compact", "Compact", "One line a session"], ["expanded", "Expanded", "Two lines: the second says where it works and what it runs with"]],
        density, key => setShared(DENSITY_KEY, key)))
      .child(choice("set-group", "Group by", [["status", "Status", "Needs you, Done, Working, Pinned, Idle"], ["space", "Space", "Each of Herdr's spaces, with its sessions"], ["project", "Project", "Spaces of one name on every machine, as one"]],
        group, key => setShared(GROUP_KEY, key)))
      .children(LAYOUT.map(item => toggle(item)))
      .child(heading("On each session"))
      .children(ROWS.map(item => toggle(item, item[0] === "effortColors" && !cfg.effort)))
      .child(heading("Under the list"))
      .children(UNDER.map(item => toggle(item)))
      .child(choice("set-cleanupDays", "Old means idle for over", [[1, "A day"], [3, "3 days"], [7, "A week"]], cfg.cleanupDays, key => set("cleanupDays", key))
        .when(!cfg.cleanup, el => el.opacity(0.45)))
      .child(heading("Organize with Claude"))
      .child(toggle(["organize", "Organize button", "The star in the title bar: asks Claude how to arrange the sessions into spaces, and previews it"]))
      .child(choice("set-organizeModel", "Model", [["haiku", "Haiku", "Fastest"], ["sonnet", "Sonnet", "The default"], ["opus", "Opus", "Most careful, slowest"]], cfg.organizeModel, key => set("organizeModel", key))
        .when(!cfg.organize, el => el.opacity(0.45)))
      .child(choice("set-organizeEffort", "Effort", [["low", "Low"], ["medium", "Medium"], ["high", "High"]], cfg.organizeEffort, key => set("organizeEffort", key))
        .when(!cfg.organize, el => el.opacity(0.45)))
      .child(heading("Motion"))
      .child(toggle(["animations", "Animate changes", "Rows slide to their new place, and a new status fades in"])))
    .child(h_flex().h(38).flex_none().px(6).gap(4).items_center().border_t(1).border_color(t.border)
      // Herdr's own settings were behind this gear before: they stay one click away.
      .child(link("herdr-settings", ready ? "Herdr settings · update ready" : "Herdr settings…", () => { run("app.settings"); closeOverlay(props().overlay); })
        .when(ready, el => el.text_color(t.accent)))
      .child(div().flex_1())
      .child(link("settings-reset", "Reset", () => { setShared(SETTINGS_KEY, {}); setShared(DENSITY_KEY, "compact"); setShared(GROUP_KEY, "status"); })));
}
