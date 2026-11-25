import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Superagent } from "./agent.ts";
import { managedWorktrees } from "./executor.ts";
import { loadConfig } from "./config.ts";
import { checkCommand } from "./guard.ts";
import { herdrSocket, serveHerdr, type HerdrAction } from "./herdr.ts";
import type { Exec, ItemAction } from "./types.ts";
import { WorkStore } from "./workitems.ts";
import { registerSubagentChild, registerSubagentParent } from "./subagent/extension.ts";

export default function superagent(pi: ExtensionAPI) {
  const isWorker = process.env.SUPERAGENT_WORKER === "1";
  const isSubagent = !!process.env.PI_SUBAGENT_ID;
  let agent: Superagent | undefined;
  let ui: ExtensionContext["ui"] | undefined;
  let bridge: ReturnType<typeof serveHerdr> | undefined;
  let operations = Promise.resolve();

  // Guard: always on inside worker sessions; on in the operator session while the agent is running.
  pi.on("tool_call", async (event) => {
    if (!isWorker && !agent?.active) return;
    if (isToolCallEventType("bash", event)) {
      const c = checkCommand(event.input.command);
      if (!c.ok) return { block: true, reason: `pi-superagent guard: ${c.reason}` };
    }
  });

  if (isSubagent) { registerSubagentChild(pi); return; }
  if (isWorker) return;

  registerSubagentParent(pi);

  const exec: Exec = async (cmd, args, opts) => {
    const r = await pi.exec(cmd, args, opts);
    return { stdout: r.stdout, stderr: r.stderr, code: r.code };
  };

  const render = () => {
    if (!ui || !agent) return;
    const s = agent.store;
    const n = (st: Parameters<typeof s.byStatus>[0]) => s.byStatus(st).length;
    ui.setStatus("superagent", agent.active
      ? `superagent ● ${agent.cfg.repo} run:${n("running")} q:${n("queued")} ?:${n("needs-human")}${agent.lastError ? " ⚠" : ""}`
      : "superagent ○ stopped");
  };

  const statusLines = () => {
    if (!agent) return ["superagent not started"];
    const lines = [
      `repo ${agent.cfg.repo}  mention ${agent.cfg.mention}  ${agent.active ? "running" : "stopped"}${agent.cfg.dryRun ? " (dry-run)" : ""}`,
      `last poll ${agent.lastPoll ?? "-"}${agent.lastError ? `  error: ${agent.lastError}` : ""}`,
    ];
    for (const i of agent.store.state.items.slice(-15).reverse()) lines.push(`${i.status.padEnd(11)} #${i.issue} ${i.id} @${i.author} ${i.prUrl ?? i.error?.slice(0, 60) ?? i.request.slice(0, 60)}`);
    return lines;
  };

  const enqueue = (fn: () => Promise<void>) => {
    const operation = operations.then(fn);
    operations = operation.catch(() => {});
    return operation;
  };

  const loadAgent = async (cwd: string) =>
    new Superagent(await loadConfig(cwd), await WorkStore.forCwd(cwd).load(), exec, cwd, { onChange: render });

  const control = (action: HerdrAction, cwd: string) => enqueue(async () => {
    if (action === "stop") agent?.stop();
    else {
      if (!agent?.active && !agent?.polling && !agent?.running) agent = await loadAgent(cwd);
      if (action === "start") agent!.start();
      else void agent!.poll().catch(() => {}); // lastError is shown in both UIs.
    }
    render();
  });

  const itemControl = (action: ItemAction, id: string, cwd: string) => enqueue(async () => {
    agent ??= await loadAgent(cwd);
    await agent.controlItem(action, id);
  });

  const enableHerdr = async (cwd: string) => {
    const socket = herdrSocket();
    if (!socket) return false;
    bridge ??= serveHerdr(socket, async () => {
      const current = agent;
      const store = current?.store ?? await WorkStore.forCwd(cwd).load();
      let repo = current?.cfg.repo, dryRun = current?.cfg.dryRun, error = current?.lastError;
      if (!current) {
        try { ({ repo, dryRun } = await loadConfig(cwd)); }
        catch (e) { error = (e as Error).message; }
      }
      const worktrees = repo ? await managedWorktrees(exec, cwd).catch(() => undefined) : undefined;
      return { cwd, repo, dryRun, error, itemControls: true, manualApproval: true, liveProgress: true, worktrees: worktrees?.map(w => w.id), active: current?.active ?? false, polling: current?.polling ?? false,
        lastPoll: current?.lastPoll, lastPollSummary: current?.lastPollSummary, items: store.state.items.filter(item => !item.archived)
          .map(item => ({ ...item, phase: current?.itemPhase(item.id), progress: current?.itemProgress(item.id) })),
        archivedItems: store.state.items.filter(item => item.archived) };
    }, action => control(action, cwd), (action, id) => itemControl(action, id, cwd), id => enqueue(async () => {
      agent ??= await loadAgent(cwd);
      await agent.removeWorktrees(id);
    }));
    try { await bridge; }
    catch (e) { bridge = undefined; throw e; }
    return true;
  };

  pi.registerCommand("superagent", {
    description: "pi-superagent: start | stop | status | poll",
    getArgumentCompletions: (p) => ["start", "stop", "status", "poll"].filter((x) => x.startsWith(p)).map((x) => ({ value: x, label: x })),
    handler: async (args, ctx) => {
      ui = ctx.ui;
      const sub = args.trim().split(/\s+/)[0];
      try {
        const herdr = await enableHerdr(ctx.cwd).catch(e => {
          ctx.ui.notify(`Could not enable Herdr controls: ${(e as Error).message}`, "warning");
          return false;
        });
        if (sub === "start" || sub === "stop" || sub === "poll") {
          await control(sub, ctx.cwd);
          ctx.ui.notify(sub === "start" ? `superagent watching ${agent!.cfg.repo}` : sub === "stop" ? "superagent stopped" : "superagent poll requested", "info");
        } else {
          ctx.ui.setWidget("superagent", undefined);
          ctx.ui.notify(!sub && herdr ? "Superagent controls are in the Herdr top bar" : statusLines().join("\n"), "info");
        }
      } catch (e) {
        ctx.ui.notify(`superagent: ${(e as Error).message}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await bridge?.then(close => close(), () => {});
    await operations;
    agent?.stop();
  });
}
