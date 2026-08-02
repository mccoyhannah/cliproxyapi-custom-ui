import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Rectangle } from 'electron';
import type { WidgetPricingOverride, WidgetSettings } from '../src/shared/contracts.js';
import { normalizePersistedPlacement, serializePlacement } from './windowPlacement.mjs';
import type { PersistedPlacement } from './windowPlacement.mjs';

export const COMPACT_WINDOW_SIZE = Object.freeze({ width: 340, height: 190 });
export const EXPANDED_WINDOW_SIZE = Object.freeze({ width: 460, height: 600 });

const MAX_PRICING_OVERRIDES = 100;
const MAX_PATTERN_LENGTH = 160;
const MAX_PRICE_PER_MILLION = 1_000_000;

const DEFAULT_SETTINGS: WidgetSettings = Object.freeze({
  alwaysOnTop: true,
  expanded: false,
  dockToBottomRight: false,
  pricingOverrides: [],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePrice(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  if (value < 0 || value > MAX_PRICE_PER_MILLION) {
    return null;
  }

  return value;
}

function normalizePricingOverride(value: unknown): WidgetPricingOverride | null {
  if (!isRecord(value)) {
    return null;
  }

  const pattern = typeof value.pattern === 'string' ? value.pattern.trim() : '';
  const inputUsdPer1M = normalizePrice(value.inputUsdPer1M);
  const cachedInputUsdPer1M = normalizePrice(value.cachedInputUsdPer1M);
  const outputUsdPer1M = normalizePrice(value.outputUsdPer1M);

  if (
    pattern.length === 0 ||
    pattern.length > MAX_PATTERN_LENGTH ||
    inputUsdPer1M === null ||
    cachedInputUsdPer1M === null ||
    outputUsdPer1M === null
  ) {
    return null;
  }

  return {
    pattern,
    inputUsdPer1M,
    cachedInputUsdPer1M,
    outputUsdPer1M,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
  };
}

export function normalizeWidgetSettings(
  value: unknown,
  fallback: WidgetSettings = DEFAULT_SETTINGS
): WidgetSettings {
  if (!isRecord(value)) {
    return cloneSettings(fallback);
  }

  const pricingOverrides = Array.isArray(value.pricingOverrides)
    ? value.pricingOverrides
        .slice(0, MAX_PRICING_OVERRIDES)
        .map(normalizePricingOverride)
        .filter((override): override is WidgetPricingOverride => override !== null)
    : fallback.pricingOverrides.map((override) => ({ ...override }));

  return {
    alwaysOnTop: typeof value.alwaysOnTop === 'boolean' ? value.alwaysOnTop : fallback.alwaysOnTop,
    expanded: typeof value.expanded === 'boolean' ? value.expanded : fallback.expanded,
    dockToBottomRight:
      typeof value.dockToBottomRight === 'boolean'
        ? value.dockToBottomRight
        : fallback.dockToBottomRight,
    pricingOverrides,
  };
}

export function cloneSettings(settings: WidgetSettings): WidgetSettings {
  return {
    alwaysOnTop: settings.alwaysOnTop,
    expanded: settings.expanded,
    dockToBottomRight: settings.dockToBottomRight,
    pricingOverrides: settings.pricingOverrides.map((override) => ({ ...override })),
  };
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await fs.writeFile(temporaryPath, json, { encoding: 'utf8', flag: 'wx' });

    try {
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
      if (code !== 'EEXIST' && code !== 'EPERM') {
        throw error;
      }

      await fs.rm(filePath, { force: true });
      await fs.rename(temporaryPath, filePath);
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export class WindowStateStore {
  private readonly settingsPath: string;
  private readonly placementPath: string;

  constructor(cacheRoot: string) {
    this.settingsPath = path.join(cacheRoot, 'settings.json');
    this.placementPath = path.join(cacheRoot, 'window-state.json');
  }

  async loadSettings(): Promise<WidgetSettings> {
    return normalizeWidgetSettings(await readJson(this.settingsPath));
  }

  async saveSettings(settings: WidgetSettings): Promise<void> {
    await writeJsonAtomic(this.settingsPath, normalizeWidgetSettings(settings));
  }

  async loadPlacement(): Promise<PersistedPlacement | null> {
    return normalizePersistedPlacement(await readJson(this.placementPath));
  }

  async savePlacement(bounds: Rectangle, displayId: number | null = null): Promise<void> {
    await writeJsonAtomic(this.placementPath, serializePlacement(bounds, displayId));
  }
}

export function clampBoundsToWorkAreas(
  desiredBounds: Rectangle,
  workAreas: readonly Rectangle[]
): Rectangle {
  if (workAreas.length === 0) {
    return desiredBounds;
  }

  const desiredCenterX = desiredBounds.x + desiredBounds.width / 2;
  const desiredCenterY = desiredBounds.y + desiredBounds.height / 2;
  let closestWorkArea = workAreas[0]!;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const workArea of workAreas) {
    const workAreaCenterX = workArea.x + workArea.width / 2;
    const workAreaCenterY = workArea.y + workArea.height / 2;
    const distance =
      Math.abs(desiredCenterX - workAreaCenterX) + Math.abs(desiredCenterY - workAreaCenterY);

    if (distance < closestDistance) {
      closestDistance = distance;
      closestWorkArea = workArea;
    }
  }

  const width = Math.min(desiredBounds.width, closestWorkArea.width);
  const height = Math.min(desiredBounds.height, closestWorkArea.height);
  const maximumX = closestWorkArea.x + closestWorkArea.width - width;
  const maximumY = closestWorkArea.y + closestWorkArea.height - height;

  return {
    x: Math.min(Math.max(desiredBounds.x, closestWorkArea.x), maximumX),
    y: Math.min(Math.max(desiredBounds.y, closestWorkArea.y), maximumY),
    width,
    height,
  };
}
