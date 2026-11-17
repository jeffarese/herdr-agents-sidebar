// The sidebar's own settings, behind its gear: a window with a tab for each kind of choice.
// Every choice is kept in Herdr's shared state, so each copy of the sidebar follows it at once,
// on every layout.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, closeOverlay, props, shared, setShared, updates } from "herdr";
import { SETTINGS_KEY, DENSITY_KEY, GROUP_KEY, settingsOf } from "./model.js";

// A window's content has no height of its own (its list scrolls): so it is given one.
export const SETTINGS = { width: 660, height: 520 };
const ICONS = "mods/agent-sidebar/";

// The tabs, in order: [key, name, what it is about].
export const SETTINGS_TABS = [
  ["layout", "Layout", "How the list is arranged."],
  ["list", "List", "What is listed, and the lines under the list."],
  ["sessions", "Sessions", "What each session's row says. Its tooltip always has all of it."],
  ["organize", "Organize", "The star in the title bar asks an AI how to arrange the sessions into spaces, and previews its answer. Nothing moves until you apply it."],
];
// On or off: [key, label, what it means].
const SWITCHES = {
  layout: [
    ["folders", "Folder headings", "Grouped by status with compact rows, sessions working in one folder sit under its name."],
    ["animations", "Animate changes", "Rows slide to their new place, and a new status fades in."],
  ],
  list: [
    ["subagents", "Sub-agents", "Claude Code's own sub-agents, under their session. Hidden, they still keep it in Working."],
    ["shells", "Shells and programs", "Terminals that run no agent."],
    ["away", "Machines that are away", "One dim line for each machine Herdr can't reach, after the others."],
    ["addMachine", "Add machine", "The line that connects another machine."],
    ["closed", "Recently closed", "Claude Code sessions that ended, to reopen where they left off."],
    ["cleanup", "Clean up old sessions", "A line that closes every session idle for too long, on a second click."],
  ],
  sessions: [
    ["model", "Model", "Opus 5.5, Fable 5.2…: the model of the session's last turn."],
    ["effort", "Effort", "low, medium, high, xhigh or max."],
    ["effortColors", "Color the effort by its level", "From gray through blue, green and yellow to red."],
    ["activity", "What it is doing or asking", "The last step of a session that works, or what one that needs you wants."],
    ["context", "Context size", "The tokens its last turn was sent, when there is room."],
    ["changes", "Lines changed", "Since the last commit in its folder. Off, git is not asked."],
    ["pulls", "Pull request", "Its branch's pull request. Off, the GitHub CLI is not asked."],
    ["age", "Time in its state", "How long it has worked, waited or been idle."],
  ],
};

export function initSettings(view) {
  view.panel = true;
  view.tab = SETTINGS_TABS[0][0];
}

