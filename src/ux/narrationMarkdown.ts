// The renderer lives in the engine so the command line's static pages can use
// it too; the sidebar and slide webview import it from here.
export { renderNarrationMarkdown } from "../engine/narrationMarkdown";
