import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool, writeFileTool, listDirTool, globTool, grepTool } from "../tools/fs.js";
import { runBashTool } from "../tools/shell.js";
import type { ToolContext } from "./tools.js";

describe("fs tools", () => {
  let dir: string;
  let ctx: ToolContext;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-tools-"));
    ctx = { workDir: dir, session: {} };
    writeFileSync(join(dir, "a.txt"), "line1\nline2\nline3\n", "utf8");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads whole files and line ranges", async () => {
    expect(await readFileTool.execute({ path: "a.txt" }, ctx)).toContain("line3");
    expect(await readFileTool.execute({ path: "a.txt", startLine: 2, endLine: 2 }, ctx)).toBe("line2");
  });

  it("writes files and creates parents", async () => {
    const out = await writeFileTool.execute({ path: "sub/b.txt", content: "hello" }, ctx);
    expect(out).toContain("created");
    expect(readFileSync(join(dir, "sub/b.txt"), "utf8")).toBe("hello");
  });

  it("refuses path escapes", async () => {
    await expect(readFileTool.execute({ path: "../../etc/passwd" }, ctx)).rejects.toThrow(/escapes/);
    await expect(writeFileTool.execute({ path: "../evil.txt", content: "x" }, ctx)).rejects.toThrow(/escapes/);
  });

  it("lists directories", async () => {
    const out = await listDirTool.execute({ path: "." }, ctx);
    expect(out).toContain("f a.txt");
  });

  it("greps with regex", async () => {
    const out = await grepTool.execute({ pattern: "line[23]" }, ctx);
    expect(out).toContain("a.txt:2:line2");
    expect(out).toContain("a.txt:3:line3");
  });

  it("globs files", async () => {
    const out = await globTool.execute({ pattern: "**/*.txt" }, ctx);
    expect(out).toContain("a.txt");
  });
});

describe("run_bash tool", () => {
  it("runs commands and captures output", async () => {
    const ctx: ToolContext = { workDir: tmpdir(), session: {} };
    const out = await runBashTool.execute({ command: "echo hello-forge", timeoutSec: 10 }, ctx);
    expect(out).toContain("hello-forge");
  });

  it("hard-blocks red-flag commands", async () => {
    const ctx: ToolContext = { workDir: tmpdir(), session: {} };
    await expect(runBashTool.execute({ command: "rm -rf /", timeoutSec: 10 }, ctx)).rejects.toThrow(/refused/);
  });

  it("reports non-zero exits with output", async () => {
    const ctx: ToolContext = { workDir: tmpdir(), session: {} };
    const out = await runBashTool.execute({ command: "echo oops >&2; exit 3", timeoutSec: 10 }, ctx);
    expect(out).toContain("EXIT NON-ZERO");
    expect(out).toContain("oops");
  });
});
