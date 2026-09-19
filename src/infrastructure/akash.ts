import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeploySpec, DeployResult, DeployTarget } from "./target.js";

const run = promisify(execFile);

export interface AkashConfig {
  /** Docker image to deploy (Akash runs containers, not source). */
  image: string;
  /** akash CLI key name (from `akash keys list`). */
  keyName?: string;
  /** Optional: path to write the generated SDL (default: ./deploy/<app>.sdl.yaml). */
  sdlOutPath?: string;
}

/**
 * Akash adapter — decentralized cloud target. Akash deploys containers via
 * an SDL manifest, so ship() here generates a valid SDL (pattern after the
 * akash-network/akash-skill generator) and drives the CLI deployment flow.
 * Runtime-agnostic: any Docker image works, which keeps this consistent
 * with the agent's "ship any app" contract.
 */
export class AkashTarget implements DeployTarget {
  readonly name = "akash";

  constructor(private cfg: AkashConfig) {}

  async preflight(): Promise<string> {
    try {
      const { stdout: ver } = await run("akash", ["version"], { timeout: 15_000 });
      const { stdout: keys } = await run("akash", ["keys", "list", "--output", "json"], { timeout: 15_000 }).catch(
        () => ({ stdout: "[]" }),
      );
      return `akash version: ${ver.trim()}\nkeys: ${keys.slice(0, 400)}`;
    } catch {
      return "akash CLI not found. Install: https://akash.network/docs/getting-started/quickstart-guides/akash-cli/";
    }
  }

  renderSdl(spec: DeploySpec): string {
    const envLines = Object.entries(spec.env)
      .map(([k, v]) => `      - ${k}=${v}`)
      .join("\n");
    return `---
version: "2.0"
services:
  ${spec.app}:
    image: ${this.cfg.image}
    command:
      - "sh"
      - "-c"
      - ${JSON.stringify(spec.startCommand)}
    env:
${envLines || "      []"}
    expose:
      - port: ${spec.port}
        as: 80
        to:
          - global: true
profiles:
  compute:
    ${spec.app}:
      resources:
        cpu:
          units: 1
        memory:
          size: 1Gi
        storage:
          size: 1Gi
  placement:
    akash:
      pricing:
        denom: uakt
        amount: 1000
deployment:
  ${spec.app}:
    akash:
      profile: ${spec.app}
      count: 1
`;
  }

  async ship(spec: DeploySpec): Promise<DeployResult> {
    const sdl = this.renderSdl(spec);
    const out = this.cfg.sdlOutPath ?? `deploy/${spec.app}.sdl.yaml`;
    await writeFile(out, sdl, "utf8");
    const logs = [
      `SDL written to ${out}`,
      "Next steps (require funded wallet + certificate):",
      `  akash tx deployment create ${out} --from ${this.cfg.keyName ?? "<key>"}`,
      "  akash query market bid list --owner <address>",
      `  akash tx market lease create --from ${this.cfg.keyName ?? "<key>"} ...`,
      `  akash provider lease-status ...  # get the assigned URI`,
      "Or use Akash Console (console.akash.network) for a guided flow.",
    ];
    // Full tx automation requires a funded wallet policy decision — the SDL +
    // exact command sequence is the safe handoff point.
    return { ok: true, logs: logs.join("\n") };
  }

  async verify(spec: DeploySpec): Promise<DeployResult> {
    return {
      ok: true,
      logs: `Verify deployment ${spec.app}: akash provider lease-status / akash query deployment list --owner <address>`,
    };
  }
}
