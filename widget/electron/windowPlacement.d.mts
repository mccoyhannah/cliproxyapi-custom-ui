export interface PersistedPlacement {
  x: number;
  y: number;
  displayId: number | null;
}

export interface DisplayWorkArea {
  id: number;
  workArea: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export const DEFAULT_CORNER_MARGIN: number;

export function normalizePersistedPlacement(value: unknown): PersistedPlacement | null;

export function serializePlacement(
  bounds: { x: number; y: number; width: number; height: number },
  displayId?: number | null
): PersistedPlacement;

export function getBottomRightBounds(
  size: { width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number },
  margin?: number
): { x: number; y: number; width: number; height: number };

export function resolveDockDisplay(
  displays: readonly DisplayWorkArea[],
  preferredDisplayId: number | null,
  desiredBounds: { x: number; y: number; width: number; height: number } | null,
  primaryDisplayId: number
): DisplayWorkArea | null;

export function resolveDockedBounds(options: {
  displays: readonly DisplayWorkArea[];
  preferredDisplayId: number | null;
  currentBounds: { x: number; y: number; width: number; height: number };
  primaryDisplayId: number;
  size: { width: number; height: number };
  margin?: number;
}): {
  displayId: number;
  bounds: { x: number; y: number; width: number; height: number };
} | null;

export function boundsEqual(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): boolean;
