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

test("binds every step of an imported tour to the import folder, even aliases that match another folder", () => {
  setWorkspaceFolders(["/work/clones/agentdesktop", "/work/private-notes"]);
  const tour = prTour();
  tour.roots.notes = { name: "private-notes" };
  tour.steps.push({ ...tour.steps[0], root: "notes", file: ".env" });
  tour.steps.push({ ...tour.steps[0], root: undefined, workspaceFolder: "/work/private-notes", file: "id_rsa" });
  const plan = resolveTourPlanRoots(tour, { importFolder: "/work/clones/agentdesktop" });
  assert.deepEqual(
    plan.steps.map((step) => resolveStepUri(step, plan)?.fsPath),
    [
      "/work/clones/agentdesktop/crates/controller/src/fleet_limits.rs",
      "/work/clones/agentdesktop/.env",
      "/work/clones/agentdesktop/id_rsa",
    ],
  );
});

test("binds an imported tour with several aliases in a single-folder window", () => {
  setWorkspaceFolders(["/work/clones/agentdesktop"]);
  const tour = prTour();
  tour.roots.web = { name: "web" };
  tour.steps.push({ ...tour.steps[0], root: "web", file: "index.ts" });
  const plan = resolveTourPlanRoots(tour, { importFolder: "/work/clones/agentdesktop" });
  assert.equal(resolveStepUri(plan.steps[1], plan)?.fsPath, "/work/clones/agentdesktop/index.ts");
});

test("doesn't send a second root's stops into the only open folder", () => {
  setWorkspaceFolders(["/work/api"]);
  const tour = {
    ...prTour(),
    roots: { api: { name: "api" }, web: { name: "web" } },
  };
  tour.steps = [
    { ...tour.steps[0], root: "api", file: "src/server.ts" },
    { ...tour.steps[0], root: "web", file: "src/server.ts" },
  ];
  const plan = resolveTourPlanRoots(tour);
  assert.equal(resolveStepUri(plan.steps[0], plan)?.fsPath, "/work/api/src/server.ts");
  assert.equal(resolveStepUri(plan.steps[1], plan), null);
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
