import { View, div } from "gpui-kit";
import { Button, Link, h_flex, v_flex } from "gpui-base";
import { checking, exec, home, layout, panes, run, shared, spaces, theme } from "herdr";

function target() {
  const tab = spaces().find(s => s.active)?.tabs.find(t => t.active)?.id;
  const terminal = tab && shared(`superagent.terminal.${tab}`);
  if (typeof terminal === "string" && /^[a-zA-Z0-9_-]+$/.test(terminal) && panes().some(p => p.tab === tab && p.terminal === terminal)) return terminal;
}

function visible(node) {
  if (!node || node.hidden) return false;
  if (node.id === "panel-body") return node.active === "superagent";
  return node.children?.some(visible) ?? false;
}

export default class Superagent extends View {
  init(_props, cx) {
    if (checking()) return;
    cx.timer.every(1000, cx => this.update(cx));
    this.update(cx);
  }

  update(cx, action, terminal = target()) {
    if (!terminal || terminal !== target() || !visible(layout())) return;
    if (this.busy) {
      if (action && !this.action && !this.pending) { this.pending = { action, terminal }; cx.notify(); }
      return;
    }
    if (terminal !== this.terminal) {
      this.terminal = terminal;
      this.snapshot = this.error = this.disconnected = this.expandedError = undefined;
      this.showArchive = false;
    }
    this.busy = true;
    this.action = action;
    if (action) { this.error = undefined; cx.notify(); }
    cx.spawn(async cx => {
      const request = async (route, method) => {
        const limit = method === "GET" ? 4 : 20;
        const r = await exec("/usr/bin/curl", ["-sS", "--max-time", String(limit), "--unix-socket", `${home()}/.pi/sa/${terminal}.sock`, "-X", method, `http://localhost/${route}`], { timeout: (limit + 1) * 1000 });
        if (r.code === 28 && method === "POST") throw new Error("Request timed out. Check the item's status before retrying.");
        if (r.code !== 0) throw new Error("Pi session disconnected. Run /superagent in the Pi terminal to reconnect.");
        const data = JSON.parse(r.stdout);
        if (route !== "status" && data.error) throw new Error(data.error);
        return data;
      };
      try {
        if (action) await request(action, "POST");
      } catch (e) { if (terminal === target()) this.error = String(e.message); }
      try {
        const snapshot = await request("status", "GET");
        if (terminal === target()) { this.snapshot = snapshot; this.disconnected = undefined; }
      } catch (e) {
        if (terminal === target()) this.disconnected = String(e.message);
      } finally {
        this.busy = false;
        this.action = undefined;
        const pending = this.pending;
        this.pending = undefined;
        if (pending) this.update(cx, pending.action, pending.terminal);
        cx.notify();
      }
    });
  }

