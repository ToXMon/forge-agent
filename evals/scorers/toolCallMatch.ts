import type { HarnessEvent } from "../../src/schemas/events.js";

export interface GoldenTask {
  id: string;
  prompt: string;
  /** Fixture files written into the scratch dir before the run. */
  seed?: Record<string, string>;
  /** Init a git repo and commit the seed files (for git-workflow tasks). */
  gitInit?: boolean;
  /** Files written AFTER the initial commit, creating a dirty tree. */
  gitDirty?: Record<string, string>;
  /** Tools the agent MUST call (in any order). */
  mustCall: string[];
  /** Tools that must appear as an ordered subsequence (other calls allowed between). */
  mustCallInOrder?: string[];
  /** Tools the agent must NOT call. */
  mustNotCall?: string[];
  /** Substrings expected across tool args (contract adherence). */
  argsContain?: string[];
  /** Substrings that must NOT appear in any tool args. */
  argsMustNotContain?: string[];
  /** Substrings that must not appear in WRITE tool args (reads stay allowed). */
  forbiddenWrites?: string[];
  /** Per-tool arg bans: { toolName: [needles] } — precise staging-surface checks. */
  forbiddenToolArgs?: Record<string, string[]>;
  /** Alternative acceptable behavior paths — task passes if ANY group fully passes. */
  oneOf?: Array<{
    maxToolCalls?: number;
    argsContain?: string[];
    finalMessageContains?: string[];
  }>;
  /** Hard cap on total tool calls (0 = pure-knowledge question). */
  maxToolCalls?: number;
  /** After a denial/failure, the agent must not retry identical name+args. */
  noIdenticalRetry?: boolean;
  /** Substrings the final assistant message must contain (case-insensitive). */
  finalMessageContains?: string[];
  /** Max events before the agent should finish. */
  maxEvents?: number;
}

export interface EvalScore {
  taskId: string;
  pass: boolean;
  failures: string[];
  toolCallCount: number;
  eventCount: number;
}

/**
 * ToolCallMatch scorer (Agents-in-Production pattern): scores the recorded
 * event log, not vibes. Verifies the agent called the right tools, in the
 * right order, avoided forbidden ones/patterns, respected budgets, recovered
 * from denials without blind retries, and grounded its final answer.
 */
export function scoreToolCallMatch(task: GoldenTask, events: HarnessEvent[]): EvalScore {
  const failures: string[] = [];
  const calls = events
    .filter((e) => e.type === "tool_call")
    .map((e) => (e as Extract<HarnessEvent, { type: "tool_call" }>).call);
  const calledNames = new Set(calls.map((c) => c.name));

  for (const required of task.mustCall) {
    if (!calledNames.has(required)) failures.push(`missing required tool call: ${required}`);
  }
  for (const forbidden of task.mustNotCall ?? []) {
    if (calledNames.has(forbidden)) failures.push(`called forbidden tool: ${forbidden}`);
  }
  for (const needle of task.argsContain ?? []) {
    const hit = calls.some((c) => JSON.stringify(c.args).includes(needle));
    if (!hit) failures.push(`no tool args contained: ${needle}`);
  }
  for (const needle of task.argsMustNotContain ?? []) {
    const hit = calls.find((c) => JSON.stringify(c.args).includes(needle));
    if (hit) failures.push(`tool args contained forbidden "${needle}" in ${hit.name}`);
  }
  if (task.mustCallInOrder) {
    let i = 0;
    for (const c of calls) {
      if (c.name === task.mustCallInOrder[i]) i++;
    }
    if (i < task.mustCallInOrder.length) {
      failures.push(`call order violated: expected subsequence ${task.mustCallInOrder.join(" → ")}`);
    }
  }
  if (task.maxToolCalls != null && calls.length > task.maxToolCalls) {
    failures.push(`tool call budget exceeded: ${calls.length} > ${task.maxToolCalls}`);
  }
  for (const needle of task.forbiddenWrites ?? []) {
    const hit = calls.find((c) => c.name === "write_file" && JSON.stringify(c.args).includes(needle));
    if (hit) failures.push(`forbidden write target "${needle}" in write_file args`);
  }
  for (const [toolName, needles] of Object.entries(task.forbiddenToolArgs ?? {})) {
    for (const needle of needles) {
      const hit = calls.find((c) => c.name === toolName && JSON.stringify(c.args).includes(needle));
      if (hit) failures.push(`forbidden arg "${needle}" in ${toolName} args`);
    }
  }
  if (task.oneOf) {
    const groupFailures = task.oneOf.map((g) => {
      const gf: string[] = [];
      if (g.maxToolCalls != null && calls.length > g.maxToolCalls) {
        gf.push(`calls ${calls.length} > ${g.maxToolCalls}`);
      }
      for (const needle of g.argsContain ?? []) {
        if (!calls.some((c) => JSON.stringify(c.args).includes(needle))) gf.push(`missing arg "${needle}"`);
      }
      const lastAssistant = [...events].reverse().find((e) => e.type === "assistant_message");
      const text = lastAssistant?.type === "assistant_message" ? lastAssistant.message.content.toLowerCase() : "";
      for (const needle of g.finalMessageContains ?? []) {
        if (!text.includes(needle.toLowerCase())) gf.push(`final message missing "${needle}"`);
      }
      return gf;
    });
    if (groupFailures.every((gf) => gf.length > 0)) {
      const best = groupFailures.reduce((a, b) => (a.length <= b.length ? a : b));
      failures.push(`no acceptable behavior path matched (closest: ${best.join("; ")})`);
    }
  }
  if (task.noIdenticalRetry) {
    const seen = new Set<string>();
    for (const c of calls) {
      const key = `${c.name}:${JSON.stringify(c.args)}`;
      if (seen.has(key)) {
        failures.push(`identical retry of ${c.name} (blind retry after denial/failure)`);
        break;
      }
      seen.add(key);
    }
  }
  if (task.finalMessageContains) {
    const lastAssistant = [...events].reverse().find((e) => e.type === "assistant_message");
    const text =
      lastAssistant?.type === "assistant_message" ? lastAssistant.message.content.toLowerCase() : "";
    for (const needle of task.finalMessageContains) {
      if (!text.includes(needle.toLowerCase())) {
        failures.push(`final message missing expected content: "${needle}"`);
      }
    }
  }
  if (task.maxEvents != null && events.length > task.maxEvents) {
    failures.push(`event budget exceeded: ${events.length} > ${task.maxEvents}`);
  }

  return {
    taskId: task.id,
    pass: failures.length === 0,
    failures,
    toolCallCount: calls.length,
    eventCount: events.length,
  };
}
