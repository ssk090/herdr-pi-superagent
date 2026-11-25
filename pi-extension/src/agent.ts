import { randomUUID } from "node:crypto";
import { decide, stripMention } from "./auth.ts";
import { GitHub, type OpenPr } from "./github.ts";
import { runWorkItem, cleanupWorktree, type RunResult } from "./executor.ts";
import { isReviewRequest } from "./prompt.ts";
import type { Exec, ItemAction, SuperagentConfig, Trigger, WorkItem } from "./types.ts";
import { WorkStore } from "./workitems.ts";

export interface AgentEvents { onChange?: () => void; log?: (msg: string) => void }

type PollSummary = { commentsChecked?: number; prsChecked?: number; eligiblePrs?: number; trackedPrs?: number; queued: number; error?: string };

/** One poll cycle: read new comments, open work items, run queued items. */
export class Superagent {
  private jobs = new Map<string, { controller: AbortController; publishing: boolean }>();
  get running() { return this.jobs.size; }
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private enabled = false;
  private cycle?: Promise<void>;
  lastError?: string;
  lastPoll?: string;
  lastPollSummary?: PollSummary;
  gh: GitHub;

  constructor(public cfg: SuperagentConfig, public store: WorkStore, private exec: Exec, private cwd: string, private ev: AgentEvents = {}, gh?: GitHub) {
    this.gh = gh ?? new GitHub(exec, cfg.repo);
  }

  get polling() { return this.cycle !== undefined; }

  itemPhase(id: string) {
    const job = this.jobs.get(id);
    return job?.controller.signal.aborted ? "canceling" : job?.publishing ? "publishing" : undefined;
  }

  poll(): Promise<void> {
    if (this.cycle) return this.cycle;
    const summary: PollSummary = { queued: 0 };
    return this.cycle = this.runCycle(summary).catch(error => {
      this.recordPoll({ ...summary, error: String((error as Error).message ?? error) });
      throw error;
    }).finally(() => { this.cycle = undefined; this.ev.onChange?.(); });
  }

  private recordPoll(summary: PollSummary) {
    this.lastPoll = new Date().toISOString();
    this.lastPollSummary = summary;
    this.lastError = summary.error;
  }

  private async runCycle(summary: PollSummary): Promise<void> {
    const triggers = await this.gh.triggersSince(this.store.state.cursor);
    summary.commentsChecked = triggers.length;
    for (const t of triggers) {
      if (t.createdAt > this.store.state.cursor) this.store.state.cursor = t.createdAt;
      if (this.store.has(t.commentId)) continue;
      const d = decide(t, this.cfg);
      if (!d.act) { this.ev.log?.(`skip #${t.issue} ${t.commentId}: ${d.reason}`); continue; }
      const request = stripMention(t.body, this.cfg.mention) || t.title;
      // A `/review-a` request, or a `review` label, runs read-only and posts findings.
      const kind = isReviewRequest(request) || t.labels.some((l) => l.toLowerCase().includes("review")) ? "review" : "work";
      const item = this.store.open(t, request, kind);
      summary.queued++;
      this.ev.log?.(`opened ${item.id} (${d.reason})`);
      if (!this.cfg.dryRun && !this.cfg.quietRequestedReviews) {
        // Acknowledge with a 👀 reaction on the PR/issue, not a comment.
        try { await this.gh.react(t.issue, "eyes"); }
        catch (e) { this.ev.log?.(`react ${t.issue} failed: ${(e as Error).message ?? e}`); }
      }
    }
    let eligibleAutoReviews = new Set<number>();
    if (!this.cfg.dryRun) {
      try {
        eligibleAutoReviews = await this.dispatchAutoReviews(summary);
        this.store.state.items = this.store.state.items.filter((item) =>
          item.commentId >= 0 || item.status !== "queued" || eligibleAutoReviews.has(item.issue));
      } catch (e) {
        summary.error = `PR scan failed: ${(e as Error).message ?? e}`;
        this.ev.log?.(summary.error);
      }
    }
    await this.store.save();
    this.recordPoll(summary);
    this.ev.onChange?.();
    if (!this.cfg.dryRun) await this.drain(eligibleAutoReviews);
  }

  async drain(eligibleAutoReviews = new Set<number>()): Promise<void> {
    if (this.cfg.dryRun) return;
    const queued = this.store.byStatus("queued").filter(item => !item.archived && (item.commentId >= 0 || eligibleAutoReviews.has(item.issue)));
    await Promise.all(queued.slice(0, Math.max(0, this.cfg.maxConcurrent - this.running)).map(item => this.runItem(item)));
  }

