import { join } from "node:path";
import type { Exec, SuperagentConfig, WorkItem } from "./types.ts";
import type { GitHub } from "./github.ts";
import { workerPrompt, tail } from "./prompt.ts";
import { parseReview } from "./review.ts";

export interface RunResult { status: "done" | "needs-human" | "failed"; prUrl?: string; summary: string; branch: string; worktree: string; review?: ReturnType<typeof parseReview>; head?: string }

export async function runWorkItem(item: WorkItem, cfg: SuperagentConfig, deps: { exec: Exec; gh: GitHub; cwd: string; beforePublish?: () => void }): Promise<RunResult> {
  const { exec, gh, cwd } = deps;
  const attempt = item.retry ? `${item.id}-${item.retry}` : item.id;
  const branch = `superagent/${attempt}`;
  const worktree = join(cwd, ".pi", "superagent", "worktrees", attempt);
  const must = async (cmd: string, args: string[], wd = cwd, timeout = 120_000) => {
    const r = await exec(cmd, args, { cwd: wd, timeout });
    if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout;
  };

  const head = item.kind === "review" ? await gh.pullRequestHead(item.issue) : undefined;
  await must("git", ["fetch", "origin", cfg.baseBranch]);
  await must("git", ["worktree", "add", "-B", branch, worktree, `origin/${cfg.baseBranch}`]);

  // Fresh, isolated pi session in the worktree. SUPERAGENT_WORKER=1 turns on the tool_call guard.
  const run = await exec("env", ["SUPERAGENT_WORKER=1", cfg.piCommand, ...cfg.piArgs, "-p", workerPrompt(item, cfg)], { cwd: worktree, timeout: 60 * 60_000 });
  const raw = run.stdout.trim() || run.stderr.trim();
  const summary = tail(raw, 3000);
  if (run.code !== 0) return { status: "failed", summary, branch, worktree };

  // A review is read-only: post the findings and never open a PR. Any stray commit dies with the worktree.
  if (item.kind === "review") {
    const review = parseReview(run.stdout);
    return { status: "done", summary: tail(review.body, 3000), branch, worktree, review, head };
  }

  const ahead = Number((await must("git", ["rev-list", "--count", `origin/${cfg.baseBranch}..HEAD`], worktree)).trim());
  if (!ahead) return { status: "needs-human", summary, branch, worktree };

  deps.beforePublish?.();
  await must("git", ["push", "-u", "origin", branch], worktree);
  const prUrl = await gh.createPr({
    branch, base: cfg.baseBranch, cwd: worktree,
    title: `[superagent] ${item.title}`.slice(0, 120),
    body: `Requested by @${item.author} in #${item.issue}.\n\n${summary}\n\n---\n_Opened by [pi-superagent](https://github.com/aicodewith-team/pi-superagent)._`,
  });
  return { status: "done", prUrl, summary, branch, worktree };
}

export async function cleanupWorktree(exec: Exec, cwd: string, worktree: string) {
  await exec("git", ["worktree", "remove", "--force", worktree], { cwd });
}
