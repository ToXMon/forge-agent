# The Forge Gauntlet — how to know this is a good coding agent

**TL;DR:** A good coding agent isn't judged by how confident it sounds — it's judged by
**artifacts that exist** and **a closed verification loop**. The Gauntlet is a task suite
where scoring is mechanical: files on disk, an HTTP server that responds, and an app that
boots in a real browser. No self-reported success counts.

**Date:** 2026-09-27 · **Owner:** @ToXMon · **Status:** live in the product

## The test (Tier 1 — artifacts + self-verification)

Send the agent this task (adapt the app; keep the constraints):

> In the current directory, create a small web app: `package.json` with a `start`
> script, `server.js` serving `GET /health` → `{"ok":true}` and `GET /` → an HTML
> page, and a `README.md`. Start it, verify `GET /health` returns 200 with curl,
> then stop the server and finish.

**Pass criteria (checked externally, not by the agent):**

| # | Criterion | How to check |
|---|-----------|--------------|
| 1 | Artifacts exist in the session workspace | `GET /sessions/:id/files` lists them |
| 2 | Files are coherent (valid JSON/JS) | `GET /sessions/:id/files/package.json` parses |
| 3 | The app boots and serves traffic | agent ran it (tool_result ok) — or Tier 2 |
| 4 | Token cost within budget | `/sessions/:id/stats` → `tokens.totalTokens` |

Score = pass criteria met / tokens spent. That ratio is the number that matters,
and it's what a future Pi/Codex/AdaL comparison should measure.

## Tier 2 — in-browser verification (BrowserPod)

Click **▶ verify in browser** in the Forge UI sidebar:

1. The UI boots a [BrowserPod](https://browserpod.io) pod in *your* browser
   (Wasm Node.js sandbox — requires `BROWSERPOD_API_KEY` on the server).
2. Every workspace file is copied into the pod (`createFile`).
3. The app is started via its `package.json` `start` script inside the pod.
4. When the app listens, BrowserPod mints a **portal URL** — a public link to the
   app running in your browser tab. Console output is captured and posted back
   into the session as a message.

This is the PCHS thesis in miniature: the agent's code must *run in a real
browser*, verified independently of the agent's own claims.

## Notes

- Per-session workspaces live in `workspaces/<sessionId>/` and are isolated —
  one session's agent cannot see another's files.
- `write_file` and `run_bash` are approval-gated; the UI and Telegram both
  surface approve/deny inline.
- Future tiers: deploy the artifact to Akash (agent has the `deploy` tool) and
  verify the public URL — the full PCHS pipeline.
