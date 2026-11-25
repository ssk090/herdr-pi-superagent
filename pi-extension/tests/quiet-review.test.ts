import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Superagent } from "../src/agent.ts";
import { normalizeConfig } from "../src/config.ts";
import { GitHub, latestPeerApproval, type PeerReview } from "../src/github.ts";
import { parseReview } from "../src/review.ts";
import type { Exec } from "../src/types.ts";
import { WorkStore } from "../src/workitems.ts";

const approved: PeerReview = { user: { login: "alice", type: "User" }, state: "APPROVED", commit_id: "head", author_association: "MEMBER" };

test("only current-head human peer approval qualifies, with no outstanding changes requested", () => {
  const peer = (reviews: PeerReview[]) => latestPeerApproval(reviews, "head", "me", "author");
  expect(peer([approved])).toBe(true);
  expect(peer([{ ...approved, commit_id: "old" }])).toBe(false);
  expect(peer([{ ...approved, user: { login: "automation", type: "Bot" } }])).toBe(false);
  expect(peer([approved, { ...approved, user: { login: "bob", type: "User" }, state: "CHANGES_REQUESTED", commit_id: "old" }])).toBe(false);
  expect(peer([approved, { ...approved, state: "CHANGES_REQUESTED" }])).toBe(false);
});

test("quiet review accepts only new critical findings, including unanchorable ones", () => {
  const finding = { path: "a.ts", line: 1, title: "Finding", detail: "Impact", suggestion: "Fix it" };
  const result = parseReview(JSON.stringify({ summary: "Reviewed", verdict: "COMMENT", criticalSummary: "Unanchored blocker", findings: [
    { ...finding, severity: "P3", blocking: false }, { ...finding, severity: "P2", blocking: true },
  ] }));
  expect(result.criticalComments.map(c => c.body)).toEqual([expect.stringContaining("P2")]);
  expect(result.criticalSummary).toBe("Unanchored blocker");
  expect(parseReview("VERDICT: APPROVE").criticalComments).toEqual([]);
  expect(parseReview(JSON.stringify({ summary: "Reviewed", verdict: "APPROVE", findings: [], contextGap: "Backend PR not accessible" })))
    .toMatchObject({ valid: true, approve: false, contextGap: "Backend PR not accessible" });
});

test.each([
  { request: false, peer: false, critical: false, expected: "Skipped", event: undefined },
  { request: true, peer: true, critical: false, expected: "Approved", event: true },
  { request: true, peer: false, critical: false, expected: "Approved after review", event: true },
  { request: true, peer: false, critical: false, expected: "No new", event: undefined, approvalDisabled: true },
  { request: true, peer: false, critical: false, expected: "Review context incomplete", event: undefined, contextGap: "Backend PR inaccessible" },
  { request: true, peer: false, critical: true, expected: "Posted", event: false },
  { request: true, peer: false, critical: true, expected: "Posted", event: false, cleanupFails: true },
  { request: true, peer: false, critical: true, event: false, postingFails: true },
])("quiet review: $expected", async ({ request, peer, critical, expected, event, cleanupFails, postingFails, approvalDisabled, contextGap }) => {
  const dir = await mkdtemp(join(tmpdir(), "sa-quiet-"));
  const exec = vi.fn<Exec>(async (cmd, args) => {
    if (cleanupFails && cmd === "git" && args[1] === "remove") return { code: 1, stderr: "Locked", stdout: "" };
    return { code: 0, stderr: "", stdout: cmd === "env" ? JSON.stringify({
    summary: "Reviewed", verdict: critical ? "COMMENT" : "APPROVE", criticalSummary: critical ? "Critical issue" : "", contextGap, findings: [],
    }) : "" };
  });
  const gh = new GitHub(exec, "acme/app");
  vi.spyOn(gh, "triggersSince").mockResolvedValue([]);
  vi.spyOn(gh, "currentLogin").mockResolvedValue("me");
  vi.spyOn(gh, "requestedReview").mockResolvedValue(request ? { head: "head", author: "author" } : undefined);
  vi.spyOn(gh, "hasPeerApproval").mockResolvedValue(peer);
  vi.spyOn(gh, "pullRequestHead").mockResolvedValue("head");
  const review = vi.spyOn(gh, "review").mockResolvedValue();
  if (postingFails) review.mockRejectedValueOnce(new Error("GitHub unavailable"));
  const store = new WorkStore(join(dir, "state.json"));
  const item = store.open({ issue: 57, commentId: 123, body: "", title: "PR", author: "author", labels: [], createdAt: "" }, "Review", "review");
  const cfg = normalizeConfig({ repo: "acme/app", mention: "@me", allow: ["author"], approveReview: !approvalDisabled, quietRequestedReviews: true, reviewSkill: "SKILL.md" });
  try {
    await writeFile(join(dir, "SKILL.md"), "Fixture: verify the API contract.");
    await new Superagent(cfg, store, exec, dir, {}, gh).poll();
    if (expected) expect(item.outcome).toContain(expected);
    const cleanup = exec.mock.calls.findIndex(([cmd, args]) => cmd === "git" && args[1] === "remove");
    if (request && !peer && !postingFails) {
      expect(cleanup).toBeGreaterThanOrEqual(0);
      if (critical) expect(exec.mock.invocationCallOrder[cleanup]).toBeGreaterThan(review.mock.invocationCallOrder[0]);
      expect(item.status).toBe("done");
      expect(item.cleanupError).toBe(cleanupFails ? "Locked" : undefined);
      if (!cleanupFails) expect(item.worktree).toBeUndefined();
    } else expect(cleanup).toBe(-1);
    if (postingFails) expect(item).toMatchObject({ status: "failed", worktree: expect.any(String) });
    const prompt = exec.mock.calls.find(([cmd]) => cmd === "env")?.[1].at(-1);
    expect(Boolean(prompt)).toBe(request && !peer);
    if (prompt) {
      expect(prompt).toContain("Fixture: verify the API contract.");
      expect(prompt).toContain("Inspect related backend PRs, diffs and merge state");
    }
    if (event === undefined) expect(review).not.toHaveBeenCalled();
    else expect(review).toHaveBeenCalledExactlyOnceWith(57, "head", event && !peer ? expect.stringContaining("Reviewed") : expect.any(String), event, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
