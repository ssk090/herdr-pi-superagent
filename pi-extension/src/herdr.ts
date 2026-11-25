import { lstat, mkdir, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ItemAction } from "./types.ts";

export type HerdrAction = "start" | "stop" | "poll";

export function herdrSocket(terminal = process.env.HC_TERMINAL_ID) {
  return terminal && /^[a-zA-Z0-9_-]+$/.test(terminal)
    ? join(homedir(), ".pi", "sa", `${terminal}.sock`)
    : undefined;
}

export async function serveHerdr(socket: string, status: () => Promise<object>, command: (action: HerdrAction) => Promise<void>,
  itemCommand?: (action: ItemAction, id: string) => Promise<void>, cleanWorktrees?: (id?: string) => Promise<void>) {
  const dir = dirname(socket);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error(`Superagent socket directory is not private: ${dir}`);
  }

  const server = createServer(async (req, res) => {
    const reply = (code: number, data: object) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === "GET" && req.url === "/ready") return reply(200, { ready: true });
      if (req.method === "GET" && req.url === "/status") return reply(200, await status());
      const clean = /^\/worktrees(?:\/(\d+--?\d+))?\/remove$/.exec(req.url ?? "");
      if (req.method === "POST" && clean && cleanWorktrees) {
        await cleanWorktrees(clean[1]);
        return reply(200, { ok: true });
      }
      const item = /^\/items\/(\d+--?\d+)\/(run|retry|cancel|archive|approve)$/.exec(req.url ?? "");
      if (req.method === "POST" && item && itemCommand) {
        await itemCommand(item[2] as ItemAction, item[1]);
        return reply(200, { ok: true });
      }
      const action = req.url?.slice(1);
      if (req.method !== "POST" || (action !== "start" && action !== "stop" && action !== "poll")) {
        return reply(404, { error: "Unknown superagent operation" });
      }
      await command(action);
      reply(200, { ok: true });
    } catch (error) {
      reply(409, { error: (error as Error).message });
    }
  });
  const listen = () => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => { server.off("error", reject); resolve(); });
  });
  try { await listen(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || !(await lstat(socket)).isSocket()) throw error;
    const stale = await new Promise<boolean>((resolve) => {
      const probe = createConnection(socket);
      probe.once("connect", () => { probe.destroy(); resolve(false); });
      probe.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "ECONNREFUSED"));
    });
    if (!stale) throw error;
    await unlink(socket);
    await listen();
  }
  server.unref();
  return () => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
