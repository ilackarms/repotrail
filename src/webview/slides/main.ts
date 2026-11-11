/**
 * Entry point of the slide webview (`out/slides.js`).
 *
 * In the RepoTrail Slides panel it renders whatever slide the extension posts
 * and forwards navigation keys back to it. Outside VS Code (previews, exports)
 * the same bundle exposes `window.RepoTrailSlides` for rendering by hand.
 */

import type { SlideHostMessage, SlideViewPayload, SlideWebviewMessage } from "../../engine/slides/payload";
import { fitSlide, renderSlide, SLIDE_HEIGHT, SLIDE_WIDTH } from "./render";
import "./slides.css";

interface VsCodeApi {
  postMessage(message: SlideWebviewMessage): void;
}

declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;

const api: VsCodeApi | null = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

(window as unknown as { RepoTrailSlides: object }).RepoTrailSlides = { renderSlide, fitSlide, SLIDE_WIDTH, SLIDE_HEIGHT };

const stage = document.getElementById("stage");
let current: HTMLElement | null = null;

function show(payload: SlideViewPayload): void {
  if (!stage) return;
  const next = renderSlide(payload);
  stage.replaceChildren(next);
  current = next;
  fitSlide(next);
  place();
}

/** Scale the fixed canvas to fit the panel, centered. */
function place(): void {
  if (!current) return;
  const scale = Math.min(window.innerWidth / SLIDE_WIDTH, window.innerHeight / SLIDE_HEIGHT);
  const left = (window.innerWidth - SLIDE_WIDTH * scale) / 2;
  const top = (window.innerHeight - SLIDE_HEIGHT * scale) / 2;
  current.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
}

if (api && stage) {
  window.addEventListener("message", (event: MessageEvent<SlideHostMessage>) => {
    if (event.data?.type === "slide") show(event.data.payload);
  });
  window.addEventListener("resize", place);
  window.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (["ArrowRight", "PageDown", " "].includes(event.key)) {
      event.preventDefault();
      api.postMessage({ type: "next" });
    } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
      event.preventDefault();
      api.postMessage({ type: "back" });
    }
  });
  api.postMessage({ type: "ready" });
}
