import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyLibraryControls,
  narrationControl,
  primaryStepNavigationControls,
  stepMenuItems,
} from "../out-test/ux/navigationControls.js";

test("keeps the empty library focused on agent setup", () => {
  assert.deepEqual(
    emptyLibraryControls().map(({ id, label }) => ({ id, label })),
    [{ id: "start", label: "Agent setup" }],
  );
});

test("keeps Back and Next in stable primary navigation slots", () => {
  assert.deepEqual(
    primaryStepNavigationControls(3, 8).map(({ id, className, disabled }) => ({ id, className, disabled })),
    [
      { id: "back", className: "nav-step-button", disabled: false },
      { id: "next", className: "nav-step-button", disabled: false },
    ],
  );
});

test("disables only the unavailable primary navigation direction", () => {
  assert.equal(primaryStepNavigationControls(0, 3)[0].disabled, true);
  assert.equal(primaryStepNavigationControls(0, 3)[1].disabled, false);
  assert.equal(primaryStepNavigationControls(2, 3)[0].disabled, false);
  assert.equal(primaryStepNavigationControls(2, 3)[1].disabled, true);
});

test("names the neighbouring stops in the Back and Next tooltips", () => {
  const [back, next] = primaryStepNavigationControls(1, 3, { previous: "Limits", next: "Startup" });
  assert.equal(back.tooltip, "Previous stop: Limits");
  assert.equal(next.tooltip, "Next stop: Startup");
  const [first] = primaryStepNavigationControls(0, 3, { next: "Startup" });
  assert.equal(first.tooltip, "Previous stop");
});

test("moves the step tools into the menu, with Stop last and set apart", () => {
  const items = stepMenuItems("darwin");
  assert.deepEqual(
    items.map(({ id }) => id),
    ["revealCurrent", "openCurrentSource", "deeper", "exportTour", "present", "autoplay", "openTtsSettings", "stop"],
  );
  const stop = items.at(-1);
  assert.equal(stop.separatorBefore, true);
  assert.equal(stop.destructive, true);
  assert.equal(items.find(({ id }) => id === "openCurrentSource").shortcut, "⌥⌘O");
  assert.equal(stepMenuItems("linux").find(({ id }) => id === "openCurrentSource").shortcut, "Alt+O");
});

test("disables the play button when text to speech is off", () => {
  assert.equal(narrationControl("system").disabled, false);
  const off = narrationControl("off");
  assert.equal(off.disabled, true);
  assert.match(off.tooltip, /Narration settings/);
});

test("on a slide, Back and Next step through beats before stops", () => {
  const [backAtStart, nextAtStart] = primaryStepNavigationControls(0, 1, {}, { position: 0, count: 3 });
  assert.equal(backAtStart.disabled, true);
  assert.equal(nextAtStart.disabled, false);
  assert.equal(nextAtStart.tooltip, "Next beat (1 of 3)");
  const [back, next] = primaryStepNavigationControls(0, 1, {}, { position: 3, count: 3 });
  assert.equal(back.disabled, false);
  assert.equal(back.tooltip, "Previous beat (2 of 3)");
  assert.equal(next.disabled, true);
});
