/// <reference types="vite/client" />

import type { WidgetApi } from './shared/contracts';

declare global {
  interface Window {
    cpaWidget?: WidgetApi;
  }
}

export {};
