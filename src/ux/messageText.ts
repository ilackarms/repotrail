/**
 * VS Code turns `[label](command:…)`, `(https://…)` and `(file:…)` links in
 * extension notifications into clickable links, and runs command links with
 * their arguments. Tour titles, roots and paths can come from a PR comment, so
 * any of them shown in a notification goes through plainMessageText first.
 */
export function plainMessageText(text: string, maxLength = 200): string {
  const flat = text.replace(/[\r\n\t]+/g, " ").replace(/\]\(/g, "] (");
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}
