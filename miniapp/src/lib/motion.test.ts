import { test } from "node:test";
import assert from "node:assert/strict";
import { SWIPE_DISTANCE, SWIPE_VELOCITY, swipeDirection } from "./motion.ts";
import { didIgnite, observeTier, streakTier } from "./streakTier.ts";

test("a short, slow drag stays on the month", () => {
  assert.equal(swipeDirection(SWIPE_DISTANCE - 1, SWIPE_VELOCITY - 1), 0);
  assert.equal(swipeDirection(-(SWIPE_DISTANCE - 1), 0), 0);
});

test("swiping left pages forward, swiping right pages back", () => {
  assert.equal(swipeDirection(-SWIPE_DISTANCE, 0), 1);
  assert.equal(swipeDirection(SWIPE_DISTANCE, 0), -1);
});

test("a fast flick pages even when short, and its velocity decides the way", () => {
  assert.equal(swipeDirection(-10, -SWIPE_VELOCITY), 1);
  // Dragged right, then flicked back left: the flick wins.
  assert.equal(swipeDirection(80, -SWIPE_VELOCITY - 100), 1);
});

test("streak tiers: 7 days or 4 weeks is hot", () => {
  assert.equal(streakTier(0, "days"), "unlit");
  assert.equal(streakTier(6, "days"), "lit");
  assert.equal(streakTier(7, "days"), "hot");
  assert.equal(streakTier(3, "weeks"), "lit");
  assert.equal(streakTier(4, "weeks"), "hot");
});

test("ignition is the seen move into hot, not a first sighting or staying hot", () => {
  assert.equal(didIgnite(undefined, "hot"), false);
  assert.equal(didIgnite("lit", "hot"), true);
  assert.equal(didIgnite("unlit", "hot"), true);
  assert.equal(didIgnite("hot", "hot"), false);
  assert.equal(didIgnite("lit", "lit"), false);
});

test("observeTier remembers the last tier per streak", () => {
  assert.equal(observeTier("r-1", "lit"), false);
  assert.equal(observeTier("r-1", "hot"), true);
  assert.equal(observeTier("r-1", "hot"), false);
  assert.equal(observeTier("r-2", "hot"), false);
});
