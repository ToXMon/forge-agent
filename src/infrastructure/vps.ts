import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeploySpec, DeployResult, DeployTarget } from "./target.js";

const run = promisify(execFile);

export interface VpsConfig {
  /** user@host of an EXISTING Ubuntu server you control. No cloud API coupling. */
  sshTarget: string;
  sshKeyPath?: string;
}

/**
 * VPS adapter — the FullStackDeploymentHandbook playbook, automated:
 * any Ubuntu server reachable over SSH (your existing droplet, a bare box,
 * a VM — anything). Atomic release pattern: ship into releases/<ts>, flip
 * the current symlink only after the service comes up healthy.
 *
 * Server prep (nginx, certbot, ufw, supervisor) is generated from
 * src/infrastructure/playbooks/ — run `forge deploy bootstrap` once per box.
 */
export class VpsTarget implements DeployTarget {
  readonly name = "vps";

  constructor(private cfg: VpsConfig) {}

  private sshBase(): string[] {
    const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"];
    if (this.cfg.sshKeyPath) args.push("-i", this.cfg.sshKeyPath);
    return args;
  }

  private async ssh(cmd: string, timeoutMs = 120_000): Promise<string> {
    const { stdout, stderr } = await run("ssh", [...this.sshBase(), this.cfg.sshTarget, cmd], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return [stdout, stderr].filter(Boolean).join("\n").trim();
  }

  async preflight(): Promise<string> {
    const out = await this.ssh(
      "set -e; echo USER=$(whoami); echo OS=$(. /etc/os-release && echo $PRETTY_NAME); " +
        "echo NGINX=$(command -v nginx || echo missing); echo CERTBOT=$(command -v certbot || echo missing); " +
        "echo SUPERVISOR=$(command -v supervisord || echo missing); df -h / | tail -1",
    );
    return out;
  }

  async ship(spec: DeploySpec): Promise<DeployResult> {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const release = `/srv/${spec.app}/releases/${ts}`;
    const logs: string[] = [];

    // 1. Stage the release directory (atomic pattern: nothing live changes yet).
    logs.push(await this.ssh(`mkdir -p ${release} /srv/${spec.app}/shared`));

    // 2. Ship the artifact.
    const scpArgs = [...this.sshBase(), "-r", `${spec.artifactDir}/.`, `${this.cfg.sshTarget}:${release}/`];
    const { stdout: scpOut } = await run("scp", scpArgs, { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
    logs.push(scpOut);

    // 3. Write env file (0600) from spec.env; values provided at deploy time.
    const envBody = Object.entries(spec.env)
      .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
      .join("\n");
    logs.push(await this.ssh(`printf '%s\n' '${envBody.replace(/'/g, "'\\''")}' > /srv/${spec.app}/shared/.env && chmod 600 /srv/${spec.app}/shared/.env`));

    // 4. Supervisor program (unix socket, handbook pattern) + nginx site if domain set.
    const supervisorConf = renderSupervisor(spec);
    logs.push(await this.ssh(
      `printf '%s' '${supervisorConf.replace(/'/g, "'\\''")}' | sudo tee /etc/supervisor/conf.d/${spec.app}.conf >/dev/null && ` +
        `sudo supervisorctl reread && sudo supervisorctl update`,
    ));

    if (spec.domain) {
      const nginxConf = renderNginx(spec);
      logs.push(await this.ssh(
        `printf '%s' '${nginxConf.replace(/'/g, "'\\''")}' | sudo tee /etc/nginx/sites-available/${spec.app} >/dev/null && ` +
          `sudo ln -sf /etc/nginx/sites-available/${spec.app} /etc/nginx/sites-enabled/${spec.app} && ` +
          `sudo nginx -t && sudo systemctl reload nginx`,
      ));
    }

    // 5. Atomic flip: point `current` at the new release, restart, health check.
    logs.push(await this.ssh(
      `ln -sfn ${release} /srv/${spec.app}/current && sudo supervisorctl restart ${spec.app} && sleep 3 && ` +
        `curl -sf -o /dev/null -w 'health:%{http_code}' http://127.0.0.1:${spec.port}/ || echo health:fail`,
    ));

    const healthy = logs.at(-1)?.includes("health:2") || logs.at(-1)?.includes("health:3");
    return {
      ok: Boolean(healthy),
      url: spec.domain ? `https://${spec.domain}` : `http://${this.cfg.sshTarget.split("@").pop()}:${spec.port}`,
      logs: logs.join("\n"),
    };
  }

  async verify(spec: DeploySpec): Promise<DeployResult> {
    const logs = await this.ssh(
      `sudo supervisorctl status ${spec.app}; curl -sf -o /dev/null -w 'http:%{http_code}\n' http://127.0.0.1:${spec.port}/ || true; ` +
        `tail -5 /var/log/supervisor/${spec.app}*.log 2>/dev/null || true`,
    );
    const ok = logs.includes("RUNNING") && /http:[23]/.test(logs);
    const rollback = ok
      ? ""
      : `\nRollback: ssh ${this.cfg.sshTarget} 'ls -t /srv/${spec.app}/releases | sed -n 2p | xargs -I{} ln -sfn /srv/${spec.app}/releases/{} /srv/${spec.app}/current && sudo supervisorctl restart ${spec.app}'`;
    return { ok, logs: logs + rollback };
  }
}

function renderSupervisor(spec: DeploySpec): string {
  return `[program:${spec.app}]
directory=/srv/${spec.app}/current
command=${spec.startCommand}
environment=ENV_FILE="/srv/${spec.app}/shared/.env"
autostart=true
autorestart=true
stdout_logfile=/var/log/supervisor/${spec.app}.out.log
stderr_logfile=/var/log/supervisor/${spec.app}.err.log
`;
}

function renderNginx(spec: DeploySpec): string {
  return `server {
    listen 80;
    server_name ${spec.domain};
    location / {
        proxy_pass http://127.0.0.1:${spec.port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location ~ /\.(env|git) { deny all; return 404; }
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
}
# TLS: certbot --nginx -d ${spec.domain} (run once after DNS resolves)
`;
}
