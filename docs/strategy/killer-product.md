# PCHS × Forge — "Ship With Receipts" Product Strategy

**Date:** 2026-09-28 · **Researched via Ideabrowser MCP** (market insight `bc878cdf`, trend `2a64ca24`, idea brief `245cfc82`, deep research in flight)
**Project:** https://www.ideabrowser.com/hub/build/p/pchs-x-forge-provably-correct-vibe-hosting-n8nwif

---

## 1. The validated wedge (what the research says)

**Pain (9/10 intensity, verified community quotes):** "Once you create your web app, you're left to manage hosting, payments, domain registration… on your own" (r/vibecoding, 300K members). AI builders make demos, not products. The prototype→production gap is the single most intense pain in the space.

**Money signals (direct WTP evidence):**
- $20–30/mo is the accepted builder price ceiling (Lovable $25, Bolt/v0 $30, Replit $18–25)
- **$500–1,000 upfront** for done-for-you "build + host + maintain" services
- $20–30/mo ongoing for hosting + minor adjustments
- Production stacks already cost founders $50–700/mo stitched together

**Demand (search):** "vibe coding" 550K searches/mo; "Lovable alternative" 5.4K/mo at **$5.19 CPC** (buying intent); "no code ai app builder" 1.9K/mo at **LOW competition**. Niche keywords, not head terms, are the affordable acquisition channel.

**Underserved segment:** solo non-technical founders who *already generated* an AI prototype (Lovable/Bolt/v0 users) and are stuck at deployment. Citizen developers outnumber pro devs ~4:1. SMB slice of the AI app-builder market ≈ $1.21B (2025).

**The gap nobody fills:** every competitor optimizes *generation*. Nobody owns *verification*. Our thesis is the only one where "it works" is a machine-checked fact with receipts, not a demo on someone else's domain.

## 2. Positioning

> **"Vibe code it anywhere. Ship it with receipts."**
> PCHS takes the app your AI builder made — or builds it for you — verifies it actually runs (machine-checked, in a sandbox, before your money is spent), then hosts it on decentralized cloud for $2–5/mo. If the Gauntlet doesn't pass, you don't pay.

- **Category:** verification-first hosting. Not another builder. The layer *under* every builder.
- **Enemy:** "demo-ware" — Lovable/Bolt/v0 apps that die in the tab they were born in.
- **Proof asset:** the **Gauntlet Score** (artifacts ✓ · boots ✓ · endpoints ✓ · cost $) attached to every deployment — public, auditable, shareable. This is the moat: a growing corpus of verified deployments + the verification pipeline itself (BrowserPod-in-browser → headless harness → Akash smoke tests).

## 3. Product shape (what's built vs. what's next)

| Layer | Status | Build next |
|---|---|---|
| Durable agent (Forge harness, approvals, cheap open-weight LLMs) | ✅ built | Template skills: "SaaS starter", "Landing page", "Dashboard" |
| Per-session workspaces + artifacts | ✅ built | Import from GitHub/Lovable export |
| Verification: endpoints + in-browser BrowserPod portal | ✅ built, Gauntlet defined | Headless Tier-2 (playwright + screenshot as *evidence artifact*), auto-Gauntlet badge |
| Hosting: Akash SDL + cheapest-bid deploy + TLS | ✅ scripted | One-click from UI, custom domains, uptime monitor w/ auto-redeploy |
| Auth + trial credits + multi-provider LLM keys | ✅ built | Stripe billing wired to credit packs |
| Channels: web UI + Telegram approvals | ✅ built | Email digest of nightly Gauntlet runs |

## 4. Pricing (anchored to the research, not invented)

- **Free:** 50K agent tokens, verification sandbox, *.host-domain. (Trial credits already built.)
- **Ship $29/mo:** 500K tokens, custom domain, Akash hosting included, nightly re-verification.
- **Founder $99/mo:** unlimited-ish tokens (fair use), Stripe/payment template, staging + prod, Telegram ops bot.
- **Done-for-you $990 one-off** (+ $49/mo): we take your Lovable/Bolt export → verify → deploy → maintain. The research shows this exact price point already converts.
- Cost floor: open-weight models on Venice/Surplus/AkashML (~$0.50–2 per app build) + Akash compute ($1–5/mo) → 70–85% gross margin at $29.

## 5. Go-to-market (channels the insight surfaced, ranked)

1. **The "Lovable refugee" play:** free tool — "paste your Lovable/Bolt project, we tell you if it actually works" (Tier-1 Gauntlet as a free scanner). SEO + r/lovable + r/vibecoding + "Lovable alternative" keywords. This converts the exact 9/10-pain moment.
2. **Public Gauntlet badges:** every deployed app gets a shareable "Verified · Gauntlet 4/4 · uptime" page — free viral loop, each badge links back.
3. **Community-led:** r/vibecoding (300K), Vibe Coding Discord (8.7K, relevance 10), Indie Hackers (50K) — post verified-build teardowns, not ads.
4. **Agency channel:** the research shows agencies charging $500–1K per Lovable deployment; white-label PCHS to them at volume pricing.
5. **Akash ecosystem:** co-marketing with Akash (they need consumer-facing apps burning AKT demand) — grant/tribe program.

## 6. First 90 days

| Week | Milestone |
|---|---|
| 1–2 | Free Gauntlet scanner (paste GitHub URL → report page). Landing page on "Lovable alternative" + "verify AI app" keywords. |
| 3–6 | One-click Akash deploy from UI; 3 starter templates; Stripe billing on credit packs. |
| 7–10 | 20 verified deployments live; publish badge pages; 3 case studies ("founder shipped for $3/mo with receipts"). |
| 11–13 | Done-for-you tier launch ($990); agency pilot with 2 design shops; weekly build-in-public posts. |

**Success metric to obsess over:** time-to-verified-deployment (target < 15 min) and Gauntlet pass rate (target > 90% after 2 agent retries). If pass rate < 90%, the verification layer is the product story that still closes — "we show you it's broken before your customers do."

---
*Saved to Ideabrowser project `cadf06b0` alongside attached trend + market insight. Deep research report will land at the idea URL when complete (~25 min).*
