const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

export const DEFAULT_CORNER_MARGIN = 12;

const isValidDisplayId = (value) => Number.isSafeInteger(value) && value >= 0;

export const normalizePersistedPlacement = (value) => {
  if (
    !value ||
    typeof value !== 'object' ||
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y)
  ) {
    return null;
  }

  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
    displayId: isValidDisplayId(value.displayId) ? value.displayId : null,
  };
};

export const serializePlacement = (bounds, displayId = null) => ({
  x: Math.round(bounds.x),
  y: Math.round(bounds.y),
  displayId: isValidDisplayId(displayId) ? displayId : null,
});

export const getBottomRightBounds = (size, workArea, margin = DEFAULT_CORNER_MARGIN) => {
  const safeMargin = Math.max(0, Math.round(margin));
  const width = Math.min(size.width, Math.max(1, workArea.width - safeMargin * 2));
  const height = Math.min(size.height, Math.max(1, workArea.height - safeMargin * 2));
  return {
    x: workArea.x + workArea.width - width - safeMargin,
    y: workArea.y + workArea.height - height - safeMargin,
    width,
    height,
  };
};

const centerOf = (bounds) => ({
  x: bounds.x + bounds.width / 2,
  y: bounds.y + bounds.height / 2,
});

const squaredDistance = (left, right) =>
  (left.x - right.x) ** 2 + (left.y - right.y) ** 2;

export const resolveDockDisplay = (displays, preferredDisplayId, desiredBounds, primaryDisplayId) => {
  if (!Array.isArray(displays) || displays.length === 0) return null;

  const preferred = displays.find((display) => display.id === preferredDisplayId);
  if (preferred) return preferred;

  const primary = displays.find((display) => display.id === primaryDisplayId);
  if (!desiredBounds || !isFiniteNumber(desiredBounds.x) || !isFiniteNumber(desiredBounds.y)) {
    return primary ?? displays[0];
  }

  const desiredCenter = centerOf(desiredBounds);
  return displays.reduce((closest, candidate) => {
    if (!closest) return candidate;
    const candidateCenter = centerOf(candidate.workArea);
    const closestCenter = centerOf(closest.workArea);
    return squaredDistance(desiredCenter, candidateCenter) <
      squaredDistance(desiredCenter, closestCenter)
      ? candidate
      : closest;
  }, null);
};

export const resolveDockedBounds = ({
  displays,
  preferredDisplayId,
  currentBounds,
  primaryDisplayId,
  size,
  margin = DEFAULT_CORNER_MARGIN,
}) => {
  const display = resolveDockDisplay(
    displays,
    preferredDisplayId,
    currentBounds,
    primaryDisplayId
  );
  if (!display) return null;

  return {
    displayId: display.id,
    bounds: getBottomRightBounds(size, display.workArea, margin),
  };
};

export const boundsEqual = (left, right) =>
  left.x === right.x &&
  left.y === right.y &&
  left.width === right.width &&
  left.height === right.height;
