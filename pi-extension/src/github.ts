import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InlineComment } from "./review.ts";
import type { Exec, Trigger } from "./types.ts";

interface RawComment { id: number; body?: string; user?: { login?: string }; created_at: string; issue_url: string }
interface RawIssue { number: number; title: string; labels: Array<{ name: string } | string> }

export function issueNumberFromUrl(url: string): number {
  const m = /\/issues\/(\d+)$/.exec(url);
  if (!m) throw new Error(`bad issue_url ${url}`);
  return Number(m[1]);
}

export interface OpenPr {
  number: number;
  title: string;
  author: string;
  isDraft: boolean;
  labels: string[];
  reviewRequests: string[];
}

export interface PeerReview {
  user: { login: string; type: string } | null;
  state: string;
  commit_id: string;
  author_association: string;
}

export function latestPeerApproval(reviews: PeerReview[], head: string, login: string, author: string) {
  const decisions = new Map<string, PeerReview>();
  for (const review of reviews) {
    const reviewer = review.user?.login.toLowerCase();
    if (!reviewer || review.user?.type !== "User" || [login.toLowerCase(), author.toLowerCase()].includes(reviewer)) continue;
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) decisions.set(reviewer, review);
  }
  const latest = [...decisions.values()];
  return !latest.some(r => r.state === "CHANGES_REQUESTED") &&
    latest.some(r => r.state === "APPROVED" && r.commit_id === head && ["OWNER", "MEMBER", "COLLABORATOR"].includes(r.author_association));
}

export class GitHub {
  constructor(private exec: Exec, private repo: string) {}

  private async api<T>(path: string, args: string[] = []): Promise<T> {
    const r = await this.exec("gh", ["api", path, ...args], { timeout: 60_000 });
    if (r.code !== 0) throw new Error(`gh api ${path} failed: ${r.stderr.trim()}`);
    return JSON.parse(r.stdout || "null") as T;
  }

