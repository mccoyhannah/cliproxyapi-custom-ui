export function bindWindowVisibilityRefresh(window, refresh) {
  window.on('show', () => refresh());
  window.on('hide', () => refresh());
}
