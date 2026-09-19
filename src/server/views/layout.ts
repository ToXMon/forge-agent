import { escapeHtml } from "./escape.js";
import { loadSkills, formatSkillsForContext } from "../../skills/loader.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve bundled skills for the sidebar (resolved once at module load). */
function bundledSkillsList(): { name: string; description: string; version: string }[] {
  const root = join(here, "../../skills");
  if (!existsSync(root)) return [];
  return loadSkills(root).map((s) => ({ name: s.name, description: s.description, version: s.version }));
}

const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <link rel="stylesheet" href="/static/styles.css">
  <script src="/static/htmx.min.js"></script>
</head>
<body>
  <aside>{sidebar}</aside>
  <main hx-target="this">{main}</main>
</body>
</html>`;

interface LayoutOptions {
  title?: string;
  sidebar: string;
  main: string;
}

/** Wrap a fragment as the full HTML shell. */
export function layout(opts: LayoutOptions): string {
  return SHELL.replace("{title}", escapeHtml(opts.title ?? "Forge")).replace("{sidebar}", opts.sidebar).replace("{main}", opts.main);
}

/** The sidebar markup, identical on every page. */
export function sidebar(opts: {
  currentSessionId: string | null;
  sessions: { id: string; status: string }[];
  model: string;
  providers: string[];
}): string {
  const skills = bundledSkillsList();
  const skillsHtml = skills.length
    ? skills
        .map(
          (s) =>
            `<div class="skill-item"><strong>${escapeHtml(s.name)}</strong> <span class="meta">v${escapeHtml(s.version)}</span><div class="meta">${escapeHtml(s.description)}</div></div>`,
        )
        .join("")
    : `<div class="meta">no bundled skills</div>`;

  const sessionsHtml = opts.sessions.length
    ? opts.sessions
        .map(
          (s) =>
            `<a class="session-item ${s.id === opts.currentSessionId ? "active" : ""}" href="/sessions/${encodeURIComponent(s.id)}"><strong>${escapeHtml(s.id.slice(0, 8))}</strong> <span class="meta">${escapeHtml(s.status)}</span></a>`,
        )
        .join("")
    : `<div class="meta">no sessions yet</div>`;

  const providersHtml = opts.providers.length
    ? `<div class="meta">registered: ${opts.providers.map((p) => escapeHtml(p)).join(", ")}</div>`
    : `<div class="meta">no providers registered</div>`;

  return `
    <header>
      <h1>Forge</h1>
    </header>
    <section>
      <h2>New session</h2>
      <form action="/sessions" method="post">
        <input name="task" placeholder="What should Forge do?" required>
        <button type="submit" style="margin-top:6px;width:100%">Start</button>
      </form>
    </section>
    <section>
      <h2>Skills</h2>
      ${skillsHtml}
    </section>
    <section>
      <h2>Sessions</h2>
      ${sessionsHtml}
    </section>
    <section>
      <h2>Model</h2>
      <div><strong>${escapeHtml(opts.model)}</strong></div>
      ${providersHtml}
    </section>
    <section>
      <a class="skill-item" href="/eval">→ eval dashboard</a>
    </section>
  `;
}

/** The empty state shown when no session is selected. */
export function emptyMain(): string {
  return `<div class="empty-state">Start a session from the sidebar, or open one from the list.</div>`;
}
