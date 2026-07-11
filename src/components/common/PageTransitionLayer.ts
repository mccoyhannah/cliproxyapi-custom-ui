import { createContext, useContext } from 'react';
import type { NavigationType } from 'react-router-dom';

export type LayerStatus = 'current' | 'exiting' | 'stacked';

export type PageTransitionLayerContextValue = {
  status: LayerStatus;
  isCurrentLayer: boolean;
  isAnimating: boolean;
  navigationType: NavigationType;
};

export const PageTransitionLayerContext =
  createContext<PageTransitionLayerContextValue | null>(null);

export const PAGE_TRANSITION_LAYER_CONTEXT_VALUES: Record<
  LayerStatus,
  Omit<PageTransitionLayerContextValue, 'navigationType'>
> = {
  current: { status: 'current', isCurrentLayer: true, isAnimating: false },
  stacked: { status: 'stacked', isCurrentLayer: false, isAnimating: false },
  exiting: { status: 'exiting', isCurrentLayer: false, isAnimating: false },
};

export function usePageTransitionLayer() {
  return useContext(PageTransitionLayerContext);
}
