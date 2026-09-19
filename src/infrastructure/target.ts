import { z } from "zod";

/**
 * Deployment target abstraction — the handbook's playbook made pluggable.
 * "I have a server" = SSH adapter. "Deploy to Akash" = Akash adapter.
 * Same interface, same agent workflow.
 */

export const DeploySpecSchema = z.object({
  /** App name — used for service names, directories, nginx server blocks. */
  app: z.string().regex(/^[a-z0-9-]+$/, "app must be lowercase-dns-safe"),
  /** Absolute path of the built app on this machine (what gets shipped). */
  artifactDir: z.string(),
  /** Start command on the target (e.g. "gunicorn app:app -k uvicorn.workers.UvicornWorker"). */
  startCommand: z.string(),
  /** Port the app listens on inside the target. */
  port: z.number().int().positive(),
  /** Public domain, if TLS + nginx should be configured. */
  domain: z.string().optional(),
  /** Runtime env vars (values stay local; only keys are shipped as a template). */
  env: z.record(z.string()).default({}),
});
export type DeploySpec = z.infer<typeof DeploySpecSchema>;

export interface DeployResult {
  ok: boolean;
  url?: string;
  logs: string;
}

export interface DeployTarget {
  readonly name: string;
  /** Verify access + prerequisites (SSH reachable / akash CLI + wallet). */
  preflight(): Promise<string>;
  /** Ship the artifact and start the service. */
  ship(spec: DeploySpec): Promise<DeployResult>;
  /** Health check + rollback hint if the ship didn't take. */
  verify(spec: DeploySpec): Promise<DeployResult>;
}
