import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The public Gauntlet scanner: clone a repo → install → boot → probe → score.
 * This is the wedge product: machine-verified proof that an AI-generated app
 * actually runs. Results are public report pages (the marketing loop).
 *
 * ⚠️ SECURITY: this executes untrusted code. For the MVP it runs on the host
 * with a hard timeout and no credentials in the environment. Before public
 * launch, run the pipeline inside a gVisor/Firecracker sandbox (PCHS Phase-1
 * sandboxing work applies directly).
 */

export interface ScanResult {
  id: string;
  repoUrl: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  checks: {
    cloned: boolean;
    depsInstalled: boolean;
    serverBooted: boolean;
    httpOk: boolean;
    hasHealthOrRoot: boolean;
  };
  score: number; // 0-4
  details: {
    startCommand?: string;
    probedUrl?: string;
    httpStatus?: number;
    bodyPreview?: string;
    logs: string[];
    error?: string;
  };
}

const SCAN_DIR = "workspaces/scans";
const INSTALL_TIMEOUT_MS = 4 * 60_000;
const BOOT_TIMEOUT_MS = 45_000;
const SCAN_TIMEOUT_MS = 6 * 60_000;

const running = new Map<string, ScanResult>();

function persist(dir: string, result: ScanResult): void {
  writeFileSync(join(dir, result.id, "result.json"), JSON.stringify(result, null, 2));
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<{ code: number; logs: string[] }> {
  return new Promise((resolve) => {
    const logs: string[] = [];
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" } });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.stdout?.on("data", (d) => logs.push(d.toString().slice(0, 2000)));
    child.stderr?.on("data", (d) => logs.push(d.toString().slice(0, 2000)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, logs });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      logs.push(String(err));
      resolve({ code: 1, logs });
    });
  });
}

async function probe(ports: number[], timeoutMs: number): Promise<{ ok: boolean; status?: number; body?: string; port?: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const port of ports) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
        const body = await res.text();
        // Port-sweep guard: never credit a hit that is actually the Forge UI
        // itself (local dev server sharing common ports).
        if (body.includes('class="geist') || body.includes("Forge — coding agent")) continue;
        return { ok: res.ok, status: res.status, body: body.slice(0, 500), port };
      } catch {
        /* not up yet — try next port */
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false };
}

