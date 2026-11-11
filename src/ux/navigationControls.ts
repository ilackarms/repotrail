export interface NavigationControl {
  id: string;
  label: string;
  tooltip: string;
  disabled: boolean;
  className?: string;
  secondary?: boolean;
}

/** One entry in the tour's ☰ menu. `id` doubles as the webview message type. */
export interface StepMenuItem {
  id: string;
  label: string;
  /** Keyboard shortcut shown at the right edge, e.g. "⌥⌘O". */
  shortcut?: string;
  /** Draw a separator above this item. */
  separatorBefore?: boolean;
  /** Ends the tour; drawn in the error color. */
  destructive?: boolean;
}

export function emptyLibraryControls(): NavigationControl[] {
  return [
    {
      id: "start",
      label: "Agent setup",
      tooltip: "Copy workspace details and the RepoTrail JSON schema for your agent",
      disabled: false,
    },
  ];
}

/**
 * Back and Next, the only text buttons in the tour toolbar. Their tooltips
 * name the stop they go to when the caller passes the neighbouring titles.
 */
export function primaryStepNavigationControls(
  index: number,
  total: number,
  neighbors: { previous?: string; next?: string } = {},
): NavigationControl[] {
  const hasStops = Number.isFinite(index) && Number.isFinite(total) && total > 0 && index >= 0;
  const atFirstStop = !hasStops || index <= 0;
  const atLastStop = !hasStops || index >= total - 1;

  return [
    {
      id: "back",
      label: "← Back",
      tooltip: !atFirstStop && neighbors.previous ? `Previous stop: ${neighbors.previous}` : "Previous stop",
      disabled: atFirstStop,
      className: "nav-step-button",
    },
    {
      id: "next",
      label: "Next →",
      tooltip: !atLastStop && neighbors.next ? `Next stop: ${neighbors.next}` : "Next stop",
      disabled: atLastStop,
      className: "nav-step-button",
    },
  ];
}

/** The play/pause icon button. The webview swaps its icon as narration plays. */
export function narrationControl(ttsProvider: string): NavigationControl {
  const off = ttsProvider === "off";
  return {
    id: "playPause",
    label: "Read this stop aloud",
    tooltip: off ? "Narration is off. Pick a voice in the ☰ menu under Narration settings." : "Read this stop aloud",
    disabled: off,
    className: "icon-button",
  };
}

/** Everything that used to be a row of buttons under the title. */
export function stepMenuItems(platform: string = process.platform): StepMenuItem[] {
  return [
    { id: "revealCurrent", label: "Jump to step code" },
    { id: "openCurrentSource", label: "Open source file", shortcut: platform === "darwin" ? "⌥⌘O" : "Alt+O" },
    { id: "deeper", label: "Copy deepen prompt" },
    { id: "exportTour", label: "Export tour…" },
    { id: "openTtsSettings", label: "Narration settings…", separatorBefore: true },
    { id: "stop", label: "Stop tour", separatorBefore: true, destructive: true },
  ];
}