  /** Issue + PR comments created since `since` (ISO). */
  async triggersSince(since: string): Promise<Trigger[]> {
    const comments = await this.api<RawComment[]>(`repos/${this.repo}/issues/comments?since=${encodeURIComponent(since)}&sort=created&direction=asc&per_page=100`);
    const out: Trigger[] = [];
    const cache = new Map<number, RawIssue>();
    for (const c of comments) {
      if (c.created_at <= since) continue;
      const n = issueNumberFromUrl(c.issue_url);
      let issue = cache.get(n);
      if (!issue) { issue = await this.api<RawIssue>(`repos/${this.repo}/issues/${n}`); cache.set(n, issue); }
      out.push({
        issue: n, commentId: c.id, author: c.user?.login ?? "", body: c.body ?? "", title: issue.title,
        labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)), createdAt: c.created_at,
      });
    }
    return out;
  }

  async comment(issue: number, body: string): Promise<void> {
    const r = await this.exec("gh", ["issue", "comment", String(issue), "--repo", this.repo, "--body", body]);
    if (r.code !== 0) throw new Error(`gh issue comment failed: ${r.stderr.trim()}`);
  }

  async pullRequestHead(n: number): Promise<string | undefined> {
    if (!(await this.isPullRequest(n))) return;
    const pr = await this.api<{ head: { sha: string } }>(`repos/${this.repo}/pulls/${n}`);
    return pr.head.sha;
  }

  private async reviewablePr(n: number) {
    if (!(await this.isPullRequest(n))) return;
    const pr = await this.api<{ state: string; draft: boolean; head: { sha: string }; user: { login: string }; requested_reviewers: { login: string }[] }>(`repos/${this.repo}/pulls/${n}`);
    if (pr.state === "open" && !pr.draft) return pr;
  }

  async openReviewableHead(n: number, login: string) {
    const pr = await this.reviewablePr(n);
    if (pr && pr.user.login.toLowerCase() !== login.toLowerCase()) return pr.head.sha;
  }

  async requestedReview(n: number, login: string) {
    const pr = await this.reviewablePr(n);
    if (!pr?.requested_reviewers.some(u => u.login.toLowerCase() === login.toLowerCase())) return;
    return { head: pr.head.sha, author: pr.user.login };
  }

  async latestReviewRequest(n: number, login: string) {
    type Event = { id?: number; event?: string; created_at?: string; requested_reviewer?: { login: string } };
    const pages = await this.api<Event[][]>(`repos/${this.repo}/issues/${n}/timeline?per_page=100`, ["--paginate", "--slurp"]);
    const reviewer = login.toLowerCase();
    const latest = pages.flat().filter(e =>
      (e.event === "review_requested" || e.event === "review_request_removed") &&
      e.requested_reviewer?.login.toLowerCase() === reviewer).at(-1);
    if (latest?.event !== "review_requested" || !latest.id || !Number.isSafeInteger(latest.id) || !latest.created_at) return;
    return { id: latest.id, createdAt: latest.created_at };
  }

  async hasPeerApproval(n: number, head: string, login: string, author: string) {
    const pages = await this.api<PeerReview[][]>(`repos/${this.repo}/pulls/${n}/reviews?per_page=100`, ["--paginate", "--slurp"]);
    return latestPeerApproval(pages.flat(), head, login, author);
  }

  async review(n: number, head: string, body: string, approve: boolean, comments: InlineComment[]): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "pi-review-"));
    try {
      const path = join(dir, "review.json");
      await writeFile(path, JSON.stringify({ commit_id: head, event: approve ? "APPROVE" : "COMMENT", body, comments }), { mode: 0o600 });
      await this.api(`repos/${this.repo}/pulls/${n}/reviews`, ["--method", "POST", "--input", path]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async isPullRequest(n: number): Promise<boolean> {
    const r = await this.exec("gh", ["api", `repos/${this.repo}/issues/${n}`, "--jq", ".pull_request != null"]);
    if (r.code !== 0) throw new Error(`PR lookup failed: ${r.stderr.trim()}`);
    return r.stdout.trim() === "true";
  }

  /** Add a reaction to the issue/PR itself (no comment). */
  async react(n: number, content: "eyes" | "+1" | "-1" | "rocket"): Promise<void> {
    const r = await this.exec("gh", ["api", "-X", "POST", `repos/${this.repo}/issues/${n}/reactions`, "-f", `content=${content}`]);
    if (r.code !== 0) throw new Error(`gh api reactions failed: ${r.stderr.trim()}`);
  }

  /** The authenticated login, used to detect PRs already requested from us. */
  async currentLogin(): Promise<string> {
    const r = await this.exec("gh", ["api", "user", "--jq", ".login"]);
    return r.code === 0 ? r.stdout.trim() : "";
  }

  /** Open PRs whose base is `base`, with author, draft state, labels and requested reviewers. */
  async openPullRequests(base: string): Promise<OpenPr[]> {
    const r = await this.exec("gh", ["pr", "list", "--repo", this.repo, "--base", base, "--state", "open", "--limit", "100", "--json", "number,title,author,isDraft,labels,reviewRequests"]);
    if (r.code !== 0) throw new Error(`gh pr list failed: ${r.stderr.trim()}`);
    const raw = JSON.parse(r.stdout || "[]") as Array<Record<string, any>>;
    return raw.map((p) => ({
      number: p.number,
      title: p.title ?? "",
      author: p.author?.login ?? "",
      isDraft: Boolean(p.isDraft),
      labels: (p.labels ?? []).map((l: any) => l.name),
      reviewRequests: (p.reviewRequests ?? []).map((u: any) => u.login).filter(Boolean),
    }));
  }

  async createPr(opts: { branch: string; base: string; title: string; body: string; cwd: string }): Promise<string> {
    const r = await this.exec("gh", ["pr", "create", "--repo", this.repo, "--head", opts.branch, "--base", opts.base, "--title", opts.title, "--body", opts.body], { cwd: opts.cwd });
    if (r.code !== 0) throw new Error(`gh pr create failed: ${r.stderr.trim()}`);
    return r.stdout.trim().split("\n").pop() ?? "";
  }
}
