import type { HarnessEvent } from "../../src/schemas/events.js";

export interface GoldenTask {
  id: string;
  prompt: string;
  /** Tools the agent MUST call (in any order). */
  mustCall: string[];
  /** Tools the agent must NOT call. */
  mustNotCall?: string[];
  /** Substrings expected across tool args (contract adherence). */
  argsContain?: string[];
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
 * event log, not vibes. Verifies the agent called the right tools, avoided
 * forbidden ones, and stayed within budget.
 */
export function scoreToolCallMatch(task: GoldenTask, events: HarnessEvent[]): EvalScore {
  const failures: string[] = [];
  const calls = events.filter((e) => e.type === "tool_call").map((e) => (e as Extract<HarnessEvent, { type: "tool_call" }>).call);
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
