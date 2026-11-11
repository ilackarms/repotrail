/**
 * Entry point of the slide webview (`out/slides.js`).
 *
 * In the RepoTrail Slides panel it shows whatever slide and beat the
 * extension posts and forwards navigation keys back to it. Outside VS Code
 * (previews, exports) the same bundle exposes `window.RepoTrailSlides`.
 */

import type { SlideHostMessage, SlideViewPayload, SlideWebviewMessage } from "../../engine/slides/payload";
import { SlideView, slideKey } from "./animate";
import { fitSlide, renderSlide, SLIDE_HEIGHT, SLIDE_WIDTH } from "./render";
import "./slides.css";

interface VsCodeApi {
  postMessage(message: SlideWebviewMessage): void;
}

declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;

const api: VsCodeApi | null = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

(window as unknown as { RepoTrailSlides: object }).RepoTrailSlides = {
  SlideView,
  slideKey,
  renderSlide,
  fitSlide,
  SLIDE_WIDTH,
  SLIDE_HEIGHT,
};

const stage = document.getElementById("stage");
let view: SlideView | null = null;

function show(payload: SlideViewPayload): void {
  if (!stage) return;
  if (view && view.key === slideKey(payload)) {
    view.goTo(payload.position, { animate: payload.position === view.position + 1, motion: payload.motion });
    return;
  }
  view?.dispose();
  view = new SlideView(payload);
  stage.replaceChildren(view.root);
  view.mount();
  place();
  if (payload.motion !== "off") view.root.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
}

/** Scale the fixed canvas to fit the panel, centered. */
function place(): void {
  if (!view) return;
  const scale = Math.min(window.innerWidth / SLIDE_WIDTH, window.innerHeight / SLIDE_HEIGHT);
  const left = (window.innerWidth - SLIDE_WIDTH * scale) / 2;
  const top = (window.innerHeight - SLIDE_HEIGHT * scale) / 2;
  view.root.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
}

if (api && stage) {
  window.addEventListener("message", (event: MessageEvent<SlideHostMessage>) => {
    if (event.data?.type === "slide") show(event.data.payload);
  });
  window.addEventListener("resize", place);
  window.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.shiftKey && event.key === "ArrowRight") {
      event.preventDefault();
      api.postMessage({ type: "nextStop" });
    } else if (["ArrowRight", "PageDown", " "].includes(event.key)) {
      event.preventDefault();
      api.postMessage({ type: "next" });
    } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
      event.preventDefault();
      api.postMessage({ type: "back" });
    }
  });
  api.postMessage({ type: "ready" });
}
