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
      this.filters = {};
      this.showViews = false;
      this.approval = undefined;
      this.cleanup = undefined;
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
    const runningReviews = items.filter(item => item.kind === "review" && item.progress);
    const queuedReviews = items.filter(item => item.kind === "review" && item.status === "queued").length;
    const elapsed = startedAt => {
      const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    };
    const poll = s?.lastPollSummary;
    const pollCounts = poll ? [
      poll.commentsChecked === undefined ? null : `${poll.commentsChecked} new comments checked`,
      poll.prsChecked === undefined ? null : `${poll.prsChecked} PRs checked`,
      poll.eligiblePrs === undefined ? null : `${poll.eligiblePrs} eligible`,
      poll.trackedPrs === undefined ? null : `${poll.trackedPrs} already tracked`,
      `${poll.queued} queued`,
    ].filter(Boolean).join(" · ") : null;
    const filters = this.filters ?? {};
    const checked = poll?.pullRequests ?? [];
    const choices = [
      ["archive", "Archive", archived?.length],
      ["checked", "Checked PRs", checked.length],
      ["eligible", "Eligible", checked.filter(pr => pr.decision !== "ineligible").length],
      ["tracked", "Already tracked", checked.filter(pr => pr.decision === "tracked").length],
      ["queued", "Queued by poll", checked.filter(pr => pr.decision === "queued").length],
    ];
    const showingArchive = Boolean(archived && filters.archive);
    const showingPoll = filters.checked || filters.eligible || filters.tracked || filters.queued;
    const pollRows = showingPoll ? checked.filter(pr => filters.checked || (filters.eligible && pr.decision !== "ineligible") || filters[pr.decision]) : [];
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
        ...(s.manualApproval && item.kind === "review" && item.status === "done" && !item.outcome?.startsWith("Approved")
          ? [button(`${item.id}-approve`, "Approve", enabled && !s.dryRun, (_e, cx) => {
              this.approval = { terminal, id: item.id, issue: item.issue };
              cx.notify();
            }, `Approve PR #${item.issue}`)] : []),
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
    const idleWorktrees = s?.worktrees?.filter(id => !items.some(item => item.id === id && item.status === "running")) ?? [];
    const askCleanup = (cx, id) => { this.cleanup = { terminal, id }; cx.notify(); };
    const confirmation = this.cleanup?.terminal === terminal ? this.cleanup : undefined;
    const approval = this.approval?.terminal === terminal ? this.approval : undefined;
    const row = (item, actions) => v_flex().id(`item-${item.id}`).border_b(1).border_color(t.border).py(8).gap(3)
      .child(h_flex().items_center().gap(5)
        .child(h_flex().flex_1().min_w(0).gap(5).items_center().font_semibold()
          .child(source(item)).child(label(item.progress ? "running" : item.status === "running" && s.liveProgress ? "inactive" : item.status, t.foreground)))
        .children(actions))
      .child(label(item.title || item.request))
      .child(div().text_size(11).text_color(t.muted).child(`@${item.author}`))
      .when(Boolean(item.progress && item.kind !== "review"), el => el.child(label(`${item.progress.stage} · ${elapsed(item.progress.startedAt)}`)))
      .when(Boolean(s.liveProgress && item.status === "running" && !item.progress), el => el.child(label("No active worker for this item in this Pi session.")))
      .when(Boolean(item.outcome), el => el.child(label(item.outcome, t.foreground)))
      .when(Boolean(item.cleanupError && idleWorktrees.includes(item.id)), el => el.child(label(`Worktree cleanup failed: ${item.cleanupError}`, t.ansi1)))
      .when(idleWorktrees.includes(item.id), el => el.child(h_flex().child(button(`${item.id}-worktree`, "Remove worktree", enabled,
        (_e, cx) => askCleanup(cx, item.id), `Remove worktrees for item #${item.issue}`))))
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
        .when(Boolean(s?.liveProgress && !showingArchive), el => el.child(v_flex().gap(4).pb(8).border_b(1).border_color(t.border)
          .child(div().font_semibold().child(`Running reviews (${runningReviews.length})`))
          .when(runningReviews.length === 0, section => section.child(label(queuedReviews ? `${queuedReviews} queued · No review running` : "No reviews running")))
          .children(runningReviews.map(item => v_flex().id(`live-review-${item.id}`).gap(2).py(4)
            .child(h_flex().gap(6).items_center().child(label(`#${item.issue}`, t.foreground)).child(div().flex_1().min_w(0).truncate().child(item.title || item.request)))
            .child(label(`${item.progress.stage} · ${elapsed(item.progress.startedAt)} elapsed`))))))
        .when(Boolean(showingPoll), el => el.child(v_flex().gap(5).py(8).border_b(1).border_color(t.border)
          .child(div().font_semibold().child(`Last poll PRs (${pollRows.length})`))
          .when(pollRows.length === 0, list => list.child(label(poll?.pullRequests ? "No PRs match the selected filters." : "No PR scan details yet. Run a new poll.")))
          .children(pollRows.map(pr => v_flex().id(`checked-pr-${pr.number}`).py(5).gap(2)
            .child(h_flex().gap(5).items_center().child(source({ id: `checked-${pr.number}`, issue: pr.number, commentId: -1 }))
              .child(div().flex_1().min_w(0).child(pr.title)))
            .child(label(`${pr.author ? `@${pr.author} · ` : ""}${pr.reason ?? ({ eligible: "Eligible", tracked: "Already tracked", queued: "Queued by this poll", ineligible: "Not eligible" })[pr.decision]}`))))))
        .when(visibleItems.length === 0, el => el.child(label(showingArchive ? "No archived work items." : "No work items yet.")))
        .children(visibleItems.map(item => row(item, showingArchive ? [] : itemActions(item)))))
      .when(Boolean(approval), el => el.child(v_flex().gap(5)
        .child(label(`Approve the current revision of PR #${approval.issue} on GitHub?`, t.foreground))
        .child(h_flex().gap(6)
          .child(button("confirm-approval", "Approve PR", enabled, (_e, cx) => {
            this.approval = undefined;
            this.update(cx, `items/${encodeURIComponent(approval.id)}/approve`, terminal);
          }))
          .child(button("cancel-approval", "Cancel", true, (_e, cx) => { this.approval = undefined; cx.notify(); })))))
      .when(Boolean(confirmation), el => el.child(v_flex().gap(5)
        .child(label(`Remove ${confirmation.id ? `worktrees for #${confirmation.id.split("-")[0]}` : "all idle Superagent worktrees"}? Uncommitted changes will be lost.`, t.foreground))
        .child(h_flex().gap(6)
          .child(button("confirm-cleanup", "Remove", enabled, (_e, cx) => {
            this.cleanup = undefined;
            this.update(cx, `worktrees/${confirmation.id ? `${encodeURIComponent(confirmation.id)}/` : ""}remove`, terminal);
          }))
          .child(button("cancel-cleanup", "Cancel", true, (_e, cx) => { this.cleanup = undefined; cx.notify(); })))))
      .when(Boolean(s), el => el.child(v_flex().gap(6).flex_none().border_t(1).border_color(t.border).pt(8)
        .when(Boolean(this.showViews), menu => menu.child(h_flex().gap(5).flex_wrap()
          .children(choices.filter(([, , count]) => count !== undefined).map(([key, name, count]) =>
            button(`filter-${key}`, `${filters[key] ? "✓ " : ""}${name} (${count})`, true, (_e, cx) => {
              this.filters = { ...filters, [key]: !filters[key] };
              cx.notify();
            }).selected(Boolean(filters[key]))))))
        .child(h_flex().gap(6).flex_wrap()
          .child(button("toggle-views", this.showViews ? "Hide filters" : "View filters", true, (_e, cx) => {
            this.showViews = !this.showViews;
            cx.notify();
          }))
          .when(idleWorktrees.length > 0, row => row.child(button("cleanup-worktrees", "Clean up worktrees", enabled, (_e, cx) => askCleanup(cx)))))));
  }
}
