import type { EvalScore } from "../../../evals/scorers/toolCallMatch.js";
import { escapeHtml } from "./escape.js";

export interface EvalResults {
  ranAt: string;
  finishedAt: string;
  model: string;
  totalTasks: number;
  passed: number;
  results: EvalScore[];
}

/**
 * The eval dashboard: one card per task with PASS/FAIL badge, score
 * metrics, and a re-run button per task. Re-run buttons POST to a
 * subprocess endpoint that shells out to `npm run eval -- --tasks <id>`.
 */
export function evalDashboard(results: EvalResults | null): string {
  return evalHeader(results) + `<div class="eval-grid">${evalGrid(results)}</div>`;
}

/** Just the grid contents — what the "Run all" button swaps in. */
export function evalGrid(results: EvalResults | null): string {
  if (!results) return `<div class="empty-state" style="grid-column:1/-1">No eval results yet. Run the suite to populate.</div>`;
  return results.results.map(evalCard).join("");
}

/** Just the header — what the per-task re-run swaps in. */
export function evalHeader(results: EvalResults | null): string {
  return `
    <div class="eval-header">
      <div class="eval-summary">
        <strong>${results ? `${results.passed}/${results.totalTasks}` : "—"}</strong>
        <span class="meta">tasks passed</span>
        ${results ? `<span class="meta" style="margin-left:12px">model: ${escapeHtml(results.model)}</span>` : ""}
        ${results ? `<span class="meta" style="margin-left:12px">ran: ${escapeHtml(results.ranAt)}</span>` : ""}
      </div>
      <div>
        <button hx-post="/eval/run-all" hx-target=".eval-grid" hx-swap="outerHTML" hx-indicator="#run-all-spinner">
          Run all
        </button>
        <span id="run-all-spinner" class="htmx-indicator">running…</span>
      </div>
    </div>
  `;
}

function evalCard(score: EvalScore): string {
  const cls = score.pass ? "pass" : "fail";
  const badge = `<span class="badge ${cls}">${score.pass ? "PASS" : "FAIL"}</span>`;
  const failuresHtml = score.failures.length
    ? `<div class="failures">${score.failures.map(escapeHtml).join("<br>")}</div>`
    : "";
  const stats = `
    <div class="stats">
      ${score.toolCallCount} calls · ${score.eventCount} events · ${(score.durationMs / 1000).toFixed(1)}s
      ${score.approvalRate != null ? `· approvals ${(score.approvalRate * 100).toFixed(0)}%` : ""}
      ${score.retryRate > 0 ? `· retries ${(score.retryRate * 100).toFixed(0)}%` : ""}
    </div>
  `;

  return `
    <div class="eval-card ${cls}" id="task-${escapeHtml(score.taskId)}">
      ${badge}<h3 style="display:inline">${escapeHtml(score.taskId)}</h3>
      ${stats}
      ${failuresHtml}
      <div class="actions">
        <button hx-post="/eval/run/${encodeURIComponent(score.taskId)}" hx-target="#task-${encodeURIComponent(score.taskId)}" hx-swap="outerHTML" hx-indicator="#task-${score.taskId}-spin">
          Re-run
        </button>
        <span id="task-${score.taskId}-spin" class="htmx-indicator">running…</span>
      </div>
    </div>
  `;
}
