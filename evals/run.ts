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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  for (const task of GOLDEN_TASKS) {
    const workDir = mkdtempSync(join(tmpdir(), `forge-eval-${task.id}-`));
    writeFileSync(join(workDir, "hello.txt"), "Helo world\n", "utf8");

    const bus = new HarnessBus();
    const loop = new AgentLoop({ llm, tools: codingToolRegistry(), policy: new PolicyGuard(), bus, workDir });

    // Auto-deny all approvals: evals never execute dangerous operations.
    bus.subscribe(loop.sessionId, (ev) => {
      if (ev.type === "approval_requested") {
        bus.submitApproval(loop.sessionId, ev.call.id, false, "eval harness auto-deny");
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
