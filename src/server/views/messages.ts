import type { HarnessEvent, ToolCall, ToolResult } from "../../schemas/events.js";
import { escapeHtml } from "./escape.js";

/**
 * Render an event from the harness bus as an HTML fragment suitable for
 * streaming over SSE into the messages container. The handler is responsible
 * for keeping a per-connection Map of call_id → ToolCall so tool_result events
 * can re-render the full card with both args and result.
 */
export function eventFragment(
  ev: HarnessEvent,
  ctx: { sessionId: string; pendingCalls: Map<string, ToolCall> },
): string {
  switch (ev.type) {
    case "user_message":
      return `<div class="message user">${escapeHtml(ev.message.content)}</div>`;

    case "assistant_message":
      if (!ev.message.content) return "";
      return `<div class="message assistant">${escapeHtml(ev.message.content)}</div>`;

    case "tool_call":
      ctx.pendingCalls.set(ev.call.id, ev.call);
      return toolCardHtml(ctx.sessionId, ev.call, null, true);

    case "tool_result": {
      // The matching tool_call may have been emitted in an earlier chunk.
      // If we don't have it, just show the result line.
      const call = ctx.pendingCalls.get(ev.result.callId);
      ctx.pendingCalls.delete(ev.result.callId);
      if (call) return toolCardOobSwap(ctx.sessionId, call, ev.result);
      return `<div class="tool-result"><span class="tool-name">${escapeHtml(ev.result.name)}</span> ${escapeHtml(ev.result.ok ? "✓" : "✗")} (${ev.result.durationMs}ms) ${escapeHtml(ev.result.output.slice(0, 240))}</div>`;
    }

    case "approval_requested":
      // Already represented by the pending tool_call card.
      return "";

    case "approval_decided":
      // Drop the approve/deny buttons (oob swap of an empty fragment).
      return `<div id="tool-${ev.callId}-actions" hx-swap-oob="true"></div>`;

    case "summary_compacted":
      return `<div class="message system">compacted ${ev.upToEvent} events into a ${ev.summary.length}-char summary</div>`;

    case "error":
      return `<div class="message system">error: ${escapeHtml(ev.message)}</div>`;

    case "done":
      return `<div class="message system">done: ${escapeHtml(ev.reason)}</div>`;
  }
}

/**
 * Render historical events (from a page refresh) as a single HTML block.
 * Unlike the live SSE path, this collapses tool_call + tool_result pairs
 * into single cards so the user doesn't see a duplicated pending card
 * followed by the completed one.
 */
export function historicalEventsHtml(
  sessionId: string,
  events: HarnessEvent[],
): string {
  const pending = new Map<string, ToolCall>();
  const out: string[] = [];
  for (const ev of events) {
    switch (ev.type) {
      case "user_message":
        out.push(`<div class="message user">${escapeHtml(ev.message.content)}</div>`);
        break;
      case "assistant_message":
        if (ev.message.content) out.push(`<div class="message assistant">${escapeHtml(ev.message.content)}</div>`);
        break;
      case "tool_call":
        pending.set(ev.call.id, ev.call);
        out.push(toolCardHtml(sessionId, ev.call, null, true));
        break;
      case "tool_result": {
        const call = pending.get(ev.result.callId);
        pending.delete(ev.result.callId);
        if (call) {
          // Replace the last appended pending card for this call id with the
          // completed version. We track the index to splice in place.
          const cardHtml = toolCardHtml(sessionId, call, ev.result, false);
          const idx = out.findIndex((h) => h.includes(`id="tool-${call.id}"`));
          if (idx >= 0) out[idx] = cardHtml;
          else out.push(cardHtml);
        } else {
          out.push(`<div class="tool-result">${escapeHtml(ev.result.name)} ${escapeHtml(ev.result.ok ? "✓" : "✗")} (${ev.result.durationMs}ms)</div>`);
        }
        break;
      }
      case "approval_requested":
        break;
      case "approval_decided":
        break;
      case "summary_compacted":
        out.push(`<div class="message system">compacted ${ev.upToEvent} events into a ${ev.summary.length}-char summary</div>`);
        break;
      case "error":
        out.push(`<div class="message system">error: ${escapeHtml(ev.message)}</div>`);
        break;
      case "done":
        out.push(`<div class="message system">done: ${escapeHtml(ev.reason)}</div>`);
        break;
    }
  }
  return out.join("");
}

/** Live-mode card with hx-swap-oob so it replaces the pending card via SSE. */
function toolCardOobSwap(sessionId: string, call: ToolCall, result: ToolResult): string {
  const card = toolCardHtml(sessionId, call, result, false);
  // Inject the OOB swap attribute on the outer div.
  return card.replace(`<div id="tool-${call.id}" class="tool-card">`, `<div id="tool-${call.id}" class="tool-card" hx-swap-oob="true">`);
}

export function messageHtml(role: "user" | "assistant" | "system", content: string): string {
  return `<div class="message ${role}">${escapeHtml(content)}</div>`;
}

/**
 * Render a tool call card. When `pending` is true, the card includes
 * approve/deny forms wired to the harness. The buttons are htmx-driven
 * forms that POST and replace themselves on success — no JS required.
 */
export function toolCardHtml(
  sessionId: string,
  call: ToolCall,
  result: ToolResult | null,
  pending: boolean,
): string {
  const argsPreview = JSON.stringify(call.args).slice(0, 240);
  const cardClass = `tool-card${pending ? " pending" : ""}${result && !result.ok ? " error" : ""}`;
  const cardId = `tool-${call.id}`;
  const resultHtml = result
    ? `<div class="tool-result">${escapeHtml(result.ok ? "✓" : "✗")} ${escapeHtml(result.name)} (${result.durationMs}ms) ${escapeHtml(result.output.slice(0, 240))}</div>`
    : "";

  const actions = pending
    ? `<div id="tool-${call.id}-actions" class="approval-actions">
        <button type="button" class="approve-btn" hx-post="/sessions/${encodeURIComponent(sessionId)}/approve/${encodeURIComponent(call.id)}" hx-swap="none">Approve</button>
        <button type="button" class="deny-btn" hx-post="/sessions/${encodeURIComponent(sessionId)}/deny/${encodeURIComponent(call.id)}" hx-swap="none">Deny</button>
      </div>`
    : "";

  return `<div id="${cardId}" class="${cardClass}">
    <span class="tool-name">${escapeHtml(call.name)}</span>
    <span class="tool-args">${escapeHtml(argsPreview)}</span>
    ${resultHtml}
    ${actions}
  </div>`;
}
