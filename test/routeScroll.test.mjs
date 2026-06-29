import assert from "node:assert/strict";
import { test } from "node:test";
import { routeScrollTopForActiveStop } from "../out-test/ux/routeScroll.js";

test("keeps the saved route scroll when the active stop is visible", () => {
  assert.equal(
    routeScrollTopForActiveStop(
      { clientHeight: 120, scrollHeight: 500 },
      { offsetTop: 140, offsetHeight: 24 },
      100,
    ),
    100,
  );
});

test("centers the active stop when saved scroll would hide it below the viewport", () => {
  assert.equal(
    routeScrollTopForActiveStop(
      { clientHeight: 120, scrollHeight: 500 },
      { offsetTop: 300, offsetHeight: 24 },
      100,
    ),
    252,
  );
});

test("centers the active stop when there is no saved route scroll", () => {
  assert.equal(
    routeScrollTopForActiveStop(
      { clientHeight: 120, scrollHeight: 500 },
      { offsetTop: 300, offsetHeight: 24 },
    ),
    252,
  );
});

test("clamps route scroll targets to the scrollable range", () => {
  assert.equal(
    routeScrollTopForActiveStop(
      { clientHeight: 120, scrollHeight: 500 },
      { offsetTop: 490, offsetHeight: 24 },
    ),
    380,
  );
});
