# Deployment Roadmap — "What Do I Do Next?"

Distilled from the 10.5-hour FullStackDeploymentHandbook course transcript (4,738 segments)
and the handbook's 8 chapters. Each stage lists: goal → exact commands → "you are here if…"
signals → next step. Use it as a companion at any point in a build.

---
## Stage 1: Foundation & Secure Access
**Transcript:** 0:00 – 1:05:00 · **Handbook:** 01_foundation
**Goal:** Provision a VPS and establish a secure, non-root entry point.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/<key_name>
ssh -i ~/.ssh/<key_name> root@<ip>
adduser <username> && usermod -aG sudo <username>
cp -r --preserve=mode /root/.ssh /home/<username>/
# /etc/ssh/sshd_config: PermitRootLogin no, PasswordAuthentication no
sudo systemctl restart ssh
```

**You are here if…** you have a fresh server IP and can only log in as root.
**Next step:** Lock the windows → Stage 2.

---
## Stage 2: The Firewall Strategy
**Transcript:** 1:05:00 – 1:30:00 · **Handbook:** 01_foundation
**Goal:** Block all traffic except essential services.

```bash
sudo ufw allow OpenSSH
sudo ufw enable
sudo apt install fail2ban -y
# /etc/fail2ban/jail.local: bantime = 1d
```

**You are here if…** `sudo ufw status` says "inactive" (⚠️ allow OpenSSH BEFORE enabling — see Doctrine, "The Lockdown Trap").
**Next step:** Install runtimes → Stage 3.

---
## Stage 3: Runtime & Manual App Deploy
**Transcript:** 1:30:00 – 3:00:00 · **Handbook:** 02_application-runtime
**Goal:** Prepare the environment and verify the app runs manually (manual first, automate second).

```bash
sudo apt install python3-pip python3-venv python3-dev -y
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
sudo fallocate -l 2G /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt
pnpm run build
```

**You are here if…** the app runs locally but the server has no runtimes yet.
**Verify:** app starts with `uvicorn main:app`, reachable via `ssh -L 8080:localhost:8080`.
**Next step:** Keep it alive → Stage 4.

---
## Stage 4: Process Management (Gunicorn & Supervisor)
**Transcript:** 3:00:00 – 4:15:00 · **Handbook:** 02_application-runtime
**Goal:** Backend stays alive, restarts on crash, talks to nginx over a Unix socket.

```bash
# gunicorn_start script: exec venv/bin/gunicorn ... --bind unix:backend/gunicorn.sock
sudo apt install supervisor -y
sudo supervisorctl reread && sudo supervisorctl update
sudo supervisorctl status <app_name>
```

**You are here if…** the app dies when your SSH session closes.
**Verify:** `ls -l backend/gunicorn.sock` shows a socket file (starts with `s`).
**Next step:** Search/data services → Stage 5.

---
## Stage 5: Search & Data (Meilisearch)
**Transcript:** 4:15:00 – 4:25:00 · **Handbook:** 03_data-and-search
**Goal:** Self-hosted search under an isolated system user.

```bash
curl -L https://install.meilisearch.com | sh
sudo useradd -d /var/lib/meilisearch -s /bin/false -m -r meilisearch
sudo systemctl enable meilisearch
```

**You are here if…** the app needs search and you don't want a managed bill.
**Verify:** `curl http://127.0.0.1:7700/health` → "available".
**Next step:** Domain + HTTPS → Stage 6.

---
## Stage 6: DNS, TLS & Edge (Certbot & Cloudflare)
**Transcript:** 4:26:11 – 5:26:00 · **Handbook:** 04_global-delivery-security
**Goal:** Connect the domain, enable HTTPS, put Cloudflare in front.

```bash
# DNS: A record → server IP, CNAME www → apex
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d domain.com -d www.domain.com
# cron: 0 0 * * 0 certbot renew --quiet
# nginx (behind Cloudflare): real_ip_header CF-Connecting-IP;
```

**You are here if…** the site is only reachable by raw IP over HTTP.
**Verify:** padlock in the browser on your domain.
**Next step:** Automate everything → Stage 7.

---
## Stage 7: Automation & Delivery (GitHub Actions)
**Transcript:** 5:26:00 – 9:09:00 · **Handbook:** 05_automation-pipeline
**Goal:** Fully automated test-and-deploy pipeline.

```bash
pre-commit install
# workflow: security scans (SCA/SAST) FIRST, then tests, then build, then deploy
rsync -avzr --delete --exclude-from='rsync_exclude.txt' ...
# workflow_dispatch: manual deploy trigger
```

**You are here if…** every deploy is still a manual SSH session.
**Verify:** push triggers a green pipeline; "Run workflow" deploys to live.
**Next step:** Watch it → Stage 8.

---
## Stage 8: Observability & Maintenance
**Transcript:** 9:09:00 – 10:29:01 · **Handbook:** 06_optimization-maintenance
**Goal:** Real-time visibility, log hygiene, disk cleanup.

```bash
sudo apt install goaccess btop ncdu -y
sudo ufw deny from <malicious_ip> to any
journalctl --vacuum-time=2d
# backup rotation: ls -tp backups/ | tail -n +6 | xargs rm -f
```

**You are here if…** the site is live but you have no idea what it's doing.
**Verify:** `btop` shows healthy RAM; GoAccess shows real visitor counts.

---
*Source: FullStackDeploymentHandbook course transcript + handbook chapters. Distilled with AdaL.*
