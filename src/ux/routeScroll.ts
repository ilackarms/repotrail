export interface RouteScrollContainer {
  clientHeight: number;
  scrollHeight: number;
}

export interface RouteStopMetrics {
  offsetTop: number;
  offsetHeight: number;
}

export interface RouteScrollViewportMetrics {
  top: number;
  scrollTop: number;
}

export interface RouteStopViewportMetrics {
  top: number;
  height: number;
}

export function routeStopMetricsFromViewport(
  container: RouteScrollViewportMetrics,
  active: RouteStopViewportMetrics,
): RouteStopMetrics {
  return {
    offsetTop: active.top - container.top + container.scrollTop,
    offsetHeight: active.height,
  };
}

export function routeScrollTopForActiveStop(
  container: RouteScrollContainer,
  active: RouteStopMetrics,
  savedScrollTop?: number,
): number {
  const maxScrollTop = maxRouteScrollTop(container);
  const current = isFiniteNumber(savedScrollTop)
    ? clamp(savedScrollTop, 0, maxScrollTop)
    : null;
  if (current !== null && isActiveStopVisible(container, active, current)) return current;
  const centered = active.offsetTop - Math.max(0, Math.floor((container.clientHeight - active.offsetHeight) / 2));
  return clamp(centered, 0, maxScrollTop);
}

function isActiveStopVisible(
  container: RouteScrollContainer,
  active: RouteStopMetrics,
  scrollTop: number,
): boolean {
  const top = active.offsetTop;
  const bottom = active.offsetTop + active.offsetHeight;
  return top >= scrollTop && bottom <= scrollTop + container.clientHeight;
}

function maxRouteScrollTop(container: RouteScrollContainer): number {
  return Math.max(0, container.scrollHeight - container.clientHeight);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
