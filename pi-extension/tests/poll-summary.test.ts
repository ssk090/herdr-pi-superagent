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
  vi.spyOn(agent, "drain").mockResolvedValue();
  vi.spyOn(agent.gh, "triggersSince").mockResolvedValue([]);
  const pr = { title: "PR", author: "peer", isDraft: false, labels: [], reviewRequests: ["me"] };
  vi.spyOn(agent.gh, "openPullRequests").mockResolvedValue([{ ...pr, number: 1 }, { ...pr, number: 2 }, { ...pr, number: 3, reviewRequests: [] }]);
  return agent;
}

test("poll counts scanned PRs, eligible requests, tracked items, and newly queued work", async () => {
  const agent = fixture();
  await agent.poll();
  expect(agent.lastPollSummary).toMatchObject({ commentsChecked: 0, prsChecked: 3, eligiblePrs: 2, trackedPrs: 0, queued: 2 });
  await agent.poll();
  expect(agent.lastPollSummary).toMatchObject({ prsChecked: 3, eligiblePrs: 2, trackedPrs: 2, queued: 0 });
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
