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

test("moves the step tools into the menu, with Close last and set apart", () => {
  const items = stepMenuItems("darwin");
  assert.deepEqual(
    items.map(({ id }) => id),
    ["revealCurrent", "openCurrentSource", "deeper", "exportTour", "openTtsSettings", "stop"],
  );
  const close = items.at(-1);
  assert.equal(close.label, "Close tour");
  assert.equal(close.separatorBefore, true);
  assert.equal(close.destructive, undefined);
  assert.equal(items.find(({ id }) => id === "openCurrentSource").shortcut, "⌥⌘O");
  assert.equal(stepMenuItems("linux").find(({ id }) => id === "openCurrentSource").shortcut, "Alt+O");
});

test("offers Comment on PR only for tours of a change", () => {
  const ids = (options) => stepMenuItems("darwin", options).map(({ id }) => id);
  assert.equal(ids().includes("commentOnPr"), false);
  assert.deepEqual(ids({ prComments: true }).slice(0, 4), ["revealCurrent", "openCurrentSource", "commentOnPr", "deeper"]);
});

test("disables the play button when text to speech is off", () => {
  assert.equal(narrationControl("system").disabled, false);
  const off = narrationControl("off");
  assert.equal(off.disabled, true);
  assert.match(off.tooltip, /Narration settings/);
});

test("offers Delete tour, in the error color, only for tours saved in .repotrail/", () => {
  assert.equal(stepMenuItems("darwin").some(({ id }) => id === "deleteTour"), false);
  const items = stepMenuItems("darwin", { deleteTour: true });
  assert.deepEqual(items.slice(-2).map(({ id }) => id), ["stop", "deleteTour"]);
  assert.equal(items.at(-1).destructive, true);
});
