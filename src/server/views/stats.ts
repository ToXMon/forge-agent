import type { SessionStats } from "../../harness/stats.js";
import { escapeHtml } from "./escape.js";

/**
 * Stats panel rendered as HTML. Reuses the SessionStats type from the
 * harness stats module so the CLI's /stats and the eval scorer agree.
 */
export function statsPanel(s: SessionStats): string {
  const cells: { label: string; value: string }[] = [
    { label: "status", value: escapeHtml(s.status) },
    { label: "events", value: String(s.totalEvents) },
    { label: "tool calls", value: String(s.toolCallCount) },
    { label: "errors", value: String(s.errors) },
  ];
  if (s.compactedSummaryLen != null) {
    cells.push({ label: "summary", value: `${s.compactedSummaryLen} chars` });
  }
  if (s.approvals.requested > 0) {
    cells.push({
      label: "approvals",
      value: `${s.approvals.approved}/${s.approvals.requested}`,
    });
  }
  if (s.pendingApproval) {
    cells.push({ label: "awaiting", value: `⚠ ${escapeHtml(s.pendingApproval)}` });
  }

  const toolCells = Object.entries(s.byTool)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ label: escapeHtml(name), value: String(count) }));

  const cellHtml = (cell: { label: string; value: string }) =>
    `<div class="stat-cell"><div class="label">${cell.label}</div><div class="value">${cell.value}</div></div>`;

  return `
    <div class="stats-panel">
      <h3>Session stats</h3>
      <div class="stats-grid">
        ${cells.map(cellHtml).join("")}
      </div>
      ${toolCells.length ? `<h3 style="margin-top:14px">Tools used</h3><div class="stats-grid">${toolCells.map(cellHtml).join("")}</div>` : ""}
      ${s.lastError ? `<div style="margin-top:10px;color:var(--red)">last error: ${escapeHtml(s.lastError)}</div>` : ""}
    </div>
  `;
}
