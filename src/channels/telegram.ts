import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AgentLoop, type AgentDefinition } from "../harness/loop.js";
import type { HarnessBus } from "../harness/bus.js";
import type { PolicyGuard } from "../harness/policy.js";
import type { ToolRegistry } from "../harness/tools.js";
import type { LLMProvider } from "../harness/llm.js";
import type { HarnessEvent } from "../schemas/events.js";

/**
 * Telegram channel: chat ↔ session bridge over the Bot API (long polling,
 * zero extra dependencies — plain fetch).
 *
 * - A Telegram chat maps to one durable Forge session (persisted on disk so
 *   restarts keep the mapping). `/new` starts a fresh session.
 * - Assistant messages stream back to the chat; dangerous tool calls show up
 *   as messages with inline ✅/❌ approve/deny buttons.
 */

const API = "https://api.telegram.org";
const STATE_FILE = "telegram-chats.json";

interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
}

export interface TelegramDeps {
  llm: LLMProvider;
  tools: ToolRegistry;
  policy: PolicyGuard;
  bus: HarnessBus;
  workDir: string;
  agent: () => AgentDefinition;
}

export function startTelegramChannel(token: string, deps: TelegramDeps): { stop(): void } {
  const statePath = join(deps.workDir, ".forge", STATE_FILE);
  mkdirSync(join(deps.workDir, ".forge"), { recursive: true });

  // chatId (as string) → sessionId, persisted across restarts.
  const chatToSession = new Map<string, string>(loadMap(statePath));
  const sessionToChats = new Map<string, Set<string>>();
  for (const [chat, session] of chatToSession) {
    if (!sessionToChats.has(session)) sessionToChats.set(session, new Set());
    sessionToChats.get(session)!.add(chat);
  }

  const saveMap = () => {
    writeFileSync(statePath, JSON.stringify(Object.fromEntries(chatToSession), null, 2));
  };
  const callApi = async (method: string, body: unknown) => {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  };
  const send = (chatId: string | number, text: string, buttons?: Array<{ text: string; data: string }>) =>
    callApi("sendMessage", {
      chat_id: chatId,
      text: text.slice(0, 4000),
      parse_mode: "HTML",
      // Buttons need parse_mode-safe text; approval prompts are short anyway.
      ...(buttons?.length
        ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] } }
        : {}),
    }).then((r) => {
      if (!r.ok) console.error(`[telegram] sendMessage failed: ${r.description}`);
    });

  // ── Outgoing: bus events → mapped chats ─────────────────────────
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const onEvent = (sessionId: string, ev: HarnessEvent) => {
    const chats = sessionToChats.get(sessionId);
    if (!chats) return;
    for (const chatId of chats) {
      if (ev.type === "assistant_message" && ev.message.content.trim()) {
        void send(chatId, esc(ev.message.content));
      } else if (ev.type === "error") {
        void send(chatId, `⚠️ ${esc(ev.message)}`);
      } else if (ev.type === "approval_requested") {
        const label = ev.call.name === "run_bash" ? String(ev.call.args.command ?? "") : JSON.stringify(ev.call.args);
        void send(chatId, `🔐 <b>Approval needed</b>: ${esc(ev.call.name)}\n<code>${esc(label.slice(0, 500))}</code>`, [
          { text: "✅ Approve", data: `approve:${ev.call.id}` },
          { text: "❌ Deny", data: `deny:${ev.call.id}` },
        ]);
      } else if (ev.type === "done") {
        void send(chatId, "✅ Task finished.");
      }
    }
  };
  // The bus emits every session's events on the global "event" channel.
  const globalHandler = (payload: { sessionId: string; event: HarnessEvent }) => onEvent(payload.sessionId, payload.event);
  (deps.bus as unknown as { on(channel: string, fn: typeof globalHandler): void }).on("event", globalHandler);

  // ── Incoming: run the agent for a chat ──────────────────────────
  const runForChat = async (chatId: string, userMessage: string) => {
    const existing = chatToSession.get(chatId);
    const loop = new AgentLoop({
      llm: deps.llm,
      tools: deps.tools,
      policy: deps.policy,
      bus: deps.bus,
      workDir: deps.workDir,
      ...(existing ? { sessionId: existing } : {}),
    });
    if (!existing || !sessionToChats.has(loop.sessionId)) {
      chatToSession.set(chatId, loop.sessionId);
      if (!sessionToChats.has(loop.sessionId)) sessionToChats.set(loop.sessionId, new Set());
      sessionToChats.get(loop.sessionId)!.add(chatId);
      saveMap();
    }
    loop
      .run(deps.agent(), userMessage, { autoApprove: false })
      .catch((err) => deps.bus.publish(loop.sessionId, { type: "error", message: String(err), recoverable: false }));
  };

  // ── Long-poll loop ──────────────────────────────────────────────
  let offset = 0;
  let stopped = false;
  const poll = async () => {
    while (!stopped) {
      try {
        const res = (await callApi("getUpdates", {
          offset,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        })) as { ok: boolean; result?: TelegramUpdate[] };
        for (const u of res.result ?? []) {
          offset = u.update_id + 1;
          if (u.message?.text) {
            const chatId = String(u.message.chat.id);
            const text = u.message.text.trim();
            if (text === "/new" || text === "/start") {
              chatToSession.delete(chatId);
              saveMap();
              await send(chatId, "🆕 Fresh session ready. What are we building?");
              continue;
            }
            if (text.startsWith("/")) continue; // unknown commands ignored
            await send(chatId, "⏳ On it…");
            await runForChat(chatId, text);
          } else if (u.callback_query?.data && u.callback_query.message) {
            const [action, callId] = u.callback_query.data.split(":");
            const sessionId = chatToSession.get(String(u.callback_query.message.chat.id));
            if (sessionId && (action === "approve" || action === "deny")) {
              deps.bus.submitApproval(sessionId, callId, action === "approve", "telegram");
              await callApi("answerCallbackQuery", { callback_query_id: u.callback_query.id, text: action === "approve" ? "Approved" : "Denied" });
            }
          }
        }
      } catch (err) {
        console.error("[telegram] poll error:", err);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };
  void poll();
  console.log("[telegram] channel started");

  return {
    stop() {
      stopped = true;
      (deps.bus as unknown as { off(channel: string, fn: typeof globalHandler): void }).off("event", globalHandler);
    },
  };
}

function loadMap(statePath: string): [string, string][] {
  if (!existsSync(statePath)) return [];
  try {
    return Object.entries(JSON.parse(readFileSync(statePath, "utf8")) as Record<string, string>);
  } catch {
    return [];
  }
}
