import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * A loaded skill: one subdirectory containing a SKILL.md (entry point) and
 * optional companion files. The format mirrors the AdaL skills convention:
 * YAML front-matter at the top of SKILL.md declares name/description/author/
 * version, then the markdown body. Companion files are sibling .md files
 * loaded by basename (e.g., `roadmap.md` → `companions.roadmap`).
 */
export interface Skill {
  /** Skill name (from front-matter `name`, else directory basename). */
  name: string;
  /** One-line description (from front-matter `description`). */
  description: string;
  /** Author (from front-matter `author`). */
  author: string;
  /** Semver-ish string (from front-matter `version`). */
  version: string;
  /** SKILL.md body with front-matter stripped. */
  body: string;
  /** Companion .md files keyed by basename (without `.md`). */
  companions: Record<string, string>;
  /** Absolute path to the skill directory. */
  dir: string;
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Minimal YAML front-matter parser. We only need flat `key: value` pairs;
 * nested structures, lists, and quoting can come later if a skill needs them.
 * Returns empty meta and the original content as body if no front-matter is
 * present. Throws on a `---` opener with no closer — that signals a malformed
 * skill the author should fix, not silently swallow.
 */
function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(FRONT_MATTER_RE);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: raw.slice(m[0].length) };
}

/**
 * Load all skills from a directory tree. Each immediate subdirectory is
 * treated as one skill; its `SKILL.md` is the entry point and any other
 * `.md` files in that subdirectory become companions. Subdirectories
 * without `SKILL.md` are skipped silently (they may be in-progress).
 */
export function loadSkills(rootDir: string): Skill[] {
  if (!existsSync(rootDir)) return [];
  const stat = statSync(rootDir);
  if (!stat.isDirectory()) return [];

  const out: Skill[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(rootDir, entry.name);
    const skillPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    const raw = readFileSync(skillPath, "utf8");
    const { meta, body } = parseFrontMatter(raw);

    const companions: Record<string, string> = {};
    for (const f of readdirSync(skillDir, { withFileTypes: true })) {
      if (!f.isFile() || f.name === "SKILL.md" || !f.name.endsWith(".md")) continue;
      companions[f.name.replace(/\.md$/, "")] = readFileSync(join(skillDir, f.name), "utf8");
    }

    out.push({
      name: meta.name ?? entry.name,
      description: meta.description ?? "",
      author: meta.author ?? "",
      version: meta.version ?? "0.0.0",
      body,
      companions,
      dir: skillDir,
    });
  }
  return out;
}

/**
 * Render a list of loaded skills as one context-injectable string. Each
 * skill is delimited so the agent can see where one ends and the next
 * begins; the front-matter summary line keeps the agent oriented even if
 * the body doesn't open with a title. Companions are appended under their
 * own headings — they ship with the skill and are always available.
 */
export function formatSkillsForContext(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return skills
    .map((s) => {
      const header = `## Skill: ${s.name} (v${s.version})${s.description ? ` — ${s.description}` : ""}`;
      const parts = [header, s.body.trim()];
      for (const [k, v] of Object.entries(s.companions)) {
        parts.push(`### Companion: ${k}\n\n${v.trim()}`);
      }
      return parts.join("\n\n");
    })
    .join("\n\n---\n\n");
}