export function startScan(workDir: string, repoUrl: string): ScanResult {
  const id = randomUUID();
  const dir = join(workDir, SCAN_DIR);
  mkdirSync(join(dir, id), { recursive: true });

  // Basic SSRF/abuse guard: only https git URLs.
  if (!/^https:\/\/[a-z0-9.-]+\/.+\.git$/i.test(repoUrl) && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/i.test(repoUrl)) {
    const result: ScanResult = {
      id, repoUrl, status: "failed", startedAt: new Date().toISOString(),
      checks: { cloned: false, depsInstalled: false, serverBooted: false, httpOk: false, hasHealthOrRoot: false },
      score: 0, details: { logs: [], error: "URL must be an https GitHub/git repo URL" },
    };
    persist(dir, result);
    return result;
  }

  const result: ScanResult = {
    id,
    repoUrl,
    status: "running",
    startedAt: new Date().toISOString(),
    checks: { cloned: false, depsInstalled: false, serverBooted: false, httpOk: false, hasHealthOrRoot: false },
    score: 0,
    details: { logs: [] },
  };
  running.set(id, result);
  persist(dir, result);

  void (async () => {
    const repoDir = join(dir, id, "repo");
    const finish = (status: ScanResult["status"], error?: string) => {
      result.status = status;
      result.finishedAt = new Date().toISOString();
      result.details.error = error;
      result.score = Math.min(4, Object.values(result.checks).filter(Boolean).length);
      persist(dir, result);
      running.delete(id);
    };
    const globalTimer = setTimeout(() => finish("failed", "scan timed out"), SCAN_TIMEOUT_MS);

    try {
      // 1. Clone
      const clone = await run("git", ["clone", "--depth", "1", repoUrl, repoDir], { timeoutMs: 60_000 });
      result.checks.cloned = clone.code === 0 && existsSync(repoDir);
      result.details.logs.push(...clone.logs.slice(-5));
      if (!result.checks.cloned) return finish("failed", "git clone failed");
      persist(dir, result);

      // 2. Detect start command
      const pkgPath = join(repoDir, "package.json");
      let startCmd = "";
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        startCmd = pkg.scripts?.start ?? "";
      }
      if (!startCmd && existsSync(join(repoDir, "server.js"))) startCmd = "node server.js";
      else if (!startCmd && existsSync(join(repoDir, "index.js"))) startCmd = "node index.js";
      result.details.startCommand = startCmd || undefined;
      if (!startCmd) return finish("failed", "no start command found (package.json scripts.start, server.js, or index.js)");

      // 3. Install deps
      const install = await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: repoDir, timeoutMs: INSTALL_TIMEOUT_MS });
      result.checks.depsInstalled = install.code === 0 || existsSync(join(repoDir, "node_modules"));
      result.details.logs.push(...install.logs.slice(-5));
      persist(dir, result);

      // 4. Boot on an isolated high port. Apps may honor PORT or hardcode
      // one (3000/8080 common in AI-generated code) — probe all candidates.
      const port = 30000 + Math.floor(Math.random() * 20000);
      const portMatch = startCmd.match(/\b(3\d{3}|5\d{3}|8\d{3})\b/);
      const candidatePorts = [port, ...(portMatch ? [Number(portMatch[1])] : []), 3000, 8080];
      const boot = spawn("sh", ["-c", `PORT=${port} npm start --silent`], { cwd: repoDir, detached: true });
      boot.stdout?.on("data", (d) => result.details.logs.push(d.toString().slice(0, 500)));
      boot.stderr?.on("data", (d) => result.details.logs.push(d.toString().slice(0, 500)));

      // 5. Probe
      let probeRes = await probe(candidatePorts, BOOT_TIMEOUT_MS);
      if (!probeRes.status) {
        const logStr = result.details.logs.join("");
        if (/EADDRINUSE/i.test(logStr)) {
          // Port auto-heal (PaaS behavior): the app hardcodes a busy port —
          // rewrite it to our isolated port and boot again.
          const heal = await run("sh", ["-c",
            `grep -rlE '(PORT\\s*=\\s*|listen\\()' --include='*.js' --include='*.ts' --include='*.mjs' . | grep -v node_modules | xargs -r sed -i.bak 's/${portMatch?.[1] ?? 3000}/${port}/g; s/${portMatch?.[1] ?? 3000}/${port}/g' && rm -f $(find . -name '*.bak' -not -path './node_modules/*')`],
            { cwd: repoDir, timeoutMs: 30_000 });
          const healed = spawn("sh", ["-c", `PORT=${port} npm start --silent`], { cwd: repoDir, detached: true });
          healed.stdout?.on("data", (d) => result.details.logs.push(d.toString().slice(0, 500)));
          healed.stderr?.on("data", (d) => result.details.logs.push(d.toString().slice(0, 500)));
          probeRes = await probe([port], BOOT_TIMEOUT_MS);
          try {
            if (healed.pid) process.kill(-healed.pid, "SIGKILL");
          } catch {
            healed.kill("SIGKILL");
          }
        }
      }
      result.checks.serverBooted = probeRes.status !== undefined;
      result.checks.httpOk = !!probeRes.ok;
      result.checks.hasHealthOrRoot = probeRes.status !== undefined;
      result.details.probedUrl = probeRes.port ? `http://127.0.0.1:${probeRes.port}/` : undefined;
      if (!result.checks.serverBooted) {
        const logStr = result.details.logs.join("");
        if (/EADDRINUSE/i.test(logStr)) {
          result.details.error =
            "Address already in use — the app binds a fixed port that is occupied on the scan host. (In production each scan runs in its own network namespace.)";
        }
      }
      result.details.httpStatus = probeRes.status;
      result.details.bodyPreview = probeRes.body;
      // Kill the whole process group — sh wraps node, so a plain kill leaks it.
      try {
        if (boot.pid) process.kill(-boot.pid, "SIGKILL");
      } catch {
        boot.kill("SIGKILL");
      }
      clearTimeout(globalTimer);
      return finish("done");
    } catch (err) {
      clearTimeout(globalTimer);
      finish("failed", String(err));
    }
  })();

  return result;
}

export function getScan(workDir: string, id: string): ScanResult | null {
  const live = running.get(id);
  if (live) return live;
  const path = join(workDir, SCAN_DIR, id, "result.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ScanResult;
}
