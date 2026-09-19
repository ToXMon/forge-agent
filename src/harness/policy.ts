import type { ToolCall } from "../schemas/events.js";

export type RiskClass = "safe" | "dangerous";

export interface PolicyDecision {
  allow: boolean;
  requiresApproval: boolean;
  reason: string;
}

export interface PolicyRule {
  /** Tool name or glob-ish prefix, e.g. "run_bash" or "deploy.*" */
  tool: string;
  risk: RiskClass;
  /** Optional arg-level check — return a reason string to force approval. */
  escalate?: (args: Record<string, unknown>) => string | null;
}

/** Dangerous shell patterns that always force approval even if a tool is marked safe. */
const SHELL_RED_FLAGS = [
  /\brm\s+-[a-z]*r[a-z]*f\b/i,
  /\brm\s+-[a-z]*f[a-z]*r\b/i,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /:\(\)\{\s*:\|:&\s*\};:/, // fork bomb
  /\bshutdown\b|\breboot\b|\bhalt\b/,
  /\biptables\b|\bufw\s+disable\b/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, // curl-pipe-shell
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+reset\s+--hard\b/,
];

const DEFAULT_RULES: PolicyRule[] = [
  { tool: "read_file", risk: "safe" },
  { tool: "grep", risk: "safe" },
  { tool: "glob", risk: "safe" },
  { tool: "list_dir", risk: "safe" },
  { tool: "git_status", risk: "safe" },
  { tool: "git_diff", risk: "safe" },
  { tool: "git_log", risk: "safe" },
  {
    tool: "write_file",
    risk: "dangerous",
    escalate: (a) => {
      const p = String(a.path ?? "");
      if (/(^|\/)\.env(\.|$)/.test(p)) return "refusing to write .env files without explicit approval";
      if (/secrets?|credential|id_rsa|\.pem$/i.test(p)) return "path looks like a secret/credential file";
      return null;
    },
  },
  {
    tool: "run_bash",
    risk: "dangerous",
    escalate: (a) => {
      const cmd = String(a.command ?? "");
      for (const re of SHELL_RED_FLAGS) {
        if (re.test(cmd)) return `shell red flag matched: ${re.source}`;
      }
      return null;
    },
  },
  { tool: "git_commit", risk: "dangerous" },
  { tool: "deploy", risk: "dangerous" },
];

/**
 * Policy guard: intercepts every tool call before execution.
 * Safe tools pass; dangerous tools require human approval;
 * arg-level escalation can force approval for anything.
 */
export class PolicyGuard {
  private rules: PolicyRule[];

  constructor(extraRules: PolicyRule[] = []) {
    this.rules = [...DEFAULT_RULES, ...extraRules];
  }

  check(call: ToolCall): PolicyDecision {
    const rule = this.rules.find((r) =>
      r.tool.endsWith(".*") ? call.name.startsWith(r.tool.slice(0, -1)) : call.name === r.tool,
    );
    if (!rule) {
      // Unknown tools default to requiring approval — fail closed.
      return { allow: true, requiresApproval: true, reason: `unregistered tool "${call.name}" defaults to approval` };
    }
    const escalated = rule.escalate?.(call.args);
    if (escalated) {
      return { allow: true, requiresApproval: true, reason: escalated };
    }
    if (rule.risk === "dangerous") {
      return { allow: true, requiresApproval: true, reason: `${call.name} is a write/dangerous operation` };
    }
    return { allow: true, requiresApproval: false, reason: "safe tool" };
  }

  /** Universal shell check, exposed for tools that embed commands. */
  static shellRedFlag(command: string): string | null {
    for (const re of SHELL_RED_FLAGS) {
      if (re.test(command)) return `shell red flag matched: ${re.source}`;
    }
    return null;
  }
}
