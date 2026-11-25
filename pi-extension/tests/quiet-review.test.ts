import { mkdtemp, rm } from "node:fs/promises";
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
});

test.each([
  { request: false, peer: false, critical: false, expected: "Skipped", event: undefined },
  { request: true, peer: true, critical: false, expected: "Approved", event: true },
  { request: true, peer: false, critical: false, expected: "No new", event: undefined },
  { request: true, peer: false, critical: true, expected: "Posted", event: false },
])("quiet review: $expected", async ({ request, peer, critical, expected, event }) => {
  const dir = await mkdtemp(join(tmpdir(), "sa-quiet-"));
  const exec = vi.fn<Exec>(async cmd => ({ code: 0, stderr: "", stdout: cmd === "env" ? JSON.stringify({
    summary: "Reviewed", verdict: critical ? "COMMENT" : "APPROVE", criticalSummary: critical ? "Critical issue" : "", findings: [],
  }) : "" }));
  const gh = new GitHub(exec, "acme/app");
  vi.spyOn(gh, "triggersSince").mockResolvedValue([]);
  vi.spyOn(gh, "currentLogin").mockResolvedValue("me");
  vi.spyOn(gh, "requestedReview").mockResolvedValue(request ? { head: "head", author: "author" } : undefined);
  vi.spyOn(gh, "hasPeerApproval").mockResolvedValue(peer);
  vi.spyOn(gh, "pullRequestHead").mockResolvedValue("head");
  const review = vi.spyOn(gh, "review").mockResolvedValue();
  const store = new WorkStore(join(dir, "state.json"));
  const item = store.open({ issue: 57, commentId: 123, body: "", title: "PR", author: "author", labels: [], createdAt: "" }, "Review", "review");
  const cfg = normalizeConfig({ repo: "acme/app", mention: "@me", allow: ["author"], approveReview: true, quietRequestedReviews: true });
  try {
    await new Superagent(cfg, store, exec, dir, {}, gh).poll();
    expect(item.outcome).toContain(expected);
    expect(exec.mock.calls.some(([cmd]) => cmd === "env")).toBe(request && !peer);
    if (event === undefined) expect(review).not.toHaveBeenCalled();
    else expect(review).toHaveBeenCalledExactlyOnceWith(57, "head", expect.any(String), event, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