  async controlItem(action: ItemAction, id: string) {
    const item = this.store.state.items.find(i => i.id === id);
    if (!item || item.archived) throw new Error("Work item is missing or archived");
    const job = this.jobs.get(id);
    if (action === "archive") {
      if (job || item.status === "queued" || item.status === "running") throw new Error("Cancel or finish this item before archiving it");
      this.store.update(id, { archived: true });
    } else if (action === "cancel") {
      if (item.status !== "queued" && item.status !== "running") throw new Error("This work item is not active");
      if (job?.publishing) throw new Error("Publishing already started. This item cannot be canceled now.");
      if (job) { job.controller.abort(); this.ev.onChange?.(); return; }
      else this.store.update(id, { status: "canceled", outcome: "Canceled" });
    } else {
      if (this.cfg.dryRun) throw new Error("Cannot run work items in dry-run mode");
      if (item.commentId < 0) {
        if (!this.cfg.autoReview?.enabled) throw new Error("Automatic review is disabled");
        const login = await this.gh.currentLogin();
        const pr = login && (await this.gh.openPullRequests(this.cfg.baseBranch)).find(p => p.number === item.issue);
        if (!pr || !this.autoReviewAllows(pr, login)) throw new Error("This PR no longer qualifies for automatic review");
      }
      const valid = action === "run" ? item.status === "queued" : item.status === "failed" || item.status === "canceled";
      if (!valid || item.archived || item.prUrl || this.jobs.has(id)) throw new Error("This work item cannot be started in its current state");
      if (this.running >= this.cfg.maxConcurrent) throw new Error("All worker slots are busy. Try again after an item finishes.");
      if (action === "retry") this.store.update(id, { retry: randomUUID().slice(0, 8) });
      void this.runItem(item).catch(e => { this.lastError = (e as Error).message; this.ev.onChange?.(); });
      return;
    }
    await this.store.save();
    this.ev.onChange?.();
  }

  private async runItem(item: WorkItem) {
    const job = { controller: new AbortController(), publishing: false };
    const { signal } = job.controller;
    this.jobs.set(item.id, job);
    this.store.update(item.id, { status: "running", outcome: undefined, error: undefined });
    const beforePublish = () => { signal.throwIfAborted(); job.publishing = true; };
    const exec: Exec = async (cmd, args, opts) => {
      signal.throwIfAborted();
      const result = await this.exec(cmd, args, { ...opts, signal });
      signal.throwIfAborted();
      return result;
    };
    const execute = () => runWorkItem(item, this.cfg, { exec, gh: this.gh, cwd: this.cwd, beforePublish });
    this.ev.onChange?.();
    try {
      await this.store.save();
      signal.throwIfAborted();
      if (item.kind === "review" && this.cfg.quietRequestedReviews) {
        await this.runQuietReview(item, execute, beforePublish, signal);
        return;
      }
      const r = await execute();
      signal.throwIfAborted();
      this.store.update(item.id, { prUrl: r.prUrl, branch: r.branch, worktree: r.worktree });
      if (item.kind === "review" && r.status === "done") {
        const outcome = await this.postReview(item, r, beforePublish);
        this.store.update(item.id, { outcome });
      } else {
        const msg = r.status === "done"
          ? `✅ PR: ${r.prUrl}`
          : r.status === "needs-human"
            ? `❓ I need your input:\n\n${r.summary}`
            : `⚠️ Work item \`${item.id}\` failed:\n\n\`\`\`\n${r.summary}\n\`\`\``;
        beforePublish();
        await this.gh.comment(item.issue, msg);
      }
      if (r.status !== "failed") await cleanupWorktree(this.exec, this.cwd, r.worktree);
      this.store.update(item.id, { status: r.status, error: r.status === "failed" ? r.summary : undefined });
    } catch (e) {
      this.store.update(item.id, signal.aborted ? { status: "canceled", outcome: "Canceled before publication" }
        : { status: "failed", error: String((e as Error).message ?? e) });
    } finally {
      try { await this.store.save(); }
      finally { this.jobs.delete(item.id); this.ev.onChange?.(); }
    }
  }

  private autoReviewAllows(pr: OpenPr, login: string) {
    const ar = this.cfg.autoReview;
    if (!ar?.enabled) return false;
    const own = pr.author.toLowerCase() === login.toLowerCase();
    if ((pr.isDraft && ar.skipDraft) || (own && !ar.reviewOwnPrs)) return false;
    if (ar.authors.length && !ar.authors.includes(pr.author)) return false;
    if (!ar.labels.every(label => pr.labels.includes(label))) return false;
    return !(this.cfg.quietRequestedReviews || (!own && ar.requestOnly)) ||
      pr.reviewRequests.some(user => user.toLowerCase() === login.toLowerCase());
  }

