/**
 * Checks WCAG contrast of the color tokens in index.css, in both themes, so a
 * token tweak can't quietly make text unreadable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no ${selector} block in index.css`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const vars: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[name] = value.trim();
  return vars;
}

const light = block(":root");
const dark = { ...light, ...block(".dark") };

type Rgb = [number, number, number];

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const clamp = (c: number) => Math.min(1, Math.max(0, c));

function oklchToLinear(l: number, c: number, h: number): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

/** Linear-light sRGB of a token, following var() references. */
function resolve(theme: Record<string, string>, token: string): Rgb {
  let value = theme[token];
  assert.ok(value, `unknown token ${token}`);
  for (let ref = value.match(/^var\((--[\w-]+)\)$/); ref; ref = value.match(/^var\((--[\w-]+)\)$/)) {
    value = theme[ref[1]];
    assert.ok(value, `unresolved ${ref[1]}`);
  }
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    return [0, 2, 4].map((i) => toLinear(parseInt(hex[1].slice(i, i + 2), 16) / 255)) as Rgb;
  }
  const oklch = value.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
  if (oklch) return oklchToLinear(Number(oklch[1]), Number(oklch[2]), Number(oklch[3]));
  throw new Error(`${token}: unsupported color ${value}`);
}

function contrast(theme: Record<string, string>, fg: string, bg: string): number {
  const lum = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const [hi, lo] = [lum(resolve(theme, fg)), lum(resolve(theme, bg))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["--background", "--surface-1", "--surface-2", "--surface-3"];

/** [foreground, backgrounds, minimum ratio] */
const PAIRS: [string, string[], number][] = [
  ["--foreground", SURFACES, 4.5],
  ["--muted-foreground", SURFACES, 4.5],
  ["--destructive", ["--background", "--surface-1"], 4.5],
  ["--warning", ["--background", "--surface-1", "--warning-soft"], 4.5],
  ["--text-quaternary", ["--background", "--surface-1", "--surface-2"], 3],
  ["--warning-foreground", ["--warning"], 4.5],
  ["--medal-gold-foreground", ["--medal-gold"], 4.5],
  ["--medal-silver-foreground", ["--medal-silver"], 4.5],
  ["--medal-bronze-foreground", ["--medal-bronze"], 4.5],
  ["--foreground", ["--medal-gold-soft", "--medal-silver-soft", "--medal-bronze-soft"], 4.5],
  ["--muted-foreground", ["--medal-gold-soft", "--medal-silver-soft", "--medal-bronze-soft"], 4.5],
  ["--secondary-foreground", ["--secondary"], 4.5],
  ["--accent-soft-foreground", ["--accent-soft"], 4.5],
];

for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
  for (const [fg, bgs, min] of PAIRS) {
    for (const bg of bgs) {
      test(`${name}: ${fg} on ${bg} ≥ ${min}:1`, () => {
        const ratio = contrast(theme, fg, bg);
        assert.ok(ratio >= min, `${ratio.toFixed(2)}:1`);
      });
    }
  }
}
