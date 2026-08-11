export type AccountMemoLoginScreenBounds = {
  availWidth: number;
  availHeight: number;
  availLeft?: number;
  availTop?: number;
};

export type AccountMemoLoginPopupRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type AccountMemoLoginWorkspaceLayout = {
  tiled: boolean;
  gap: number;
  leftVisibleWidth: number;
  popup: AccountMemoLoginPopupRect;
  features: string;
};

const WORKSPACE_GAP = 12;
const MIN_TILED_SCREEN_WIDTH = 1100;
const COPY_PANEL_WIDTH = 440;
const MIN_LOGIN_POPUP_WIDTH = 620;
const MAX_LOGIN_POPUP_WIDTH = 1280;

const toSafeInteger = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max));

export const createAccountMemoLoginWorkspaceLayout = (
  screenBounds: AccountMemoLoginScreenBounds
): AccountMemoLoginWorkspaceLayout => {
  const availWidth = Math.max(640, toSafeInteger(screenBounds.availWidth, 1280));
  const availHeight = Math.max(480, toSafeInteger(screenBounds.availHeight, 720));
  const availLeft = toSafeInteger(screenBounds.availLeft, 0);
  const availTop = toSafeInteger(screenBounds.availTop, 0);
  const tiled = availWidth >= MIN_TILED_SCREEN_WIDTH;

  const leftVisibleWidth = tiled
    ? clamp(COPY_PANEL_WIDTH, 360, Math.floor(availWidth * 0.42))
    : 0;
  const maxPopupWidth = Math.max(
    MIN_LOGIN_POPUP_WIDTH,
    availWidth - (tiled ? leftVisibleWidth + WORKSPACE_GAP * 3 : WORKSPACE_GAP * 2)
  );
  const width = tiled
    ? clamp(maxPopupWidth, MIN_LOGIN_POPUP_WIDTH, MAX_LOGIN_POPUP_WIDTH)
    : Math.max(320, availWidth - WORKSPACE_GAP * 2);
  const height = Math.max(440, availHeight - WORKSPACE_GAP * 2);
  const left = availLeft + Math.max(WORKSPACE_GAP, availWidth - width - WORKSPACE_GAP);
  const top = availTop + WORKSPACE_GAP;
  const popup = { left, top, width, height };
  const features = [
    'popup=yes',
    `left=${popup.left}`,
    `top=${popup.top}`,
    `width=${popup.width}`,
    `height=${popup.height}`,
    'resizable=yes',
    'scrollbars=yes',
  ].join(',');

  return {
    tiled,
    gap: WORKSPACE_GAP,
    leftVisibleWidth,
    popup,
    features,
  };
};
