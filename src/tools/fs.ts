import { z } from "zod";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { defineTool, type ToolContext } from "../harness/tools.js";

/** Resolve a path inside the agent's workDir; refuse escapes. */
function scoped(ctx: ToolContext, p: string): string {
  const abs = resolve(ctx.workDir, p);
  const rel = relative(ctx.workDir, abs);
  if (rel.startsWith("..") || rel === "..") {
    throw new Error(`path escapes working directory: ${p}`);
  }
  return abs;
}

export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a text file from the working directory. Supports line ranges.",
  schema: z.object({
    path: z.string(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to working directory" },
      startLine: { type: "integer", description: "1-based start line (optional)" },
      endLine: { type: "integer", description: "1-based end line (optional)" },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const raw = await readFile(scoped(ctx, args.path), "utf8");
    if (args.startLine == null && args.endLine == null) return raw;
    const lines = raw.split("\n");
    return lines.slice((args.startLine ?? 1) - 1, args.endLine ?? lines.length).join("\n");
  },
});

export const writeFileTool = defineTool({
  name: "write_file",
  description: "Write (create or overwrite) a file in the working directory. Creates parent directories.",
  schema: z.object({ path: z.string(), content: z.string() }),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string", description: "Full file content" },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx) {
    const abs = scoped(ctx, args.path);
    await mkdir(join(abs, ".."), { recursive: true });
    const existed = existsSync(abs);
    await writeFile(abs, args.content, "utf8");
    return `${existed ? "updated" : "created"} ${args.path} (${args.content.length} bytes)`;
  },
});

export const listDirTool = defineTool({
  name: "list_dir",
  description: "List entries of a directory (non-recursive).",
  schema: z.object({ path: z.string().default(".") }),
  parameters: {
    type: "object",
    properties: { path: { type: "string", default: "." } },
  },
  async execute(args, ctx) {
    const entries = await readdir(scoped(ctx, args.path ?? "."), { withFileTypes: true });
    return entries.map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`).join("\n");
  },
});

export const globTool = defineTool({
  name: "glob",
  description: "Find files by name pattern using ripgrep's file listing (fast).",
  schema: z.object({ pattern: z.string() }),
  parameters: {
    type: "object",
    properties: { pattern: { type: "string", description: "e.g. **/*.ts" } },
    required: ["pattern"],
  },
  async execute(args, ctx) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    try {
      const { stdout } = await run("rg", ["--files", "--glob", args.pattern], { cwd: ctx.workDir, maxBuffer: 8 * 1024 * 1024 });
      return stdout.trim() || "(no matches)";
    } catch (err) {
      const e = err as { code?: number };
      if (e.code === 1) return "(no matches)";
      // Fallback: no ripgrep on the host. Use Node fs walking for **/*.ext patterns.
      return fallbackGlob(ctx.workDir, args.pattern);
    }
  },
});

async function fallbackGlob(root: string, pattern: string): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const results: string[] = [];
  const m = pattern.match(/\*\*\/\*\.(\w+)$/);
  const ext = m ? `.${m[1]}` : null;

  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(`${dir}/${e.name}`, p);
      else if (!ext || p.endsWith(ext)) results.push(p);
    }
  }
  await walk(root, "");
  return results.length ? results.join("\n") : "(no matches)";
}

export const grepTool = defineTool({
  name: "grep",
  description: "Search file contents with a regex (ripgrep). Returns matching lines with file:line.",
  schema: z.object({
    pattern: z.string(),
    glob: z.string().optional(),
    maxResults: z.number().int().positive().max(200).default(50),
  }),
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      glob: { type: "string", description: "File filter, e.g. *.ts" },
      maxResults: { type: "integer", default: 50 },
    },
    required: ["pattern"],
  },
  async execute(args, ctx) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const rgArgs = ["-n", "--max-count", String(args.maxResults)];
    if (args.glob) rgArgs.push("--glob", args.glob);
    rgArgs.push("--", args.pattern);
    try {
      const { stdout } = await run("rg", rgArgs, { cwd: ctx.workDir, maxBuffer: 8 * 1024 * 1024 });
      return stdout.trim() || "(no matches)";
    } catch (err) {
      const e = err as { code?: number };
      if (e.code === 1) return "(no matches)";
      // Fallback: no ripgrep on the host. Walk text files with Node.
      return fallbackGrep(ctx.workDir, args.pattern, args.maxResults ?? 50);
    }
  },
});

async function fallbackGrep(root: string, pattern: string, max: number): Promise<string> {
  const { readdir, readFile } = await import("node:fs/promises");
  const re = new RegExp(pattern);
  const hits: string[] = [];

  async function walk(dir: string, rel: string): Promise<void> {
    if (hits.length >= max) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (hits.length >= max) return;
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(`${dir}/${e.name}`, p);
      } else {
        const text = await readFile(`${dir}/${e.name}`, "utf8").catch(() => null);
        if (text == null || text.includes("\0")) continue; // skip binary/unreadable
        text.split("\n").forEach((line, i) => {
          if (hits.length < max && re.test(line)) hits.push(`${p}:${i + 1}:${line}`);
        });
      }
    }
  }
  await walk(root, "");
  return hits.length ? hits.join("\n") : "(no matches)";
}
