/** Messages between the extension host and the slide webview. Pure types. */

import type { TourSlide } from "../types";

export interface SlideViewPayload {
  title: string;
  slide: TourSlide;
  /** 0-based position of the stop in the tour. */
  index: number;
  total: number;
  /** Display path of the slide's source, when it has one. */
  source?: string;
  /** 0 before any beat; k after beat k. */
  position: number;
  motion: SlideMotion;
  /** Show the current beat's narration on the slide. */
  captions: boolean;
  /** Present mode is on (panel chrome only). */
  presenting?: boolean;
  /** Autoplay is running (panel chrome only). */
  autoplay?: boolean;
}

/** `full` animates; `reduced` only fades; `off` changes instantly. */
export type SlideMotion = "full" | "reduced" | "off";

export type SlideHostMessage = { type: "slide"; payload: SlideViewPayload };

export type SlideWebviewMessage =
  | { type: "ready" }
  | { type: "next" }
  | { type: "back" }
  | { type: "nextStop" }
  | { type: "exitPresent" }
  | { type: "toggleAutoplay" }
  | { type: "openRef"; ref: unknown }
  | { type: "openSource" };
