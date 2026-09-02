import assert from "node:assert/strict";
import { test } from "node:test";
import { primaryStepNavigationControls, utilityNavigationControls } from "../out-test/ux/navigationControls.js";

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

test("keeps utility actions out of the primary Back and Next slots", () => {
  assert.deepEqual(
    utilityNavigationControls("system").map(({ id }) => id),
    ["revealCurrent", "openCurrentSource", "deeper", "stop", "playPause", "exportTour"],
  );
});

test("disables Speak when text to speech is off", () => {
  const speak = utilityNavigationControls("off").find(({ id }) => id === "playPause");
  assert.equal(speak?.disabled, true);
});