export function renderSettings(view) {
  const t = /** @type {Record<string, import("gpui-kit").Color>} */ (theme());
  const cfg = settingsOf(shared(SETTINGS_KEY));
  const set = (key, value) => setShared(SETTINGS_KEY, { ...shared(SETTINGS_KEY), [key]: value });
  const close = () => closeOverlay(props().overlay);
  const words = (label, hint) => v_flex().flex_1().min_w(0).gap(1)
    .child(div().text_size(12.5).child(label))
    .when(Boolean(hint), el => el.child(div().text_size(11).text_color(t.dim).child(hint)));
  // On or off: the whole line is the switch.
  const toggle = ([key, label, hint], off = false) => {
    const on = Boolean(cfg[key]);
    return h_flex().id(`set-${key}`).flex_none().px(8).py(7).gap(14).rounded(7).items_center()
      .role("button").aria_selected(on).accessibility_label(`${label}: ${on ? "on" : "off"}`)
      .cursor_pointer().hover(s => s.bg(t.hover)).when(off, el => el.opacity(0.45))
      .on_click((_e, cx) => { set(key, !on); cx.notify(); })
      .child(words(label, hint))
      .child(div().relative().w(30).h(16).flex_none().rounded(8).bg(on ? t.accent : t.border)
        .child(div().absolute().top(2).left(on ? 16 : 2).size(12).rounded(6).bg(on ? t.background : t.muted)));
  };
  // One of a few: the chosen one is raised.
  const choice = (id, label, hint, options, value, pick, off = false) => v_flex().id(id).flex_none().px(8).py(7).gap(6).when(off, el => el.opacity(0.45))
    .child(words(label, hint))
    .child(h_flex().h(28).p(2).gap(2).rounded(7).bg(t.background).border(1).border_color(t.border)
      .children(options.map(([key, name, tip]) => h_flex().id(`${id}-${key}`).flex_1().min_w(0).h_full().rounded(5).items_center().justify_center()
        .role("button").aria_selected(value === key).accessibility_label(`${label}: ${name}`).cursor_pointer()
        .text_size(12).text_color(value === key ? t.foreground : t.muted)
        .when(value === key, el => el.bg(t.selected).font_medium())
        .when(value !== key, el => el.hover(s => s.bg(t.hover).text_color(t.foreground)))
        .when(Boolean(tip), el => el.tooltip(tip))
        .on_click((_e, cx) => { pick(key); cx.notify(); })
        .child(name))));
  const density = shared(DENSITY_KEY) === "expanded" ? "expanded" : "compact";
  const group = ["space", "project"].includes(shared(GROUP_KEY)) ? shared(GROUP_KEY) : "status";
  const codex = cfg.organizeWith === "codex";
  const pages = {
    layout: () => [
      choice("set-density", "Rows", "Expanded gives each session a second line: where it works, what it does and what it runs with.",
        [["compact", "Compact"], ["expanded", "Expanded"]], density, key => setShared(DENSITY_KEY, key)),
      choice("set-group", "Group by", "Status: Needs you, Done, Working, Pinned, Idle. Space: each of Herdr's spaces. Project: spaces of one name on every machine, as one.",
        [["status", "Status"], ["space", "Space"], ["project", "Project"]], group, key => setShared(GROUP_KEY, key)),
      ...SWITCHES.layout.map(item => toggle(item)),
    ],
    list: () => [
      ...SWITCHES.list.map(item => toggle(item)),
      choice("set-cleanupDays", "Old means idle for over", "", [[1, "A day"], [3, "3 days"], [7, "A week"]], cfg.cleanupDays, key => set("cleanupDays", key), !cfg.cleanup),
    ],
    sessions: () => SWITCHES.sessions.map(item => toggle(item, item[0] === "effortColors" && !cfg.effort)),
    organize: () => [
      toggle(["organize", "Organize button", "The star in the title bar."]),
      choice("set-organizeWith", "Ask", "Through the claude or the codex command on this computer, which must be installed and signed in.",
        [["claude", "Claude Code"], ["codex", "Codex"]], cfg.organizeWith, key => set("organizeWith", key), !cfg.organize),
      // Each takes the latest model of the family chosen: Claude Code by the family's name,
      // Codex from its own list of models.
      codex ? choice("set-organizeCodex", "Model", "The latest of the family. Auto leaves it to Codex's own default.",
        [["auto", "Auto"], ["luna", "Luna"], ["terra", "Terra"], ["sol", "Sol"], ["astra", "Astra"]], cfg.organizeCodex, key => set("organizeCodex", key), !cfg.organize)
        : choice("set-organizeModel", "Model", "The latest of the family.",
          [["haiku", "Haiku"], ["sonnet", "Sonnet"], ["opus", "Opus"]], cfg.organizeModel, key => set("organizeModel", key), !cfg.organize),
      choice("set-organizeEffort", "Effort", "Low is quick and enough for most lists.",
        [["low", "Low"], ["medium", "Medium"], ["high", "High"]], cfg.organizeEffort, key => set("organizeEffort", key), !cfg.organize),
      div().id("organize-sends").px(8).pt(6).text_size(11).text_color(t.dim)
        .child(`Asking sends each session's title, folder, branch and space name to ${codex ? "OpenAI" : "Anthropic"}.`),
    ],
  };
  const tab = pages[view.tab] ? view.tab : SETTINGS_TABS[0][0];
  const [, name, about] = SETTINGS_TABS.find(([key]) => key === tab);
  const ready = Boolean(updates().app.ready);
  const button = (id, label, action, strong = false) => h_flex().id(id).h(28).px(12).flex_none().rounded(6).items_center()
    .role("button").accessibility_label(label).cursor_pointer().text_size(12)
    .when(strong, el => el.bg(t.accent).text_color(t.background).font_medium().hover(s => s.opacity(0.88)))
    .when(!strong, el => el.text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)))
    .on_click((_e, cx) => { action(); cx.notify(); }).child(label);
  return v_flex().id("sidebar-settings").w_full().h(SETTINGS.height).min_h(0).bg(t.popover).text_color(t.foreground)
    .on_key_down((e, cx) => {
      if (e.key !== "escape") return;
      cx.stop_propagation();
      close();
    })
    .child(h_flex().h(46).flex_none().pl(16).pr(10).gap(9).items_center().border_b(1).border_color(t.border)
      .child(svg(`${ICONS}settings.svg`).size(15).flex_none().text_color(t.muted))
      .child(div().flex_1().font_semibold().text_size(14).child("Sessions settings"))
      .child(div().id("settings-close").size(26).flex_none().rounded(6).flex().items_center().justify_center()
        .role("button").accessibility_label("Close").tooltip("Close · Esc").cursor_pointer().text_color(t.muted)
        .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(() => close())
        .child(svg(`${ICONS}x.svg`).size(14).flex_none())))
    .child(h_flex().flex_1().min_h(0)
      // The tabs, down the left.
      .child(v_flex().id("settings-tabs").w(150).flex_none().h_full().p(8).gap(2).border_r(1).border_color(t.border)
        .children(SETTINGS_TABS.map(([key, label]) => h_flex().id(`tab-${key}`).h(30).flex_none().px(10).rounded(6).items_center()
          .role("tab").aria_selected(tab === key).accessibility_label(label).cursor_pointer().text_size(12.5)
          .text_color(tab === key ? t.foreground : t.muted)
          .when(tab === key, el => el.bg(t.selected).font_medium())
          .when(tab !== key, el => el.hover(s => s.bg(t.hover).text_color(t.foreground)))
          .on_click((_e, cx) => { view.tab = key; cx.notify(); })
          .child(label))))
      // The tab chosen.
      .child(v_flex().id("sidebar-settings-list").flex_1().min_w(0).h_full().min_h(0).px(12).pt(12).pb(10).gap(1).overflow_y_scrollbar()
        .child(v_flex().flex_none().px(8).pb(8).gap(2)
          .child(div().font_semibold().text_size(14).child(name))
          .child(div().text_size(11.5).text_color(t.muted).child(about)))
        .children(pages[tab]())))
    .child(h_flex().h(48).flex_none().px(10).gap(6).items_center().border_t(1).border_color(t.border)
      // Herdr's own settings were behind this gear before: they stay one click away.
      .child(button("herdr-settings", ready ? "Herdr settings · update ready" : "Herdr settings…", () => { run("app.settings"); close(); })
        .when(ready, el => el.text_color(t.accent)))
      .child(div().flex_1())
      .child(button("settings-reset", "Reset to defaults", () => { setShared(SETTINGS_KEY, {}); setShared(DENSITY_KEY, "compact"); setShared(GROUP_KEY, "status"); }))
      .child(button("settings-done", "Done", () => close(), true)));
}
