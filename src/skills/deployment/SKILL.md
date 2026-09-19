---
name: deployment
description: Server hardening baseline, atomic-release deploy pattern, and the Lockdown Trap / 502 / Orphan Worker failure modes — distilled from the FullStackDeploymentHandbook course.
author: SylphAI
version: 1.0.0
---

# Deployment Doctrine — Agent Operating Knowledge

Distilled from the 10.5-hour course transcript. This document is injected into
Forge's system context (see `src/agents/fullstack.ts`) so the agent can guide
users through production deployments reproducibly.

## Core doctrine
1. **Manual before automatic.** Understand every step by hand first; only then script it.
2. **Verify every step.** Never chain commands blind on a first run — check output before continuing.
3. **Logs are truth.** `sudo journalctl -u <service> -f` and `tail -f /var/log/nginx/error.log` answer almost everything.
4. **Isolate services.** Databases/search run under restricted system users with `/bin/false` shells.
5. **Fail fast in CI.** Security scans (SCA/SAST) run BEFORE unit tests — no point linting insecure code.

## Ordered checklist (walk users through in this order)
1. Security handshake: SSH keys? Root login disabled? Password auth off?
2. Resource check: swap file present? (critical for low-RAM builds)
3. Environment isolation: venv created? node_modules excluded from rsync?
4. Proxy hookup: nginx → Unix socket (not a TCP port)?
5. Permission sync: `www-data` in the app group? Group `+x` on parent folders?
6. SSL lock: certbot renew cron + post-renewal nginx reload hook?
7. CI protection: branch protection on main requiring status checks?

## Live debugging gold (failure modes the instructor hits on camera)
- **The Lockdown Trap (1:07):** UFW enabled before allowing SSH → locked out.
  Fix: provider recovery console → `ufw allow OpenSSH`.
- **The 502 Bad Gateway (2:20):** nginx "permission denied" on the socket.
  Fix: `sudo usermod -aG <user> www-data` + `chmod g+x /web_app`.
- **The Orphan Worker (3:51):** stale Gunicorn processes eating RAM.
  Fix: `sudo pkill -f gunicorn`, let Supervisor restart cleanly.
- **The 404 Download Fail (7:46):** CI breaks when a tool releases mid-pipeline.
  Fix: pin versions or wrap downloads in retry loops.
- **Terminal Required (9:02):** sudo works interactively but fails in CI.
  Fix: the exact `which <command>` path must be in the sudoers file.

## Critical red flags (agent MUST warn)
- `'unsafe-inline'` in a production CSP — never. (9:24)
- Leaving `--import-dump` in a systemd unit permanently — Meilisearch will fatally crash on next reboot if the dump is deleted. (4:24)
- `rsync --delete` without an exclude file — will happily delete the live production database. (8:10)
- Passphrase on a CI/CD SSH key — the pipeline hangs forever waiting for input. (8:13)