  render() {
    const terminal = target(), current = terminal && terminal === this.terminal;
    const t = theme(), s = current ? this.snapshot : undefined, items = [...(s?.items ?? [])].reverse();
    const archived = s?.archivedItems;
    const poll = s?.lastPollSummary;
    const pollCounts = poll ? [
      poll.commentsChecked === undefined ? null : `${poll.commentsChecked} new comments checked`,
      poll.prsChecked === undefined ? null : `${poll.prsChecked} PRs checked`,
      poll.eligiblePrs === undefined ? null : `${poll.eligiblePrs} eligible`,
      poll.trackedPrs === undefined ? null : `${poll.trackedPrs} already tracked`,
      `${poll.queued} queued`,
    ].filter(Boolean).join(" · ") : null;
    const showingArchive = Boolean(archived && this.showArchive);
    const visibleItems = showingArchive ? [...archived].reverse() : items;
    const error = !terminal ? "Run /superagent in this tab's local Pi terminal to connect." : current ? this.disconnected ?? this.error ?? s?.error : undefined;
    const enabled = Boolean(s && !this.disconnected && !this.action && !this.pending);
    const label = (value, color = t.muted) => div().text_color(color).child(value);
    const button = (id, title, available, click, accessible = title) => Button.new(id).h(26).px(8).flex_none().flex().items_center().justify_center()
      .rounded(5).border_1().border_color(t.border).text_size(12).text_color(available ? t.foreground : t.dim)
      .accessibility_label(accessible).disabled(!available).tab_stop(available)
      .when(available, el => el.hover(h => h.bg(t.hover)).active(p => p.bg(t.selected)).focus(f => f.border_color(t.accent)).on_click(click))
      .child(title);
    const itemButton = (item, action, title, available = enabled) => button(`${item.id}-${action}`, title, available,
      (_e, cx) => this.update(cx, `items/${encodeURIComponent(item.id)}/${action}`, terminal), `${title} work item #${item.issue}`);
    const itemActions = item => {
      if (!s.itemControls) return [];
      if (item.phase) return [label(item.phase === "publishing" ? "Publishing…" : "Canceling…")];
      if (item.status === "queued") return [itemButton(item, "run", "Run now", enabled && !s.dryRun), itemButton(item, "cancel", "Cancel")];
      if (item.status === "running") return [itemButton(item, "cancel", "Cancel")];
      return [
        ...((item.status === "failed" || item.status === "canceled") && !item.prUrl
          ? [itemButton(item, "retry", "Retry", enabled && !s.dryRun)] : []),
        itemButton(item, "archive", "Archive"),
      ];
    };
    const source = item => {
      if (!/^[\w.-]+\/[\w.-]+$/.test(s?.repo ?? "") || !Number.isSafeInteger(item.issue) || item.issue <= 0) return label(`#${item.issue}`, t.foreground);
      const path = item.commentId < 0 ? "pull" : "issues";
      return Link.new(`source-${item.id}`).href(`https://github.com/${s.repo}/${path}/${item.issue}`)
        .accessibility_label(`Open GitHub item #${item.issue}`).text_color(t.accent).hover(el => el.underline())
        .focus(el => el.underline()).child(`#${item.issue}`);
    };
    const row = (item, actions) => v_flex().id(`item-${item.id}`).border_b(1).border_color(t.border).py(8).gap(3)
      .child(h_flex().items_center().gap(5)
        .child(h_flex().flex_1().min_w(0).gap(5).items_center().font_semibold()
          .child(source(item)).child(label(item.status, t.foreground)))
        .children(actions))
      .child(label(item.title || item.request))
      .child(div().text_size(11).text_color(t.muted).child(`@${item.author}`))
      .when(Boolean(item.outcome), el => el.child(label(item.outcome, t.foreground)))
      .when(Boolean(item.error), el => el
        .child(h_flex().child(button(`${item.id}-error`, this.expandedError === item.id ? "Hide error" : "Show error", true, (_e, cx) => {
          this.expandedError = this.expandedError === item.id ? undefined : item.id;
          cx.notify();
        }, `Toggle error details for work item #${item.issue}`)))
        .when(this.expandedError === item.id, el => el.child(label(item.error, t.ansi1))));
    return v_flex().size_full().min_h(0).px(12).py(10).gap(9).rounded(10).border_1().border_color(t.border).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).font_semibold().child("Superagent"))
        .child(button("close", "Close", true, () => run("layout.hide", { id: "panel" }))))
      .when(Boolean(s?.repo), el => el.child(label(s.repo)))
      .child(label(!terminal || (current && this.disconnected) ? "Disconnected" : !s ? "Connecting…" : `${s.active ? "Watching" : "Stopped"}${s.polling ? " · Poll in progress" : ""}${s.dryRun ? " · Dry run" : ""}`, t.foreground))
      .child(h_flex().items_center().gap(6)
        .child(button("start", "Start", enabled && !s?.active, (_e, cx) => this.update(cx, "start", terminal)))
        .child(button("poll", "Poll now", enabled && !s?.polling, (_e, cx) => this.update(cx, "poll", terminal)))
        .child(button("stop", "Stop", enabled && s?.active, (_e, cx) => this.update(cx, "stop", terminal))))
      .child(label(`Last poll: ${s?.lastPoll ? new Date(s.lastPoll).toLocaleString() : "Not yet in this session"}`))
      .when(Boolean(poll?.error), el => el.child(label(`Poll incomplete: ${poll.error}`, t.ansi1)))
      .when(Boolean(pollCounts && (!poll?.error || poll.commentsChecked !== undefined || poll.prsChecked !== undefined)), el => el.child(label(pollCounts)))
      .when(Boolean(error && error !== poll?.error), el => el.child(label(error, t.ansi1)))
      .child(div().border_t(1).border_color(t.border).pt(8).font_semibold().child(
        showingArchive ? `Archived work items (${archived.length})` : `Work items (${items.length})`))
      .when(Boolean(s && !s.itemControls), el => el.child(label("Reload Pi and run /superagent to enable work-item controls.")))
      .child(v_flex().id(showingArchive ? "archived-items" : "work-items").flex_1().min_h(0).overflow_y_scrollbar()
        .when(visibleItems.length === 0, el => el.child(label(showingArchive ? "No archived work items." : "No work items yet.")))
        .children(visibleItems.map(item => row(item, showingArchive ? [] : itemActions(item)))))
      .when(Boolean(archived), el => el.child(h_flex().flex_none().border_t(1).border_color(t.border).pt(8)
        .child(button("toggle-archive", `${this.showArchive ? "Hide" : "Show"} archive (${archived.length})`, true, (_e, cx) => {
          this.showArchive = !this.showArchive;
          cx.notify();
        }))));
  }
}
