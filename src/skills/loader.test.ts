import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, formatSkillsForContext } from "./loader.js";

describe("loadSkills", () => {
  let root: string;
  beforeEach(() => (root = mkdtempSync(join(tmpdir(), "forge-skills-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns an empty array when the directory does not exist", () => {
    expect(loadSkills(join(root, "missing"))).toEqual([]);
  });

  it("returns an empty array when the root is a file, not a directory", () => {
    const f = join(root, "not-a-dir.txt");
    writeFileSync(f, "x");
    expect(loadSkills(f)).toEqual([]);
  });

  it("loads a SKILL.md with YAML front-matter and parses metadata", () => {
    mkdirSync(join(root, "alpha"));
    writeFileSync(
      join(root, "alpha", "SKILL.md"),
      [
        "---",
        "name: alpha",
        "description: does alpha things",
        "author: tester",
        "version: 2.3.4",
        "---",
        "",
        "# Alpha body",
        "",
        "first line of content",
      ].join("\n"),
    );
    const skills = loadSkills(root);
    expect(skills).toHaveLength(1);
    const s = skills[0];
    expect(s.name).toBe("alpha");
    expect(s.description).toBe("does alpha things");
    expect(s.author).toBe("tester");
    expect(s.version).toBe("2.3.4");
    expect(s.body).toContain("# Alpha body");
    expect(s.body).toContain("first line of content");
    expect(s.body.trimStart().startsWith("# Alpha body")).toBe(true);
    expect(s.companions).toEqual({});
  });

  it("falls back to directory name when front-matter `name` is missing", () => {
    mkdirSync(join(root, "beta"));
    writeFileSync(join(root, "beta", "SKILL.md"), "# Beta body\n");
    const skills = loadSkills(root);
    expect(skills[0].name).toBe("beta");
    expect(skills[0].version).toBe("0.0.0"); // default
  });

  it("treats files with no front-matter as valid skills", () => {
    mkdirSync(join(root, "gamma"));
    writeFileSync(join(root, "gamma", "SKILL.md"), "just a body, no front-matter");
    const skills = loadSkills(root);
    expect(skills).toHaveLength(1);
    expect(skills[0].body).toBe("just a body, no front-matter");
    expect(skills[0].name).toBe("gamma");
  });

  it("loads companion .md files keyed by basename", () => {
    mkdirSync(join(root, "delta"));
    writeFileSync(
      join(root, "delta", "SKILL.md"),
      "---\nname: delta\n---\n\n# Delta",
    );
    writeFileSync(join(root, "delta", "roadmap.md"), "# Roadmap\nstage 1");
    writeFileSync(join(root, "delta", "examples.md"), "## Example\nfoo");
    writeFileSync(join(root, "delta", "ignored.txt"), "not markdown");
    const skills = loadSkills(root);
    expect(skills[0].companions).toEqual({
      roadmap: "# Roadmap\nstage 1",
      examples: "## Example\nfoo",
    });
  });

  it("skips subdirectories that lack SKILL.md", () => {
    mkdirSync(join(root, "no-skill-here"));
    writeFileSync(join(root, "no-skill-here", "readme.md"), "wip");
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real", "SKILL.md"), "# Real");
    const skills = loadSkills(root);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("real");
  });

  it("preserves multi-line body content exactly as written", () => {
    mkdirSync(join(root, "preserve"));
    const body = [
      "---",
      "name: preserve",
      "---",
      "",
      "line 1",
      "line 2",
      "",
      "line 3 with `code` and **bold**",
    ].join("\n");
    writeFileSync(join(root, "preserve", "SKILL.md"), body);
    const skills = loadSkills(root);
    expect(skills[0].body).toBe("\nline 1\nline 2\n\nline 3 with `code` and **bold**");
  });
});

describe("formatSkillsForContext", () => {
  it("returns an empty string for no skills", () => {
    expect(formatSkillsForContext([])).toBe("");
  });

  it("renders each skill with a header showing name, version, and description", () => {
    const out = formatSkillsForContext([
      {
        name: "alpha",
        description: "does alpha things",
        author: "tester",
        version: "1.0.0",
        body: "alpha body",
        companions: {},
        dir: "/x",
      },
    ]);
    expect(out).toContain("## Skill: alpha (v1.0.0) — does alpha things");
    expect(out).toContain("alpha body");
  });

  it("joins multiple skills with a horizontal rule separator", () => {
    const out = formatSkillsForContext([
      {
        name: "a",
        description: "",
        author: "",
        version: "0.1.0",
        body: "a body",
        companions: {},
        dir: "/x",
      },
      {
        name: "b",
        description: "",
        author: "",
        version: "0.2.0",
        body: "b body",
        companions: {},
        dir: "/y",
      },
    ]);
    expect(out).toMatch(/## Skill: a[\s\S]*---\n\n## Skill: b/);
  });

  it("omits description clause when description is empty", () => {
    const out = formatSkillsForContext([
      {
        name: "no-desc",
        description: "",
        author: "",
        version: "1.0.0",
        body: "x",
        companions: {},
        dir: "/x",
      },
    ]);
    expect(out).toContain("## Skill: no-desc (v1.0.0)");
    expect(out).not.toContain("—");
  });

  it("appends companions under their own headings, in iteration order", () => {
    const out = formatSkillsForContext([
      {
        name: "with-companions",
        description: "",
        author: "",
        version: "1.0.0",
        body: "main body",
        companions: {
          roadmap: "stage 1 content",
          examples: "foo bar",
        },
        dir: "/x",
      },
    ]);
    expect(out).toContain("### Companion: roadmap");
    expect(out).toContain("stage 1 content");
    expect(out).toContain("### Companion: examples");
    expect(out).toContain("foo bar");
    // Companions come after the body
    expect(out.indexOf("main body")).toBeLessThan(out.indexOf("Companion: roadmap"));
  });
});
