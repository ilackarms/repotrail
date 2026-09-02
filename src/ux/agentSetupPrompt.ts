export function composeAgentSetupPrompt(skillText: string, requestText: string): string {
  const skill = skillText.trim();
  if (!skill) throw new Error("The bundled RepoTrail skill is empty.");

  const request = requestText.trim();
  if (!request) throw new Error("The RepoTrail request is empty.");

  return [
    "The complete RepoTrail skill bundled with the installed extension is included below.",
    "If your agent supports persistent skills, install or update it as `repo-trail`. Otherwise, apply it as the active instructions for this request.",
    "Do not fetch another copy; use the bundled version below so the instructions match the installed extension.",
    "",
    "<repo_trail_skill>",
    skill,
    "</repo_trail_skill>",
    "",
    "<repo_trail_request>",
    request,
    "</repo_trail_request>",
  ].join("\n");
}
