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
}

export type SlideHostMessage = { type: "slide"; payload: SlideViewPayload };

export type SlideWebviewMessage =
  | { type: "ready" }
  | { type: "next" }
  | { type: "back" }
  | { type: "openSource" };
