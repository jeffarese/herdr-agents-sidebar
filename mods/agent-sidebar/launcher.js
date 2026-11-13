import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, knownAgents, machines, spaces, focused, run, closeOverlay, props } from "herdr";
import { newSessionAction } from "./model.js";

export function initLauncher(view, initial, cx) {
  view.machine = initial.machine ?? null;
  view.choices = [];
  view.loading = true;
  view.handle = cx.focus_handle();
  view.handle.focus();
  cx.spawn(async cx => {
    try { view.choices = (await knownAgents({ on: view.machine })).filter(agent => agent.installed); }
    catch { view.failed = true; }
    view.loading = false;
    cx.notify();
  });
}

export function renderLauncher(view) {
  const t = theme();
  const available = machines().some(host => host.name === view.machine && host.layout === "ready");
  const start = program => {
    const action = newSessionAction(view.machine, machines(), spaces(), focused(), program);
    if (!action) return;
    closeOverlay(props().overlay);
    run(action.name, action.args);
  };
  const row = (id, icon, label, action) => h_flex().id(id).h(32).flex_none().px(9).gap(9).rounded(6).items_center()
    .role("button").accessibility_label(`${label} on ${view.machine ?? "this computer"}`)
    .text_color(available ? t.foreground : t.muted)
    .when(available, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
    .on_click(action).child(icon).child(label);
  // A scroll container needs a definite parent height or its agent rows collapse to zero.
  const height = Math.min(400, 124 + Math.max(1, view.choices.length) * 32);
  return v_flex().id("session-launcher").w_full().h(height).min_h(0).p(6).gap(3).bg(t.popover).text_size(12.5).track_focus(view.handle)
    .child(h_flex().px(9).h(30).gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(view.machine ?? "This computer"))
      .child(div().text_size(9).text_color(t.muted).child(view.machine == null ? "LOCAL" : "REMOTE")))
    .child(row("launch-shell", svg("icons/shell.svg").size(15), "New shell", () => start(null)))
    .child(div().h(1).mx(9).my(4).bg(t.border))
    .child(div().px(9).py(3).text_size(10.5).text_color(t.muted).child("Start an agent"))
    .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().children(view.choices.map(program => row(
      `launch-${program.key}`, program.icon ? (program.tint ? svg(program.icon).size(15) : image(program.icon).size(15))
        : svg("mods/agent-sidebar/agent.svg").size(15), program.name, () => start(program)))))
    .when(!available || view.loading || view.failed || !view.choices.length, el => el.child(div().px(9).py(8).text_size(11).text_color(t.muted)
      .child(!available ? "Host unavailable" : view.loading ? "Checking installed agents…" : view.failed ? "Could not check agents. Shell is still available." : "No agents installed on this host")));
}
