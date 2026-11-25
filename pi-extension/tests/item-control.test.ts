import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Superagent } from "../src/agent.ts";
import { normalizeConfig } from "../src/config.ts";
import { GitHub } from "../src/github.ts";
import type { Exec, WorkStatus } from "../src/types.ts";
import { WorkStore } from "../src/workitems.ts";

async function fixture(exec: Exec, run: (a: Superagent, item: ReturnType<WorkStore["open"]>, gh: GitHub) => Promise<void>, status: WorkStatus = "queued", dryRun = false) {
  const dir = await mkdtemp(join(tmpdir(), "sa-item-"));
  const cfg = normalizeConfig({ repo: "acme/app", mention: "@me", allow: ["author"], quietRequestedReviews: true, dryRun });
  const store = new WorkStore(join(dir, "state.json"));
  const item = store.open({ issue: 57, commentId: 123, body: "", title: "PR", author: "author", labels: [], createdAt: "" }, "Review", "review");
  store.update(item.id, { status });
  const gh = new GitHub(exec, cfg.repo);
  vi.spyOn(gh, "currentLogin").mockResolvedValue("me");
  vi.spyOn(gh, "requestedReview").mockResolvedValue({ head: "head", author: "author" });
  vi.spyOn(gh, "hasPeerApproval").mockResolvedValue(false);
  vi.spyOn(gh, "pullRequestHead").mockResolvedValue("head");
  vi.spyOn(gh, "review").mockResolvedValue();
  try { await run(new Superagent(cfg, store, exec, dir, {}, gh), item, gh); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

const ok = { code: 0, stderr: "", stdout: "" };

test("canceling a queued item prevents execution and archiving preserves deduplication", async () => {
  const exec = vi.fn<Exec>().mockResolvedValue(ok);
  await fixture(exec, async (a, item) => {
    await a.controlItem("cancel", item.id);
    await a.controlItem("archive", item.id);
    await a.drain();
    expect(exec).not.toHaveBeenCalled();
    expect(item.status).toBe("canceled");
    expect(item.archived).toBe(true);
    expect(a.store.has(item.commentId)).toBe(true);
    await expect(a.controlItem("retry", item.id)).rejects.toThrow(/archived/);
  });
});

test("retry uses another worktree, and cancellation aborts the worker without publishing", async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const exec = vi.fn<Exec>(async (command, _args, opts) => {
    if (command !== "env") return ok;
    entered();
    return new Promise(resolve => opts?.signal?.addEventListener("abort", () => resolve(ok), { once: true }));
  });
  await fixture(exec, async (a, item, gh) => {
    await a.controlItem("retry", item.id);
    await started;
    expect(exec.mock.calls.find(([cmd, args]) => cmd === "git" && args.includes("add"))?.[1][3]).not.toBe(`superagent/${item.id}`);
    await a.controlItem("cancel", item.id);
    await vi.waitFor(() => expect(item.status).toBe("canceled"));
    expect(gh.review).not.toHaveBeenCalled();
    expect(exec.mock.calls.some(([, args]) => args.includes("remove"))).toBe(false);
    await a.store.save();
  }, "failed");
});

test("cancel refuses after publication starts", async () => {
  let began!: () => void;
  let release!: () => void;
  const publishing = new Promise<void>(r => { began = r; });
  const waiting = new Promise<void>(r => { release = r; });
  const exec = vi.fn<Exec>(async command => command === "env" ? { ...ok, stdout: JSON.stringify({
    summary: "Reviewed", verdict: "COMMENT", findings: [], criticalSummary: "Critical issue",
  }) } : ok);
  await fixture(exec, async (a, item, gh) => {
    vi.mocked(gh.review).mockImplementation(async () => { began(); await waiting; });
    await a.controlItem("run", item.id);
    await publishing;
    try {
      expect(a.itemPhase(item.id)).toBe("publishing");
      await expect(a.controlItem("cancel", item.id)).rejects.toThrow(/Publishing already started/);
    } finally { release(); }
    await vi.waitFor(() => expect(a.running).toBe(0));
    expect(item.status).toBe("done");
  });
});

test("run now cannot bypass dry-run or a removed review request", async () => {
  const exec = vi.fn<Exec>().mockResolvedValue(ok);
  await fixture(exec, async (a, item, gh) => {
    vi.mocked(gh.requestedReview).mockResolvedValue(undefined);
    await a.controlItem("run", item.id);
    await vi.waitFor(() => expect(item.outcome).toContain("Skipped"));
    expect(exec).not.toHaveBeenCalled();
    await a.store.save();
  });
  await fixture(exec, async (a, item) => {
    await expect(a.controlItem("run", item.id)).rejects.toThrow(/dry.run/i);
    expect(item.status).toBe("queued");
  }, "queued", true);
});
