import { EventEmitter } from "node:events";
import type { HarnessEvent } from "../schemas/events.js";

/**
 * Central event bus: harness → UI transports. The loop publishes every
 * event; the WebSocket server (and CLI renderer) subscribe. Single source
 * of truth for live session state.
 */
export class HarnessBus extends EventEmitter {
  publish(sessionId: string, event: HarnessEvent): void {
    this.emit("event", { sessionId, event, at: new Date().toISOString() });
    this.emit(`event:${sessionId}`, event);
  }

  subscribe(sessionId: string, fn: (event: HarnessEvent) => void): () => void {
    const channel = `event:${sessionId}`;
    this.on(channel, fn);
    return () => this.off(channel, fn);
  }

  /** Human approval decisions arrive here from the UI/CLI. */
  submitApproval(sessionId: string, callId: string, approved: boolean, note?: string): void {
    this.emit(`approval:${sessionId}`, { callId, approved, note });
  }

  awaitApproval(
    sessionId: string,
    callId: string,
    timeoutMs = 30 * 60 * 1000,
  ): Promise<{ approved: boolean; note?: string }> {
    return new Promise((resolve, reject) => {
      const channel = `approval:${sessionId}`;
      const timer = setTimeout(() => {
        this.off(channel, handler);
        reject(new Error(`approval for ${callId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = (d: { callId: string; approved: boolean; note?: string }) => {
        if (d.callId !== callId) return;
        clearTimeout(timer);
        this.off(channel, handler);
        resolve({ approved: d.approved, note: d.note });
      };
      this.on(channel, handler);
    });
  }
}
