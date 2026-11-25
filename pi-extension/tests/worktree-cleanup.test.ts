import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { managedWorktrees, cleanupWorktree } from "../src/executor.ts";
import type { Exec } from "../src/types.ts";

const spawn = promisify(execFile);
const exec: Exec = async (cmd, args, opts) => {
  try { return { ...await spawn(cmd, args, { ...opts, encoding: "utf8" }), code: 0 }; }
  catch (e) { return { code: 1, stdout: "", stderr: String(e) }; }
};

test("removes dirty managed checkouts without deleting their branches or other worktrees", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "sa-clean-"));
  const root = join(cwd, ".pi", "superagent", "worktrees");
  const dirty = join(root, "42--42-abcdef12");
  const unrelated = join(root, "43--43");
  const git = async (...args: string[]) => expect((await exec("git", args, { cwd })).code).toBe(0);
  try {
    await git("init");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "fixture");
    await mkdir(root, { recursive: true });
    await git("worktree", "add", "-b", "superagent/42--42-abcdef12", dirty);
    await git("worktree", "add", "-b", "unrelated", unrelated);
    await writeFile(join(dirty, "uncommitted.txt"), "dirty");
    const managed = await managedWorktrees(exec, cwd);
    expect(managed.map(w => w.id)).toEqual(["42--42"]);
    await cleanupWorktree(exec, cwd, managed[0].path);
    await expect(access(dirty)).rejects.toThrow();
    await expect(access(unrelated)).resolves.toBeUndefined();
    await git("show-ref", "--verify", "refs/heads/superagent/42--42-abcdef12");
    await expect(cleanupWorktree(async () => ({ code: 1, stdout: "", stderr: "locked checkout" }), cwd, dirty)).rejects.toThrow("locked checkout");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
