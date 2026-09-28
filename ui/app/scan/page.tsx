"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Public Gauntlet scanner — the wedge landing page.
 * "Paste your AI-built app. We tell you if it actually runs."
 */

interface ScanResult {
  id: string;
  repoUrl: string;
  status: "running" | "done" | "failed";
  score: number;
  checks: Record<string, boolean>;
  details: { startCommand?: string; httpStatus?: number; bodyPreview?: string; error?: string };
}

const CHECK_LABELS: Array<[string, string]> = [
  ["cloned", "Repo cloned"],
  ["depsInstalled", "Dependencies installed"],
  ["serverBooted", "Server booted"],
  ["httpOk", "HTTP responds"],
];

export default function ScanPage() {
  const [url, setUrl] = useState("");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const start = async () => {
    const repoUrl = url.trim();
    if (!repoUrl || busy) return;
    setBusy(true);
    setError(null);
    setScan(null);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_FORGE_API ?? "http://127.0.0.1:8787"}/scan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoUrl }),
      });
      if (!res.ok) throw new Error(`scan rejected (${res.status})`);
      const initial = (await res.json()) as ScanResult;
      setScan(initial);
      pollRef.current = setInterval(async () => {
        const r = await fetch(`${process.env.NEXT_PUBLIC_FORGE_API ?? "http://127.0.0.1:8787"}/scan/${initial.id}`);
        if (r.ok) {
          const s = (await r.json()) as ScanResult;
          setScan(s);
          if (s.status !== "running") stopPolling();
        }
      }, 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const verdict =
    scan?.status === "running"
      ? null
      : scan
        ? scan.score >= 3
          ? { text: `✅ VERIFIED — Gauntlet ${scan.score}/4`, color: "text-emerald-400" }
          : { text: `❌ FAILED — Gauntlet ${scan.score}/4`, color: "text-red-400" }
        : null;

  return (
    <div className="flex min-h-dvh flex-col items-center bg-zinc-950 px-4 py-16 text-zinc-100">
      <div className="w-full max-w-2xl">
        <p className="mb-2 text-sm font-semibold tracking-wide text-orange-400">⚒ FORGE</p>
        <h1 className="mb-3 text-3xl font-bold sm:text-4xl">
          Vibe code it anywhere.
          <br />
          <span className="text-orange-400">Ship it with receipts.</span>
        </h1>
        <p className="mb-8 text-zinc-400">
          Your AI builder made a demo. We prove it runs. Paste a GitHub repo of any AI-generated
          Node app — we clone it, boot it in an isolated sandbox, hit its endpoints, and give you a
          machine-verified Gauntlet score.
        </p>

        <div className="flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void start()}
            placeholder="https://github.com/you/your-ai-app"
            className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm outline-none placeholder:text-zinc-600 focus:border-orange-500/60"
          />
          <button
            onClick={() => void start()}
            disabled={busy || !url.trim()}
            className="rounded-xl bg-orange-500 px-5 py-3 text-sm font-medium text-white hover:bg-orange-400 disabled:opacity-40"
          >
            {busy ? "Starting…" : "Scan it"}
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

        {scan && (
          <div className="mt-8 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
            <p className="mb-1 truncate font-mono text-xs text-zinc-500">{scan.repoUrl}</p>
            <p className={`text-2xl font-bold ${verdict?.color ?? "text-yellow-400"}`}>
              {verdict?.text ?? "⏳ Scanning… (clone → install → boot → probe)"}
            </p>
            <table className="mt-4 w-full text-sm">
              <tbody>
                {CHECK_LABELS.map(([key, label]) => {
                  const state = scan.status === "running" ? null : scan.checks[key];
                  return (
                    <tr key={key} className="border-t border-zinc-800">
                      <td className="py-2.5">
                        {state === null ? "⏳" : state ? "✅" : "❌"} {label}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {scan.status === "done" && (
              <a
                href={`${process.env.NEXT_PUBLIC_FORGE_API ?? "http://127.0.0.1:8787"}/scan/${scan.id}/report`}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-block text-sm text-orange-400 underline"
              >
                Shareable report →
              </a>
            )}
            {scan.details?.error && <p className="mt-4 text-xs text-red-400">{scan.details.error}</p>}
            {scan.details?.bodyPreview && (
              <pre className="mt-4 max-h-40 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-500">
                {scan.details.bodyPreview}
              </pre>
            )}
          </div>
        )}

        <p className="mt-12 text-xs text-zinc-600">
          How it works: clone → dependency install → sandboxed boot on an isolated port → HTTP
          probe → public report. Node apps with a start script today; more runtimes on the way.
        </p>
      </div>
    </div>
  );
}
