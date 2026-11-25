import { View, svg } from "gpui-kit";
import { Button, h_flex } from "gpui-base";
import { checking, exec, home, layout, panes, run, setShared, shared, spaces, theme } from "herdr";

const activeTab = () => spaces().find(space => space.active)?.tabs.find(tab => tab.active)?.id;

function find(node, id) {
  if (node?.id === id) return node;
  return node?.children?.map(child => find(child, id)).find(Boolean);
}

export default class SuperagentHeader extends View {
  init(_props, cx) {
    if (checking()) return;
    cx.timer.every(1500, cx => this.discover(cx));
    this.discover(cx);
  }

  discover(cx) {
    const tab = activeTab();
    if (!tab || this.busy) return;
    this.busy = true;
    cx.spawn(async cx => {
      try {
        const panesForTab = panes().filter(p => p.tab === tab && /^[a-zA-Z0-9_-]+$/.test(p.terminal ?? ""))
          .sort((a, b) => Number(b.focused) - Number(a.focused));
        const results = await Promise.all(panesForTab.map(async ({ terminal }) => {
          try {
            const r = await exec("/usr/bin/curl", ["-fsS", "--max-time", "1", "--unix-socket", `${home()}/.pi/sa/${terminal}.sock`, "http://localhost/ready"], { timeout: 2000 });
            return r.code === 0 && JSON.parse(r.stdout).ready === true ? terminal : null;
          } catch { return null; }
        }));
        if (tab !== activeTab()) return;
        const terminal = results.find(Boolean) ?? null;
        const key = `superagent.terminal.${tab}`;
        if ((shared(key) ?? null) !== terminal) setShared(key, terminal);
      } finally { this.busy = false; }
    });
  }

  render() {
    const t = theme(), root = layout(), tab = activeTab();
    const open = !find(root, "panel")?.hidden && find(root, "panel-body")?.active === "superagent";
    return h_flex().size_full().items_center().justify_center().bg(t.chrome).border_b(1).border_color(t.border)
      .when(Boolean(open || (tab && shared(`superagent.terminal.${tab}`))), el => el.child(
        Button.new("superagent-toggle").h(26).px(8).gap(5).flex().items_center().rounded(6).text_size(12)
          .bg(open ? t.selected : t.chrome).text_color(open ? t.foreground : t.muted).selected(open)
          .hover(h => h.bg(t.hover)).focus(f => f.border_1().border_color(t.accent)).accessibility_label("Toggle Superagent sidebar")
          .on_click(() => {
            if (open) run("layout.hide", { id: "panel" });
            else {
              run("layout.select", { stack: "panel-body", child: "superagent" });
              run("layout.show", { id: "panel" });
            }
          })
          .child(svg("mods/superagent/superagent.svg").size(14)).child("Superagent")));
  }
}
