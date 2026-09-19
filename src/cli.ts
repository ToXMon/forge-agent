#!/usr/bin/env node
import { createInterface } from "node:readline";
import { providerFromEnv } from "./harness/llm.js";
import { HarnessBus } from "./harness/bus.js";
import { PolicyGuard } from "./harness/policy.js";
import { AgentLoop } from "./harness/loop.js";
import { codingToolRegistry } from "./tools/index.js";
import { fullstackAgent } from "./agents/fullstack.js";
import { readFileSync, existsSync } from "node:fs";

const workDir = process.cwd();
const autoApprove = process.argv.includes("--yolo");
const sessionFlag = process.argv.indexOf("--session");
const sessionId = sessionFlag > -1 ? process.argv[sessionFlag + 1] : undefined;

const bus = new HarnessBus();
const llm = providerFromEnv();
const tools = codingToolRegistry();
const loop = new AgentLoop({ llm, tools, policy: new PolicyGuard(), bus, workDir, sessionId });

const contextDocs: string[] = [];
if (existsSync("AGENTS.md")) contextDocs.push(readFileSync("AGENTS.md", "utf8"));

// Live event rendering.
bus.subscribe(loop.sessionId, (ev) => {
  switch (ev.type) {
    case "assistant_message":
      if (ev.message.content) console.log(`\n\x1b[36mforge>\x1b[0m ${ev.message.content}`);
      break;
    case "tool_call":
      console.log(`\x1b[90m  → ${ev.call.name}(${JSON.stringify(ev.call.args).slice(0, 120)})\x1b[0m`);
      break;
    case "tool_result":
      console.log(`\x1b[90m  ${ev.result.ok ? "✓" : "✗"} ${ev.result.name} (${ev.result.durationMs}ms) ${ev.result.output.slice(0, 200)}\x1b[0m`);
      break;
    case "approval_requested":
      console.log(`\n\x1b[33m⚠ approval needed: ${ev.call.name}\x1b[0m\n  reason: ${ev.reason}\n  args: ${JSON.stringify(ev.call.args).slice(0, 300)}`);
      promptApproval(ev.call.id);
      break;
    case "error":
      console.log(`\x1b[31merror: ${ev.message}\x1b[0m`);
      break;
    case "done":
      console.log(`\n\x1b[32mdone:\x1b[0m ${ev.reason}`);
      break;
  }
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
const pendingPrompts = new Map<string, (answer: string) => void>();

function promptApproval(callId: string): void {
  rl.question("approve? [y/N] ", (answer) => {
    const approved = /^y(es)?$/i.test(answer.trim());
    bus.submitApproval(loop.sessionId, callId, approved);
  });
}

console.log(`\x1b[1mforge\x1b[0m — session ${loop.sessionId}${autoApprove ? " (YOLO: auto-approving)" : ""}\nmodel: ${llm.model}\nworkdir: ${workDir}\nType your task. Ctrl+C to exit (session is checkpointed; resume with --session ${loop.sessionId}).`);

function ask(): void {
  rl.question("\n\x1b[35myou>\x1b[0m ", async (input) => {
    const task = input.trim();
    if (!task) return ask();
    try {
      const state = await loop.run(fullstackAgent(contextDocs), task, { autoApprove });
      if (state.status === "failed") console.log(`\x1b[31msession failed: ${state.lastError}\x1b[0m`);
    } catch (err) {
      console.log(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m`);
    }
    ask();
  });
}
ask();
