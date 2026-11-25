import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import superagent from "../src/index.ts";
import { herdrSocket } from "../src/herdr.ts";
import { WorkStore } from "../src/workitems.ts";

afterEach(() => vi.unstubAllEnvs());

test("status reports once and clears any previously pinned status", async () => {
  vi.stubEnv("HC_TERMINAL_ID", undefined);
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const api: Pick<ExtensionAPI, "on" | "registerTool" | "registerCommand"> = {
    on() { return () => {}; },
    registerTool() {},
    registerCommand(name, command) { commands.set(name, command); },
  };
  superagent(api as ExtensionAPI);

  const widgets = new Map<string, string[]>([["superagent", ["stale status"]]]);
  const notices: string[] = [];
  const context = {
    ui: {
      setWidget(name: string, lines: string[] | undefined) {
        if (lines) widgets.set(name, lines);
        else widgets.delete(name);
      },
      notify(text: string) { notices.push(text); },
    },
  } as ExtensionCommandContext;

  await commands.get("superagent")!.handler("status", context);

  expect(notices).toEqual(["superagent not started"]);
  expect(widgets.has("superagent")).toBe(false);
});

test("the bare command exposes Herdr controls without starting the watcher", async () => {
  const home = await mkdtemp(join("/tmp", "sa-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("HC_TERMINAL_ID", "fixture");
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  let shutdown!: () => Promise<void>;
  const api = {
    on(event: string, handler: () => Promise<void>) {
      if (event === "session_shutdown") {
        const previous = shutdown;
        shutdown = async () => { await previous?.(); await handler(); };
      }
      return () => {};
    },
    registerTool() {},
    registerCommand(name: string, handler: typeof command) { if (name === "superagent") command = handler; },
    exec: vi.fn(),
  };
  superagent(api as unknown as ExtensionAPI);
  const notify = vi.fn();
  try {
    const store = WorkStore.forCwd(home);
    const archived = store.open({ issue: 42, commentId: 7, author: "peer", body: "", title: "Archived review", labels: [], createdAt: "" }, "Review", "review");
    store.update(archived.id, { status: "done", archived: true });
    const queued = store.open({ issue: 43, commentId: 8, author: "peer", body: "", title: "Queued review", labels: [], createdAt: "" }, "Review", "review");
    await store.save();
    await command.handler("", { cwd: home, ui: { notify, setWidget() {} } } as unknown as ExtensionCommandContext);
    expect(notify).toHaveBeenCalledWith("Superagent controls are in the Herdr top bar", "info");
    const { stdout } = await promisify(execFile)("curl", ["-fsS", "--max-time", "2", "--unix-socket", herdrSocket()!, "http://localhost/status"]);
    expect(JSON.parse(stdout)).toMatchObject({ active: false, polling: false, items: [queued], archivedItems: [archived] });
    expect(api.exec).not.toHaveBeenCalled();
  } finally {
    await shutdown();
    await rm(home, { recursive: true, force: true });
  }
});
