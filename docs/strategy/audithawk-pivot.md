# AuditHawk — Smart-Contract Audit Bounty Agent (PCHS × Forge branch)

**Date:** 2026-09-28 · **Status:** pivot plan (Ideabrowser quota exhausted — revalidate next cycle)
**Assets:** `Zaevlad/audit-findings-dataset` (HF) · `ml-intern` architecture (HF, archived) · Forge harness (built)

---

## 1. The idea in one sentence

An agent you point at an audit opportunity (Immunefi bounty, Code4rena/Sherlock/Cantina/Hacken contest) that works it end-to-end: ingests scope and docs → runs static analysis → does LLM deep review **grounded in a fine-tuned/RAG knowledge base of thousands of real audit findings** → develops and **executes Foundry PoCs** to prove each finding → drafts the submission package in platform format.

## 2. Why the resources fit

| Resource | What it gives us |
|---|---|
| `audit-findings-dataset` (HF) | Thousands of real findings: description, PoC (solidity/forge-std), recommended fix, severity, quality score. → SFT dataset (context → finding+PoC+severity) or RAG corpus for grounded review. Entries include contest-tagged chunks (e.g. `2023-05-maia_H-04`) — perfect for per-contest retrieval. |
| `ml-intern` architecture (HF, archived) | Blueprint for the agent loop: tool router, doom-loop detector, approval gates, LiteLLM multi-provider (open-weight Kimi/GLM/DeepSeek + local Ollama/vLLM), MCP servers, trace uploads. All of this maps onto Forge's existing harness (loop.ts, bus, approvals, stats). |
| Forge harness | Durable sessions, per-workspace isolation, approval flow (UI + Telegram), token accounting, multi-provider cheap LLMs. The audit agent is a new *agent definition* + tools, not a new platform. |

## 3. Architecture (Forge-native)

```
bounty URL (Immunefi/C4/Sherlock/Hacken)
   ↓  [browser tool: scope + rules + repo + docs ingest]
workspace: clone target repo
   ↓  [tool: slither + aderyn static pass → candidate list]
   ↓  [LLM deep review, RAG-grounded on findings dataset
       (retrieve by pattern: reentrancy/fee-accounting/erc20-oddities/
        cross-chain gas accounting — the dataset's strongest categories)]
   ↓  [tool: foundry test scaffold → agent writes PoC → forge test runs
       → PoC passes? severity confirmed]
   ↓  [doom-loop guard: max N hypotheses, drop stale ones]
   ↓  [draft report: title, severity, impact, PoC, mitigation — platform format]
   ↓  human review (Telegram approval) → submit
```

New Forge tools needed: `slither_scan`, `aderyn_scan`, `forge_test`, `fetch_bounty` (browser), `rag_search_findings`. The rest exists.

## 4. Dual use — income first, product second

**Phase 1 (income, weeks 1–8): your own bounty machine.**
- Start with **Code4rena/Sherlock/Cantina contests** (public repos, fixed windows, $10k–100k+ pots) — lower legal friction than Immunefi live bounties.
- Target: 1 contest/week, agent does first-pass, **you do the final judgment** (this is how you also become the expert — review every finding before submission).
- RAG quality bar: retrieve top-k similar findings per candidate pattern; reject findings below the dataset's quality-score median (the dataset literally ships a quality score — use it as a filter).

**Phase 2 (product, month 3+): pre-audit SaaS.**
- "Get a machine-audit with executed PoCs before your human audit" for protocols — same pipeline, opposite customer.
- Pricing anchored to the audit market: pre-audit scans $2–10k (vs $50–200k human audits), or per-finding-verified.
- The dataset fine-tune becomes the moat: every contest you run adds verified findings + PoCs to your private corpus.

## 5. ML plan (concrete)

1. **Baseline (week 1):** RAG — chunk dataset entries (description + PoC + fix + severity), embed with an open-weight embedder, retrieve per code pattern. Cheap, works day one.
2. **SFT (weeks 2–6):** fine-tune an open-weight coder (Qwen2.5-Coder-32B or GLM) on (contract-context → finding + severity + PoC + fix). The dataset's quality scores let you train on the top half only.
3. **Eval harness:** hold out entire contests; score = findings rediscovered @ severity match + PoC validity (forge test passes). This is your benchmark before spending on contests.
4. **Cost control:** static analysis (Slither/Aderyn, free) pre-filters; the LLM only deep-reviews flagged surfaces. Open-weight models via the existing multi-provider routing.

## 6. Honest risks

- **PoC validity is the whole game** — a finding without an executed PoC is noise in contests. The `forge_test` tool + "PoC must pass" gate is non-negotiable.
- **Contest platforms' AI policies** — check each platform's rules on AI-assisted submissions (Sherlock/C4 have terms; Immunefi is more permissive for bugs). Read before submitting.
- **Dataset license** — check the HF dataset license before fine-tuning a commercial product on it (fine for personal use).
- **Competition is real** — this is a known idea; your edge is the executed-PoC pipeline + the growing private corpus, not the concept.

## 7. First week checklist

- [ ] Download dataset, build the RAG index + quality-score filter
- [ ] Add `slither_scan` / `forge_test` tools to Forge (foundry in Docker)
- [ ] Pick one live C4/Sherlock contest, run the agent as first-pass analyst
- [ ] You review + submit; log results → first corpus entry
- [ ] Re-run Ideabrowser validation when quota resets (market insight: "AI audit agents / bug bounty automation")
