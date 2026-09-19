# Forge

A production-grade full-stack coding agent you own and deploy yourself.

Forge pairs a **durable agent harness** (event-sourced state, crash-resumable sessions,
policy-gated tools, human-in-the-loop approvals) with **infrastructure-agnostic
deployment** (your own Ubuntu server over SSH, or Akash decentralized cloud) —
the deployment doctrine of the FullStackDeploymentHandbook encoded as agent tools.

## Architecture

```
src/
├── harness/          The spine
│   ├── loop.ts       Durable loop: load state → hydrate → LLM → policy → execute → checkpoint
│   ├── checkpoint.ts Append-only event log + state snapshots (file-backed, replayable)
│   ├── context.ts    Progressive summarization — long sessions never blow the context window
│   ├── policy.ts     Safe/dangerous tool gates + shell red-flag hard-blocks
│   ├── bus.ts        Event bus: harness ↔ CLI/WebSocket UI, approval suspend/resume
│   ├── llm.ts        OpenAI-compatible provider — any backend, model is config
│   ├── providers.ts  Multi-provider registry: env-configured aliases, runtime-resolvable
│   └── stats.ts      Per-session metrics: tool calls, approvals, errors, compaction
├── tools/            Schema-validated tools (fs, shell, git, deploy)
├── agents/           Agent definitions (system prompt + toolset + context docs)
├── skills/           Bundled SKILL.md files (deployment doctrine + roadmap)
├── infrastructure/   DeployTarget interface + VPS (SSH) + Akash (SDL) adapters
└── server/           Hono HTTP + WebSocket API + htmx UI (chat, tool cards, eval dashboard)
    └── views/         Tiny HTML template functions (escape, layout, messages, stats, eval)

evals/                Golden tasks + tool-call scorers (regression suite for the agent)
deploy/               Server bootstrap playbook (nginx, certbot, ufw, supervisor, fail2ban)
public/               Static assets served by the server (htmx.min.js, styles.css)
```

## Quick start

```bash
npm install
cp .env.example .env   # set FORGE_API_KEY + FORGE_MODEL (any OpenAI-compatible backend)

# Interactive CLI — sessions checkpoint to .forge/sessions/ and resume after crashes
npm run agent

# YOLO mode (auto-approve dangerous tools — use in sandboxes only)
npm run agent -- --yolo

# Resume a crashed session
npm run agent -- --session <session-id>

# HTTP + WebSocket server (remote sessions, approvals from a UI)
npm run dev
```

Open `http://127.0.0.1:8787/` for the demo UI — chat, tool cards, approve/deny
buttons, live SSE event stream, sessions sidebar, skills panel, eval dashboard.
See `docs/deployment-doctrine.md` (archived) for the deployment knowledge that's
loaded into the agent; the canonical version lives at `src/skills/deployment/SKILL.md`.

## Model policy

Forge is model-agnostic. Default config points at OpenRouter with an open-weight model
(`deepseek/deepseek-chat-v3-0324`). Set `FORGE_BASE_URL` + `FORGE_MODEL` for any
OpenAI-compatible host (Ollama, Together, vLLM, OpenAI). Prefer open-weight;
escalate only on verified capability gaps.

## Deploying with Forge

Ask the agent: *"Deploy this app to my server"* — the `deploy` tool (human-approved)
runs preflight → atomic ship → health-verify against any Ubuntu box over SSH, or
generates an Akash SDL + the exact CLI sequence for decentralized deploys.

New server? `deploy/bootstrap.sh` applies the handbook baseline: non-root user,
UFW, fail2ban, nginx, certbot, supervisor, swap.

## Evals

```bash
npm run eval     # golden tasks + ToolCallMatch scorers
npm test         # unit tests (policy, checkpoint, context)
npm run typecheck
```

Evals are the regression net: change the system prompt or a tool schema, run them,
know immediately if tool-calling behavior broke.

## Safety model

- Read-only tools run freely; write/dangerous tools require human approval (or `--yolo`).
- Shell red flags (`rm -rf`, fork bombs, curl|sh, force-push…) are **hard-blocked**
  even after approval.
- Paths are sandboxed to the working directory.
- Every action is an event in an append-only log — full audit trail per session.
