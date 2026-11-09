import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTourFileTree } from "../out-test/ux/tourFileTree.js";

const entry = (index, file, rootKey = "r", rootLabel = "repo") => ({ index, file, rootKey, rootLabel });

const shape = (nodes) =>
  nodes.map((n) => (n.kind === "file" ? `${n.label}[${n.stops.join(",")}]` : { [n.label]: shape(n.children) }));

test("groups stops by file in a folder tree, folders before files", () => {
  const tree = buildTourFileTree([
    entry(0, "README.md"),
    entry(1, "src/ux/editorActions.ts"),
    entry(2, "src/engine/types.ts"),
    entry(3, "src/ux/editorActions.ts"),
    entry(4, "src/extension.ts"),
  ]);
  assert.deepEqual(shape(tree), [
    { src: [{ engine: ["types.ts[2]"] }, { ux: ["editorActions.ts[1,3]"] }, "extension.ts[4]"] },
    "README.md[0]",
  ]);
});

test("compacts single-child folder chains", () => {
  const tree = buildTourFileTree([entry(0, "pkg/internal/auth/session.go"), entry(1, "pkg/internal/auth/token.go")]);
  assert.deepEqual(shape(tree), [{ "pkg/internal/auth": ["session.go[0]", "token.go[1]"] }]);
});

test("adds a top-level folder per root only when the tour spans several roots", () => {
  const tree = buildTourFileTree([entry(0, "a.ts", "r1", "api"), entry(1, "b.ts", "r2", "web")]);
  assert.deepEqual(shape(tree), [{ api: ["a.ts[0]"] }, { web: ["b.ts[1]"] }]);
});

test("gives files stable ids that include their root", () => {
  const [file] = buildTourFileTree([entry(0, "a.ts", "root-1")]);
  assert.equal(file.id, "file:root-1/a.ts");
  assert.equal(file.file, "a.ts");
});
