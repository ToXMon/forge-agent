/**
 * Tiny HTML escape helper. We render every untrusted string (tool args,
 * user-supplied task text, model output) through this — never raw.
 *
 * Five characters are enough: & < > " '. Apostrophe only matters inside
 * attribute values delimited by single quotes, which we don't use, but
 * escaping it costs nothing.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON.stringify with stable output and HTML-safe wrapping. */
export function escapeJson(value: unknown): string {
  return escapeHtml(JSON.stringify(value));
}

/** Compact JSON for inline data-* attributes (no HTML escaping). */
export function jsonAttr(value: unknown): string {
  return JSON.stringify(value);
}
