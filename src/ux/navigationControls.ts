export interface NavigationControl {
  id: string;
  label: string;
  tooltip: string;
  disabled: boolean;
  className?: string;
  secondary?: boolean;
}

export function primaryStepNavigationControls(index: number, total: number): NavigationControl[] {
  const hasStops = Number.isFinite(index) && Number.isFinite(total) && total > 0 && index >= 0;
  const atFirstStop = !hasStops || index <= 0;
  const atLastStop = !hasStops || index >= total - 1;

  return [
    {
      id: "back",
      label: "← Back",
      tooltip: "Previous stop",
      disabled: atFirstStop,
      className: "nav-step-button",
    },
    {
      id: "next",
      label: "Next →",
      tooltip: "Next stop",
      disabled: atLastStop,
      className: "nav-step-button",
    },
  ];
}

export function utilityNavigationControls(ttsProvider: string): NavigationControl[] {
  return [
    {
      id: "revealCurrent",
      label: "↩ View",
      tooltip: "Jump back to this step's editor view",
      disabled: false,
    },
    {
      id: "openCurrentSource",
      label: "↗ Source",
      tooltip: "Open this stop in the real editable source file",
      disabled: false,
    },
    {
      id: "deeper",
      label: "📋 Deepen",
      tooltip: "Copy a 'deepen this step' prompt to clipboard for your agent",
      disabled: false,
    },
    {
      id: "stop",
      label: "Stop",
      tooltip: "Stop this tour",
      disabled: false,
    },
    {
      id: "playPause",
      label: "🔊 Speak",
      tooltip: "Read this stop aloud",
      disabled: ttsProvider === "off",
      secondary: true,
    },
    {
      id: "exportTour",
      label: "⤓ Export",
      tooltip: "Export this tour as Markdown, JSON, or save it into the repo",
      disabled: false,
      secondary: true,
    },
  ];
}
