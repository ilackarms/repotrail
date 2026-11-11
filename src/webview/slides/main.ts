/**
 * Entry point of the slide webview (`out/slides.js`).
 *
 * In the RepoTrail Slides panel it shows whatever slide and beat the
 * extension posts and forwards navigation keys back to it. Outside VS Code
 * (previews, exports) the same bundle exposes `window.RepoTrailSlides`.
 */

import type { SlideHostMessage, SlideViewPayload, SlideWebviewMessage } from "../../engine/slides/payload";
import { narrationAt, slideBeats } from "../../engine/slides/timeline";
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
  slideBeats,
  narrationAt,
  renderSlide,
  fitSlide,
  SLIDE_WIDTH,
  SLIDE_HEIGHT,
};

const stage = document.getElementById("stage");
let view: SlideView | null = null;
let status: HTMLElement | null = null;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
let chrome = { presenting: false, autoplay: false };

function show(payload: SlideViewPayload): void {
  if (!stage) return;
  updateStatus(payload);
  if (view && view.key === slideKey(payload)) {
    view.goTo(payload.position, { animate: payload.position === view.position + 1, motion: payload.motion });
    return;
  }
  const previous = view;
  view = new SlideView(payload, { onOpenRef: (ref) => api?.postMessage({ type: "openRef", ref }) });
  // The new slide goes underneath, so the old one can fade out on top of it.
  if (previous) stage.insertBefore(view.root, previous.root);
  else stage.append(view.root);
  view.mount();
  place();
  if (previous && Math.abs(previous.index - payload.index) === 1 && payload.motion !== "off") {
    const fade = view.morphFrom(previous, payload.motion);
    const outgoing = previous;
    outgoing.dispose();
    const animation = outgoing.root.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: fade, easing: "ease-out" });
    if (animation) animation.onfinish = () => outgoing.root.remove();
    else outgoing.root.remove();
  } else {
    previous?.dispose();
    previous?.root.remove();
    if (payload.motion !== "off") view.root.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
  }
}

/** Scale the fixed canvas to fit the panel, centered. */
function place(): void {
  if (!stage) return;
  const scale = Math.min(window.innerWidth / SLIDE_WIDTH, window.innerHeight / SLIDE_HEIGHT);
  const left = (window.innerWidth - SLIDE_WIDTH * scale) / 2;
  const top = (window.innerHeight - SLIDE_HEIGHT * scale) / 2;
  for (const root of stage.querySelectorAll<HTMLElement>(".rt-slide")) {
    root.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
  }
}

/** A pill for present mode and autoplay; the present-mode hint fades after a few seconds. */
function updateStatus(payload: SlideViewPayload): void {
  const next = { presenting: payload.presenting === true, autoplay: payload.autoplay === true };
  if (next.presenting === chrome.presenting && next.autoplay === chrome.autoplay) return;
  chrome = next;
  if (!status) {
    status = document.createElement("div");
    status.className = "rt-panel-status quiet";
    status.setAttribute("aria-live", "polite");
    document.body.append(status);
  }
  clearTimeout(statusTimer);
  if (chrome.autoplay) {
    status.textContent = chrome.presenting ? "▶ Playing · P to stop · Esc to leave present mode" : "▶ Playing · P to stop";
    status.className = "rt-panel-status playing";
  } else if (chrome.presenting) {
    status.textContent = "Presenting · → next · P to play · Esc to leave";
    status.className = "rt-panel-status";
    statusTimer = setTimeout(() => status?.classList.add("quiet"), 3500);
  } else {
    status.className = "rt-panel-status quiet";
  }
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
    } else if (event.key === "p" || event.key === "P") {
      event.preventDefault();
      api.postMessage({ type: "toggleAutoplay" });
    } else if (event.key === "Escape" && chrome.presenting) {
      event.preventDefault();
      api.postMessage({ type: "exitPresent" });
    }
  });
  api.postMessage({ type: "ready" });
}
