import { expect, test, vi } from "vitest";
import { Superagent } from "../src/agent.ts";
import { normalizeConfig } from "../src/config.ts";
import { WorkStore } from "../src/workitems.ts";

function fixture() {
  const store = new WorkStore("unused");
  vi.spyOn(store, "save").mockResolvedValue();
  const cfg = normalizeConfig({ repo: "a/b", mention: "@me", allow: ["peer"], quietRequestedReviews: true, autoReview: { enabled: true, requestOnly: true } });
  const agent = new Superagent(cfg, store, async () => { throw new Error("Unexpected shell command"); }, ".");
  vi.spyOn(agent.gh, "currentLogin").mockResolvedValue("me");
  vi.spyOn(agent.gh, "latestReviewRequest").mockResolvedValue(undefined);
  vi.spyOn(agent, "drain").mockResolvedValue();
  vi.spyOn(agent.gh, "triggersSince").mockResolvedValue([]);
  const pr = { title: "PR", author: "peer", isDraft: false, labels: [], reviewRequests: ["me"] };
  vi.spyOn(agent.gh, "openPullRequests").mockResolvedValue([{ ...pr, number: 1 }, { ...pr, number: 2 }, { ...pr, number: 3, reviewRequests: [] }]);
  return agent;
}

test("poll counts scanned PRs, eligible requests, tracked items, and newly queued work", async () => {
  const agent = fixture();
  await agent.poll();
  expect(agent.lastPollSummary).toMatchObject({ commentsChecked: 0, prsChecked: 3, eligiblePrs: 2, trackedPrs: 0, queued: 2,
    pullRequests: [
      { number: 1, title: "PR", author: "peer", decision: "queued" },
      { number: 2, decision: "queued" },
      { number: 3, decision: "ineligible", reason: "Review not requested from this account" },
    ],
  });
  await agent.poll();
  expect(agent.lastPollSummary).toMatchObject({ prsChecked: 3, eligiblePrs: 2, trackedPrs: 2, queued: 0,
    pullRequests: [{ number: 1, decision: "tracked" }, { number: 2, decision: "tracked" }, { number: 3, decision: "ineligible" }],
  });
});

test("a fresh direct request queues a new attempt even when the prior review is archived", async () => {
  const agent = fixture();
  await agent.poll();
  const original = agent.store.state.items.find(item => item.issue === 1)!;
  agent.store.update(original.id, { status: "done", archived: true });
  const request = { id: 50001, createdAt: "2099-01-01T00:00:00Z" };
  vi.mocked(agent.gh.latestReviewRequest).mockImplementation(async n => n === 1 ? request : undefined);
  await agent.poll();
  const attempts = agent.store.state.items.filter(item => item.issue === 1);
  expect(attempts).toMatchObject([{ archived: true, status: "done" }, { status: "queued", commentId: -50001 }]);
  expect(attempts[0].id).not.toBe(attempts[1].id);
  agent.store.update(attempts[1].id, { status: "done" });
  await agent.poll();
  expect(agent.store.state.items.filter(item => item.issue === 1)).toHaveLength(2);
});

test("an older review request does not reopen a legacy attempt", async () => {
  const agent = fixture();
  await agent.poll();
  const original = agent.store.state.items.find(item => item.issue === 1)!;
  agent.store.update(original.id, { status: "done" });
  vi.mocked(agent.gh.latestReviewRequest).mockResolvedValue({ id: 50001, createdAt: "2000-01-01T00:00:00Z" });
  await agent.poll();
  expect(agent.store.state.items.filter(item => item.issue === 1)).toEqual([original]);
});

test("a failed PR scan is not reported as a successful empty scan", async () => {
  const agent = fixture();
  await agent.poll();
  vi.mocked(agent.gh.openPullRequests).mockRejectedValueOnce(new Error("GitHub unavailable"));
  await agent.poll();
  expect(agent.lastPollSummary).toMatchObject({ commentsChecked: 0, queued: 0, error: expect.stringContaining("GitHub unavailable") });
  expect(agent.lastPollSummary?.prsChecked).toBeUndefined();
  await agent.poll();
  expect(agent.lastPollSummary?.error).toBeUndefined();
});

test("a failed comment scan replaces the previous result rather than showing stale counts", async () => {
  const agent = fixture();
  await agent.poll();
  vi.mocked(agent.gh.triggersSince).mockRejectedValueOnce(new Error("Comments inaccessible"));
  await expect(agent.poll()).rejects.toThrow("Comments inaccessible");
  expect(agent.lastPollSummary).toEqual({ queued: 0, error: "Comments inaccessible" });
});
