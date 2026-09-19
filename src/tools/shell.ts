import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "../harness/tools.js";
import { PolicyGuard } from "../harness/policy.js";

const run = promisify(execFile);

export const runBashTool = defineTool({
  name: "run_bash",
  description:
    "Run a bash command in the working directory. Dangerous: requires approval. 60s default timeout, output capped.",
  schema: z.object({
    command: z.string(),
    timeoutSec: z.number().int().positive().max(600).default(60),
  }),
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeoutSec: { type: "integer", default: 60, maximum: 600 },
    },
    required: ["command"],
  },
  async execute(args, ctx) {
    // Belt-and-suspenders: the policy layer gates this tool, but a red-flag
    // command is refused outright even after approval unless explicitly allowed.
    const flag = PolicyGuard.shellRedFlag(args.command);
    if (flag) {
      throw new Error(`refused: ${flag}. This command class is hard-blocked by the sandbox.`);
    }
    try {
      const { stdout, stderr } = await run("bash", ["-lc", args.command], {
        cwd: ctx.workDir,
        timeout: (args.timeoutSec ?? 60) * 1000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CI: "1", DEBIAN_FRONTEND: "noninteractive" },
      });
      return [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n") || "(no output)";
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      const out = [e.stdout, e.stderr].filter(Boolean).join("\n--- stderr ---\n");
      return `EXIT NON-ZERO: ${e.message}\n${out}`.trim();
    }
  },
});

function gitTool(name: string, description: string, gitArgs: string[]) {
  return defineTool({
    name,
    description,
    schema: z.object({}),
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      try {
        const { stdout } = await run("git", gitArgs, { cwd: ctx.workDir, maxBuffer: 4 * 1024 * 1024 });
        return stdout.trim() || "(clean / no output)";
      } catch (err) {
        const e = err as { stderr?: string; message: string };
        return `git error: ${e.stderr ?? e.message}`;
      }
    },
  });
}

export const gitStatusTool = gitTool("git_status", "Show git working tree status (short).", ["status", "--short", "--branch"]);
export const gitDiffTool = gitTool("git_diff", "Show unstaged git diff (stat + patch, capped).", ["--no-pager", "diff"]);
export const gitLogTool = gitTool("git_log", "Show recent git history (oneline, last 15).", ["--no-pager", "log", "--oneline", "-15"]);

export const gitCommitTool = defineTool({
  name: "git_commit",
  description: "Stage specific files and commit with a message. Requires approval.",
  schema: z.object({
    files: z.array(z.string()).min(1),
    message: z.string().min(3),
  }),
  parameters: {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string" } },
      message: { type: "string" },
    },
    required: ["files", "message"],
  },
  async execute(args, ctx) {
    await run("git", ["add", "--", ...args.files], { cwd: ctx.workDir });
    const { stdout } = await run("git", ["commit", "-m", args.message], { cwd: ctx.workDir, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  },
});
