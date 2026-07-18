export interface WindowVisibilityEventSource {
  on(event: 'show' | 'hide', listener: (...args: unknown[]) => void): unknown;
}

export function bindWindowVisibilityRefresh(
  window: WindowVisibilityEventSource,
  refresh: () => void
): void;
