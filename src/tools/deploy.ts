import { z } from "zod";
import { defineTool } from "../harness/tools.js";
import { DeploySpecSchema } from "../infrastructure/target.js";
import { VpsTarget } from "../infrastructure/vps.js";
import { AkashTarget } from "../infrastructure/akash.js";

/**
 * The deploy tool: one agent-facing verb, infrastructure-agnostic targets.
 * Always requires approval (policy.ts). Preflight → ship → verify, with the
 * full log returned so the agent can reason about failures.
 */
export const deployTool = defineTool({
  name: "deploy",
  description:
    "Deploy the app to infrastructure. Targets: 'vps' (any Ubuntu server over SSH — your existing server), 'akash' (decentralized cloud via SDL + akash CLI). Requires approval.",
  schema: z.object({
    target: z.enum(["vps", "akash"]),
    spec: DeploySpecSchema,
    /** vps: user@host (+ optional key). akash: docker image (+ optional key name). */
    targetConfig: z.object({
      sshTarget: z.string().optional(),
      sshKeyPath: z.string().optional(),
      image: z.string().optional(),
      keyName: z.string().optional(),
    }),
  }),
  parameters: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["vps", "akash"] },
      spec: {
        type: "object",
        properties: {
          app: { type: "string" },
          artifactDir: { type: "string" },
          startCommand: { type: "string" },
          port: { type: "integer" },
          domain: { type: "string" },
          env: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["app", "artifactDir", "startCommand", "port"],
      },
      targetConfig: {
        type: "object",
        properties: {
          sshTarget: { type: "string", description: "user@host of your existing server" },
          sshKeyPath: { type: "string" },
          image: { type: "string", description: "Docker image (akash)" },
          keyName: { type: "string" },
        },
      },
    },
    required: ["target", "spec", "targetConfig"],
  },
  async execute(args) {
    const spec = DeploySpecSchema.parse(args.spec);
    const target =
      args.target === "vps"
        ? new VpsTarget({
            sshTarget: required(args.targetConfig.sshTarget, "targetConfig.sshTarget (user@host)"),
            sshKeyPath: args.targetConfig.sshKeyPath,
          })
        : new AkashTarget({
            image: required(args.targetConfig.image, "targetConfig.image (docker image)"),
            keyName: args.targetConfig.keyName,
          });

    const pre = await target.preflight();
    const ship = await target.ship(spec);
    if (!ship.ok) {
      return `PREFLIGHT:\n${pre}\n\nSHIP FAILED:\n${ship.logs}`;
    }
    const verify = await target.verify(spec);
    return [
      `PREFLIGHT:\n${pre}`,
      `SHIP: ok url=${ship.url ?? "n/a"}\n${ship.logs}`,
      `VERIFY: ${verify.ok ? "healthy" : "UNHEALTHY"}\n${verify.logs}`,
    ].join("\n\n");
  },
});

function required(v: string | undefined, name: string): string {
  if (!v) throw new Error(`deploy requires ${name}`);
  return v;
}
