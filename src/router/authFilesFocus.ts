export const AUTH_FILES_FOCUS_CARDS_EVENT = 'cpamc:auth-files-focus-cards';
export const AUTH_FILES_FOCUS_CARDS_PATH = '/auth-files?focus=cards';
export const AUTH_FILES_FOCUS_QUERY_KEY = 'focus';
export const AUTH_FILES_FOCUS_CARDS_VALUE = 'cards';
export const AUTH_FILES_FOCUS_CARDS_HEADER_ATTR = 'data-auth-files-focus-cards-header';
export const AUTH_FILES_FOCUS_CARDS_GRID_ATTR = 'data-auth-files-focus-cards-grid';
export const AUTH_FILES_FOCUS_CARDS_HEADER_SELECTOR = `[${AUTH_FILES_FOCUS_CARDS_HEADER_ATTR}="true"]`;
export const AUTH_FILES_FOCUS_CARDS_GRID_SELECTOR = `[${AUTH_FILES_FOCUS_CARDS_GRID_ATTR}="true"]`;

const CARD_FOCUS_BOTTOM_GAP = 8;
const CARD_FOCUS_HEADER_COMFORT_GAP = 28;
const CARD_FOCUS_HEADER_TUCK_LIMIT = 24;
const CARD_FOCUS_PREVIOUS_LINE_CLEARANCE = 2;
const CARD_FOCUS_HEADER_LINE_CLEARANCE = 2;

type AuthFilesFocusLocation = {
  pathname: string;
  search: string;
};

type AuthFilesCardsScrollElements = {
  container: HTMLElement;
  header: HTMLElement;
  grid?: HTMLElement | null;
};

const isHTMLElement = (element: Element | null): element is HTMLElement =>
  typeof HTMLElement !== 'undefined' && element instanceof HTMLElement;

export const isAuthFilesCardsFocusLocation = (location: AuthFilesFocusLocation) =>
  location.pathname === '/auth-files' &&
  new URLSearchParams(location.search).get(AUTH_FILES_FOCUS_QUERY_KEY) ===
    AUTH_FILES_FOCUS_CARDS_VALUE;

export function getAuthFilesCardsScrollTop({
  container,
  header,
  grid,
}: AuthFilesCardsScrollElements): number {
  const containerRect = container.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  const gridRect = (grid ?? header).getBoundingClientRect();
  const previousSectionBottom = (() => {
    let section = header.previousElementSibling;
    let bottom = Number.NEGATIVE_INFINITY;
    while (section) {
      bottom = Math.max(bottom, section.getBoundingClientRect().bottom);
      section = section.previousElementSibling;
    }
    return Number.isFinite(bottom) ? bottom : null;
  })();
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const headerComfortScroll =
    container.scrollTop + headerRect.top - containerRect.top - CARD_FOCUS_HEADER_COMFORT_GAP;
  const gridBottomScroll =
    container.scrollTop +
    gridRect.bottom -
    containerRect.top -
    container.clientHeight +
    CARD_FOCUS_BOTTOM_GAP;
  const verticalSpan = gridRect.bottom - headerRect.top;
  const canPreserveBottomGap =
    Boolean(grid) &&
    verticalSpan + CARD_FOCUS_HEADER_COMFORT_GAP + CARD_FOCUS_BOTTOM_GAP <=
      container.clientHeight;
  const preferredScrollTop = canPreserveBottomGap
    ? Math.max(headerComfortScroll, gridBottomScroll)
    : grid
      ? Math.min(gridBottomScroll, headerComfortScroll + CARD_FOCUS_HEADER_TUCK_LIMIT)
      : headerComfortScroll;
  const previousLineHiddenScroll =
    previousSectionBottom === null
      ? 0
      : container.scrollTop +
        previousSectionBottom -
        containerRect.top +
        CARD_FOCUS_PREVIOUS_LINE_CLEARANCE;
  const headerLineHiddenScroll =
    container.scrollTop + headerRect.top - containerRect.top + CARD_FOCUS_HEADER_LINE_CLEARANCE;

  return Math.max(
    0,
    Math.min(
      maxScrollTop,
      Math.max(preferredScrollTop, previousLineHiddenScroll, headerLineHiddenScroll)
    )
  );
}

export function resolveAuthFilesCardsEnterScrollTop({
  location,
  scrollContainer,
  layerElement,
}: {
  location: AuthFilesFocusLocation;
  scrollContainer: HTMLElement;
  layerElement: HTMLElement;
}): number | null {
  if (!isAuthFilesCardsFocusLocation(location)) return null;

  const header = layerElement.querySelector(AUTH_FILES_FOCUS_CARDS_HEADER_SELECTOR);
  if (!isHTMLElement(header)) return null;

  const grid = layerElement.querySelector(AUTH_FILES_FOCUS_CARDS_GRID_SELECTOR);
  return getAuthFilesCardsScrollTop({
    container: scrollContainer,
    header,
    grid: isHTMLElement(grid) ? grid : null,
  });
}
