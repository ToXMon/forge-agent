#!/usr/bin/env node
/**
 * Eval runner: executes golden tasks against a scratch copy of the repo and
 * scores the event logs with ToolCallMatch. Requires FORGE_API_KEY.
 *
 *   npm run eval               # all tasks, approval-denying harness (safe)
 *
 * Deploy/dangerous tools are denied automatically here — evals test routing
 * and contract behavior, not production side effects.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { providerFromEnv } from "../src/harness/llm.js";
import { HarnessBus } from "../src/harness/bus.js";
import { PolicyGuard } from "../src/harness/policy.js";
import { AgentLoop } from "../src/harness/loop.js";
import { codingToolRegistry } from "../src/tools/index.js";
import { fullstackAgent } from "../src/agents/fullstack.js";
import { GOLDEN_TASKS } from "./golden/tasks.js";
import { scoreToolCallMatch } from "./scorers/toolCallMatch.js";
import { Checkpointer } from "../src/harness/checkpoint.js";

async function main() {
  const llm = providerFromEnv();
  const results = [];

  // Optional filter: npm run eval -- --tasks id1,id2 (cheap re-runs)
  const flag = process.argv.indexOf("--tasks");
  const only = flag > -1 ? new Set(process.argv[flag + 1].split(",")) : null;
  const tasks = only ? GOLDEN_TASKS.filter((t) => only.has(t.id)) : GOLDEN_TASKS;

  for (const task of tasks) {
    const workDir = mkdtempSync(join(tmpdir(), `forge-eval-${task.id}-`));
    seedFixtures(workDir, task);

    const bus = new HarnessBus();
    const loop = new AgentLoop({ llm, tools: codingToolRegistry(), policy: new PolicyGuard(), bus, workDir });

    // Scoped auto-approval: scratch-dir write/run/commit operations are
    // approved so tasks execute end-to-end; deploy and anything else is
    // auto-denied — evals test routing and contract behavior safely.
    const EVAL_APPROVE = new Set(["write_file", "run_bash", "git_commit"]);
    bus.subscribe(loop.sessionId, (ev) => {
      if (ev.type === "approval_requested") {
        const ok = EVAL_APPROVE.has(ev.call.name);
        bus.submitApproval(loop.sessionId, ev.call.id, ok, ok ? "eval auto-approve (scratch dir)" : "eval auto-deny (dangerous)");
      }
    });

    await loop.run(fullstackAgent(), task.prompt, { maxSteps: 15 });
    const events = new Checkpointer(workDir, loop.sessionId).events();
    const score = scoreToolCallMatch(task, events);
    results.push(score);
    console.log(`${score.pass ? "PASS" : "FAIL"} ${score.taskId} (${score.toolCallCount} calls, ${score.eventCount} events)`);
    for (const f of score.failures) console.log(`     - ${f}`);
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} tasks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

/** Seed a task's fixture files and optional git state into the scratch dir. */
function seedFixtures(workDir: string, task: (typeof GOLDEN_TASKS)[number]): void {
  const write = (rel: string, content: string) => {
    const abs = join(workDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  for (const [rel, content] of Object.entries(task.seed ?? {})) write(rel, content);
  if (task.gitInit) {
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: workDir, stdio: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
    git(["init", "-q", "-b", "main"]);
    git(["-c", "user.name=eval", "-c", "user.email=eval@forge.dev", "add", "-A"]);
    git(["-c", "user.name=eval", "-c", "user.email=eval@forge.dev", "commit", "-qm", "seed"]);
  }
  for (const [rel, content] of Object.entries(task.gitDirty ?? {})) write(rel, content);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