  /** Queue a review for each open PR that matches autoReview and was not queued before. */
  private async dispatchAutoReviews(summary: PollSummary): Promise<Set<number>> {
    const eligible = new Set<number>();
    const ar = this.cfg.autoReview;
    if (!ar?.enabled) return eligible;
    const login = await this.gh.currentLogin();
    if (!login) throw new Error("Could not identify the GitHub account for auto-review.");
    const prs = await this.gh.openPullRequests(this.cfg.baseBranch);
    summary.prsChecked = prs.length;
    summary.eligiblePrs = 0;
    summary.trackedPrs = 0;
    for (const pr of prs) {
      if (!this.autoReviewAllows(pr, login)) continue;
      summary.eligiblePrs++;
      if (this.cfg.quietRequestedReviews && this.store.byStatus("queued", "running").some(item => item.issue === pr.number && item.kind === "review" && item.commentId >= 0)) {
        summary.trackedPrs++;
        continue;
      }
      eligible.add(pr.number);
      // Negative commentId keeps auto items distinct from real comments and makes them one-per-PR.
      if (this.store.has(-pr.number)) { summary.trackedPrs++; continue; }
      const t: Trigger = { issue: pr.number, commentId: -pr.number, author: pr.author, body: pr.title, title: pr.title, labels: pr.labels, createdAt: new Date().toISOString() };
      this.store.open(t, `Review pull request #${pr.number}. Run /review-a.`, "review");
      summary.queued++;
      this.ev.log?.(`auto-review queued #${pr.number} (${pr.title})`);
      if (!this.cfg.quietRequestedReviews) {
        try { await this.gh.react(pr.number, "eyes"); }
        catch { /* a missing reaction is not worth failing the poll */ }
      }
    }
    return eligible;
  }

  private async runQuietReview(item: WorkItem, execute: () => Promise<RunResult>, beforePublish: () => void, signal: AbortSignal) {
    const finish = (outcome: string) => { signal.throwIfAborted(); this.store.update(item.id, { status: "done", outcome }); };
    const login = await this.gh.currentLogin();
    if (!login) throw new Error("Could not identify the GitHub reviewer.");
    const request = await this.gh.requestedReview(item.issue, login);
    if (!request) return finish("Skipped: not an open PR with a direct review request for this account");
    const stillRequested = async () => (await this.gh.requestedReview(item.issue, login))?.head === request.head;
    if (await this.gh.hasPeerApproval(item.issue, request.head, login, request.author)) {
      if (!this.cfg.approveReview) return finish("Skipped: peer approved; automatic approval is disabled");
      if (!(await stillRequested())) return finish("Skipped: the review request or PR head changed");
      beforePublish();
      await this.gh.review(item.issue, request.head, "Approved based on a peer approval of this commit.", true, []);
      return finish("Approved: peer review already covered this commit");
    }

    signal.throwIfAborted();
    const r = await execute();
    this.store.update(item.id, { branch: r.branch, worktree: r.worktree });
    if (r.status === "failed") return this.store.update(item.id, { status: "failed", error: r.summary });
    try {
      if (r.head !== request.head || !(await stillRequested())) return finish("Skipped: the review request or PR head changed");
      if (!r.review?.valid) throw new Error("Review worker returned invalid JSON; nothing was posted");
      if (!r.review.criticalSummary && !r.review.criticalComments.length) return finish("No new critical findings posted");
      beforePublish();
      await this.gh.review(item.issue, request.head, r.review.criticalSummary || "New critical findings are noted inline.", false, r.review.criticalComments);
      finish("Posted new critical findings");
    } finally {
      if (!signal.aborted) await cleanupWorktree(this.exec, this.cwd, r.worktree);
    }
  }

  /** Post a formal PR review. Approve only when allowed; otherwise comment, or fall back for non-PRs. */
  private async postReview(item: WorkItem, result: RunResult, beforePublish: () => void): Promise<string> {
    const text = result.summary || "The review worker returned no findings or summary.";
    const { head, review } = result;
    if (!head || !review) {
      beforePublish();
      await this.gh.comment(item.issue, text);
      return "Posted a comment";
    }
    if (await this.gh.pullRequestHead(item.issue) !== head) {
      throw new Error("PR head changed during review; no review was submitted.");
    }
    beforePublish();
    if (review.approve && this.cfg.approveReview) {
      try {
        await this.gh.review(item.issue, head, `✅ **Approved**\n\n${text}`, true, review.comments);
        return "Approved after review";
      } catch (e) {
        if (!(e instanceof Error) || !/can\s*not approve your own pull request/i.test(e.message)) throw e;
      }
    }
    await this.gh.review(item.issue, head, `💬 **Review findings**\n\n${text}`, false, review.comments);
    return "Posted a review without approval";
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    const generation = ++this.generation;
    const tick = async () => {
      try { await this.poll(); } catch { /* exposed in lastError */ }
      if (this.generation === generation) this.timer = setTimeout(tick, this.cfg.pollIntervalSec * 1000);
    };
    void tick();
  }
  stop() {
    this.enabled = false;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  get active() { return this.enabled; }
}
