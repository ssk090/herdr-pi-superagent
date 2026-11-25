import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { serveHerdr } from "../src/herdr.ts";
import { Superagent } from "../src/agent.ts";
import type { SuperagentConfig } from "../src/types.ts";
import { WorkStore } from "../src/workitems.ts";

const exec = promisify(execFile);

test("the private Herdr socket exposes status and only the three control actions", async () => {
  const dir = await mkdtemp(join(tmpdir().startsWith("/var/folders/") ? "/tmp" : tmpdir(), "sa-test-"));
  const socket = join(dir, "control.sock");
  const command = vi.fn(async () => {});
  const itemCommand = vi.fn(async () => {});
  const close = await serveHerdr(socket, async () => ({ active: false }), command, itemCommand);
  const request = async (method: string, path: string) => (await exec("curl", ["-fsS", "--unix-socket", socket, "-X", method, `http://localhost${path}`])).stdout;
  try {
    expect(JSON.parse(await request("GET", "/status"))).toEqual({ active: false });
    await expect(request("GET", "/start")).rejects.toThrow();
    await expect(request("POST", "/delete")).rejects.toThrow();
    for (const action of ["start", "stop", "poll"]) await request("POST", `/${action}`);
    expect(command.mock.calls).toEqual([["start"], ["stop"], ["poll"]]);
    await expect(request("GET", "/items/42--42/cancel")).rejects.toThrow();
    await expect(request("POST", "/items/invalid/archive")).rejects.toThrow();
    for (const action of ["run", "retry", "cancel", "archive"]) await request("POST", `/items/42--42/${action}`);
    expect(itemCommand.mock.calls).toEqual([["run", "42--42"], ["retry", "42--42"], ["cancel", "42--42"], ["archive", "42--42"]]);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("active starts immediately, concurrent polls share a cycle, and stop does not rearm", async () => {
  vi.useFakeTimers();
  try {
    const a = new Superagent({ pollIntervalSec: 1, dryRun: true } as SuperagentConfig,
      new WorkStore("unused"), async () => { throw new Error("unexpected exec"); }, ".");
    let finish!: () => void;
    const cycle = vi.spyOn(a.gh, "triggersSince").mockImplementation(() => new Promise(resolve => { finish = () => resolve([]); }));
    vi.spyOn(a.store, "save").mockResolvedValue();
    a.start();
    expect(a.active).toBe(true);
    const poll = a.poll();
    expect(cycle).toHaveBeenCalledTimes(1);
    a.stop();
    finish();
    await poll;
    await vi.advanceTimersByTimeAsync(2000);
    expect(a.active).toBe(false);
    expect(cycle).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
