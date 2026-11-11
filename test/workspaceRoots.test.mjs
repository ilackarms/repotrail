import assert from "node:assert/strict";
import { test } from "node:test";
import { setWorkspaceFolders } from "./vscodeStub.mjs";

const { resolveStepUri, resolveTourPlanRoots } = await import("../out-test/workspace.js");

// Same shape as a PR review tour: one root alias whose name/pathHint is the
// folder the author happened to use, which reviewers rarely share.
function prTour() {
  return {
    kind: "pr-diff",
    title: "PR tour",
    summary: "",
    roots: { pr: { name: "agentdesktop-pr-237", pathHint: "agentdesktop-pr-237" } },
    steps: [
      {
        root: "pr",
        file: "crates/controller/src/fleet_limits.rs",
        title: "Limits",
        explanation: "",
        actions: ["showDiff", "showNarration"],
        viewMode: "diff",
        diff: { baseRef: "a".repeat(40), headRef: "b".repeat(40), scope: "file" },
      },
    ],
  };
}

test("binds an unresolved root alias to the only open folder", () => {
  setWorkspaceFolders(["/work/clones/agentdesktop"]);
  const plan = resolveTourPlanRoots(prTour());
  const uri = resolveStepUri(plan.steps[0], plan);
  assert.equal(uri?.fsPath, "/work/clones/agentdesktop/crates/controller/src/fleet_limits.rs");
});

test("still resolves a root alias that names the only open folder", () => {
  setWorkspaceFolders(["/tmp/review/agentdesktop-pr-237"]);
  const plan = resolveTourPlanRoots(prTour());
  const uri = resolveStepUri(plan.steps[0], plan);
  assert.equal(uri?.fsPath, "/tmp/review/agentdesktop-pr-237/crates/controller/src/fleet_limits.rs");
});

test("leaves an unresolved alias unresolved in a multi-root window", () => {
  setWorkspaceFolders(["/work/clones/agentdesktop", "/work/clones/other"]);
  const plan = resolveTourPlanRoots(prTour());
  assert.equal(resolveStepUri(plan.steps[0], plan), null);
});

test("binds unresolved aliases to the import folder in a multi-root window", () => {
  setWorkspaceFolders(["/work/clones/other", "/work/clones/agentdesktop"]);
  const plan = resolveTourPlanRoots(prTour(), { importFolder: "/work/clones/agentdesktop" });
  assert.equal(plan.steps[0].workspaceFolder, "agentdesktop");
  assert.equal(
    resolveStepUri(plan.steps[0], plan)?.fsPath,
    "/work/clones/agentdesktop/crates/controller/src/fleet_limits.rs",
  );
});

test("keeps aliases that resolve in a multi-root window even with an import folder", () => {
  setWorkspaceFolders(["/work/clones/agentdesktop", "/tmp/review/agentdesktop-pr-237"]);
  const plan = resolveTourPlanRoots(prTour(), { importFolder: "/work/clones/agentdesktop" });
  assert.equal(
    resolveStepUri(plan.steps[0], plan)?.fsPath,
    "/tmp/review/agentdesktop-pr-237/crates/controller/src/fleet_limits.rs",
  );
});

test("binds steps without a root to the import folder instead of the first folder", () => {
  setWorkspaceFolders(["/work/clones/other", "/work/clones/agentdesktop"]);
  const tour = prTour();
  delete tour.roots;
  delete tour.steps[0].root;
  const plan = resolveTourPlanRoots(tour, { importFolder: "/work/clones/agentdesktop" });
  assert.equal(
    resolveStepUri(plan.steps[0], plan)?.fsPath,
    "/work/clones/agentdesktop/crates/controller/src/fleet_limits.rs",
  );
});

test("ignores an import folder that is not open", () => {
  setWorkspaceFolders(["/work/clones/agentdesktop", "/work/clones/other"]);
  const plan = resolveTourPlanRoots(prTour(), { importFolder: "/elsewhere/agentdesktop" });
  assert.equal(resolveStepUri(plan.steps[0], plan), null);
});

test("falls back to the only open folder for a stale legacy workspaceFolder", () => {
  setWorkspaceFolders(["/work/clones/agentdesktop"]);
  const tour = prTour();
  delete tour.steps[0].root;
  tour.steps[0].workspaceFolder = "agentdesktop-pr-237";
  const uri = resolveStepUri(tour.steps[0], tour);
  assert.equal(uri?.fsPath, "/work/clones/agentdesktop/crates/controller/src/fleet_limits.rs");
});
