import assert from "node:assert/strict";
import { test } from "node:test";
import { repoTourProgressId } from "../out-test/storage/tourStore.js";

test("uses one stable progress id for each repo tour JSON file", () => {
  const source = { rootPath: "/tmp/project", file: "architecture.json" };

  assert.equal(repoTourProgressId(source), repoTourProgressId({ ...source }));
  assert.notEqual(
    repoTourProgressId(source),
    repoTourProgressId({ rootPath: "/tmp/project", file: "request-path.json" }),
  );
  assert.notEqual(
    repoTourProgressId(source),
    repoTourProgressId({ rootPath: "/tmp/other-project", file: "architecture.json" }),
  );
});
