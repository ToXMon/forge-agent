#!/usr/bin/env node
import { createInterface } from "node:readline";
import { ProviderRegistry } from "./harness/providers.js";
import { HarnessBus } from "./harness/bus.js";
import { PolicyGuard } from "./harness/policy.js";
import { AgentLoop } from "./harness/loop.js";
import { codingToolRegistry } from "./tools/index.js";
import { fullstackAgent } from "./agents/fullstack.js";
import { summarizeSession, formatStats } from "./harness/stats.js";
import { loadSkills } from "./skills/loader.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const workDir = process.cwd();
const autoApprove = process.argv.includes("--yolo");
const sessionFlag = process.argv.indexOf("--session");
const sessionId = sessionFlag > -1 ? process.argv[sessionFlag + 1] : undefined;

const bus = new HarnessBus();
const providers = ProviderRegistry.fromEnv();
const llm = providers.defaultProvider();
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

function listProviders(): void {
  const names = providers.names();
  if (names.length === 0) {
    console.log("\x1b[33mNo providers registered\x1b[0m — set FORGE_PROVIDERS or FORGE_API_KEY+FORGE_BASE_URL");
    return;
  }
  console.log(`\x1b[1mproviders\x1b[0m (${names.length}): ${names.join(", ")}`);
  console.log(`default: ${llm.model}`);
}

function listSkills(): void {
  // Resolve the bundled skills dir relative to this CLI file.
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "../skills");
  const skills = loadSkills(root);
  if (skills.length === 0) {
    console.log("\x1b[33mno bundled skills\x1b[0m");
    return;
  }
  console.log(`\x1b[1mbundled skills\x1b[0m (${skills.length}):`);
  for (const s of skills) {
    console.log(`  · ${s.name} (v${s.version})${s.description ? ` — ${s.description}` : ""}`);
    if (Object.keys(s.companions).length) {
      console.log(`    companions: ${Object.keys(s.companions).join(", ")}`);
    }
  }
}

function showStats(target: string | undefined): void {
  const id = target ?? loop.sessionId;
  console.log(formatStats(summarizeSession(workDir, id)));
}

function help(): void {
  console.log(`\x1b[1mcommands\x1b[0m:
  /help              show this
  /providers         list registered LLM providers + default
  /skills            list bundled skills
  /stats [sessionId] show stats for current or named session
  anything else      send to the agent`);
}

console.log(`\x1b[1mforge\x1b[0m — session ${loop.sessionId}${autoApprove ? " (YOLO: auto-approving)" : ""}
model: ${llm.model}
workdir: ${workDir}
Type your task. Ctrl+C to exit (session is checkpointed; resume with --session ${loop.sessionId}).
Slash commands: /help for the list.`);

function ask(): void {
  rl.question("\n\x1b[35myou>\x1b[0m ", async (input) => {
    const text = input.trim();
    if (!text) return ask();

    // Slash commands bypass the agent and operate on the harness directly.
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      switch (cmd) {
        case "help": help(); break;
        case "providers": listProviders(); break;
        case "skills": listSkills(); break;
        case "stats": showStats(rest[0]); break;
        default: console.log(`\x1b[33munknown command: /${cmd}\x1b[0m — try /help`);
      }
      return ask();
    }

    try {
      const state = await loop.run(fullstackAgent(contextDocs), text, { autoApprove });
      if (state.status === "failed") console.log(`\x1b[31msession failed: ${state.lastError}\x1b[0m`);
    } catch (err) {
      console.log(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m`);
    }
    ask();
  });
}
ask();
