import { test } from "node:test";
import assert from "node:assert/strict";
import { cn } from "./utils.ts";

test("cn keeps a type role next to a text color", () => {
  assert.equal(cn("text-body", "text-muted-foreground"), "text-body text-muted-foreground");
});

test("cn lets a later type role win over an earlier one", () => {
  assert.equal(cn("text-body text-foreground", "text-footnote"), "text-foreground text-footnote");
});
