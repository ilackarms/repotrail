import assert from "node:assert/strict";
import { test } from "node:test";
import { composeAgentSetupPrompt } from "../out-test/ux/agentSetupPrompt.js";

test("embeds the canonical skill before the workspace-specific request", () => {
  const prompt = composeAgentSetupPrompt(
    "---\nname: repo-trail\n---\n\n# RepoTrail Agent Skill\n",
    "Create a tour for /tmp/project.",
  );

  assert.match(prompt, /complete RepoTrail skill bundled with the installed extension/);
  assert.match(prompt, /install or update it as `repo-trail`/);
  assert.match(prompt, /<repo_trail_skill>[\s\S]*name: repo-trail[\s\S]*<\/repo_trail_skill>/);
  assert.match(prompt, /<repo_trail_request>[\s\S]*Create a tour for \/tmp\/project\.[\s\S]*<\/repo_trail_request>/);
  assert.ok(prompt.indexOf("<repo_trail_skill>") < prompt.indexOf("<repo_trail_request>"));
});

test("rejects an empty bundled skill", () => {
  assert.throws(
    () => composeAgentSetupPrompt("  ", "Create a tour."),
    /bundled RepoTrail skill is empty/,
  );
});
