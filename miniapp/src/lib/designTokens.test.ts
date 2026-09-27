/**
 * Keeps the UI on the design tokens (see index.css): fails with file:line when
 * code reaches for an off-system font size, weight, spacing step, raw color or
 * a lucide icon rendered outside <Icon>.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const FILES = sourceFiles(SRC).map((path) => ({
  name: relative(SRC, path),
  lines: readFileSync(path, "utf8").split("\n"),
}));

/** Every line matching `pattern` (and not excused by `allow`), as "file:line  text". */
function offenders(pattern: RegExp, allow?: (line: string) => boolean): string[] {
  return FILES.flatMap(({ name, lines }) =>
    lines.flatMap((line, i) =>
      pattern.test(line) && !allow?.(line) ? [`${name}:${i + 1}  ${line.trim()}`] : []
    )
  );
}

function assertNone(found: string[], rule: string) {
  assert.deepEqual(found, [], `${rule}:\n${found.join("\n")}`);
}

const B = String.raw`(?<![\w-])`; // class-name boundary
const E = String.raw`(?![\w-])`;

test("font sizes are type roles only (text-title/headline/body/footnote/caption)", () => {
  assertNone(
    offenders(new RegExp(`${B}text-(xs|sm|base|lg|xl|[2-9]xl|\\[[\\d.]+(px|rem|em)\\])${E}`)),
    "Use a type role instead"
  );
});

test("weights are 400/600, and 700 only for numbers", () => {
  assertNone(
    offenders(new RegExp(`${B}font-(thin|extralight|light|medium|extrabold|black)${E}`)),
    "Use font-normal or font-semibold"
  );
  assertNone(
    offenders(new RegExp(`${B}font-bold${E}`), (line) => /(?<![\w-])numeric(?![\w-])/.test(line)),
    "font-bold is for big numbers — pair it with `numeric`"
  );
});

test("spacing sits on the 4/8/12/16/24/32 scale", () => {
  const prefix = String.raw`-?(p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|gap-x|gap-y|space-x|space-y)`;
  assertNone(
    offenders(new RegExp(`${B}${prefix}-(\\d+\\.\\d+|5|7|9|11|14)(?![\\w.-])`)),
    "Use 1/2/3/4/6/8 (4–32px)"
  );
});

test("colors come from tokens, not hex/rgb or the Tailwind palette", () => {
  assertNone(offenders(/\[#[0-9a-fA-F]{3,8}\]|rgba?\(|"#[0-9a-fA-F]{3,8}"/), "Use a color token");
  const palette =
    "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
  assertNone(offenders(new RegExp(`${B}[a-z-]+-(${palette})-\\d{2,3}${E}`)), "Use a color token");
});

// hover:/active: states of a brand fill (bg-secondary/80) are not surface levels
test("surfaces are surface-1/2/3, not secondary/muted opacity steps", () => {
  assertNone(offenders(new RegExp(`(?<![\\w:-])bg-(secondary|muted)/\\d+${E}`)), "Use bg-surface-2 or bg-surface-3");
});

test("lucide icons render through <Icon>", () => {
  const found = FILES.filter(({ name }) => name.endsWith(".tsx") && !name.endsWith("icon.tsx")).flatMap(
    ({ name, lines }) => {
      const source = lines.join("\n");
      const imported = source.match(/import \{([^}]*)\} from "lucide-react"/)?.[1] ?? "";
      const components = imported
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith("type "));
      return components.filter((c) => new RegExp(`<${c}[\\s/>]`).test(source)).map((c) => `${name}: <${c}>`);
    }
  );
  assertNone(found, "Render icons as <Icon icon={…} />");
});
