import { ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, type Location } from 'react-router-dom';
import { animate } from 'motion/mini';
import type { AnimationPlaybackControlsWithThen } from 'motion-dom';
import {
  PAGE_TRANSITION_LAYER_CONTEXT_VALUES,
  PageTransitionLayerContext,
  type LayerStatus,
} from './PageTransitionLayer';
import './PageTransition.scss';

interface PageTransitionProps {
  render: (location: Location) => ReactNode;
  getRouteOrder?: (pathname: string) => number | null;
  getTransitionVariant?: (fromPathname: string, toPathname: string) => TransitionVariant;
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
  resolveEnterScrollTop?: (context: {
    location: Location;
    scrollContainer: HTMLElement;
    layerElement: HTMLElement;
    defaultScrollTop: number;
  }) => number | null | undefined;
}

const VERTICAL_TRANSITION_DURATION = 0.4;
const VERTICAL_TRAVEL_DISTANCE = 40;
const REDUCED_MOTION_DURATION = 0.15;
const IOS_TRANSITION_DURATION = 0.45;
const IOS_ENTER_FROM_X_PERCENT = 100;
const IOS_EXIT_TO_X_PERCENT_FORWARD = -30;
const IOS_EXIT_TO_X_PERCENT_BACKWARD = 100;
const IOS_ENTER_FROM_X_PERCENT_BACKWARD = -30;
const IOS_EXIT_DIM_OPACITY = 0.72;
const IOS_SHADOW_VALUE = '-14px 0 24px rgba(0, 0, 0, 0.16)';

const easePower2Out = (progress: number) => 1 - (1 - progress) ** 3;

// Use a smoother cubic bezier for modern transitions
const easeCircOut: [number, number, number, number] = [0.25, 1, 0.5, 1]; // standard spring-like deceleration

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const buildVerticalTransform = (y: number, scale: number = 1) =>
  `translate3d(0px, ${y}px, 0px) scale(${scale})`;
const buildIosTransform = (xPercent: number, y: number) => `translate3d(${xPercent}%, ${y}px, 0px)`;

const clearLayerStyles = (element: HTMLElement | null) => {
  if (!element) return;
  element.style.removeProperty('transform');
  element.style.removeProperty('opacity');
  element.style.removeProperty('box-shadow');
};

type Layer = {
  key: string;
  location: Location;
  status: LayerStatus;
};

type TransitionDirection = 'forward' | 'backward';

type TransitionVariant = 'vertical' | 'ios';

const buildLayerKey = (location: Location) =>
  `${location.key}:${location.pathname}${location.search}${location.hash}`;

const buildRouteIdentity = (location: Location) =>
  `${location.pathname}${location.search}${location.hash}`;

export function PageTransition({
  render,
  getRouteOrder,
  getTransitionVariant,
  scrollContainerRef,
  resolveEnterScrollTop,
}: PageTransitionProps) {
  const location = useLocation();
  const currentLayerRef = useRef<HTMLDivElement>(null);
  const exitingLayerRef = useRef<HTMLDivElement>(null);
  const transitionDirectionRef = useRef<TransitionDirection>('forward');
  const transitionVariantRef = useRef<TransitionVariant>('vertical');
  const exitScrollOffsetRef = useRef(0);
  const enterScrollOffsetRef = useRef(0);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const nextLayersRef = useRef<Layer[] | null>(null);

  const [isAnimating, setIsAnimating] = useState(false);
  const [layers, setLayers] = useState<Layer[]>(() => [
    {
      key: buildLayerKey(location),
      location,
      status: 'current',
    },
  ]);
  const locationLayerKey = buildLayerKey(location);
  const locationRouteIdentity = buildRouteIdentity(location);
  const currentLayer =
    layers.find((layer) => layer.status === 'current') ?? layers[layers.length - 1];
  const currentLayerLocation = currentLayer?.location;
  const currentLayerKey = currentLayer?.key ?? locationLayerKey;
  const currentLayerPathname = currentLayer?.location.pathname;
  const currentLayerRouteIdentity = currentLayer
    ? buildRouteIdentity(currentLayer.location)
    : locationRouteIdentity;

  const resolveScrollContainer = useCallback(() => {
    if (scrollContainerRef?.current) return scrollContainerRef.current;
    if (typeof document === 'undefined') return null;
    return document.scrollingElement as HTMLElement | null;
  }, [scrollContainerRef]);

  useLayoutEffect(() => {
    if (isAnimating) return;
    if (locationLayerKey === currentLayerKey) return;
    if (currentLayerRouteIdentity === locationRouteIdentity) return;
    const scrollContainer = resolveScrollContainer();
    const exitScrollOffset = scrollContainer?.scrollTop ?? 0;
    exitScrollOffsetRef.current = exitScrollOffset;
    scrollPositionsRef.current.set(currentLayerKey, exitScrollOffset);

    enterScrollOffsetRef.current = scrollPositionsRef.current.get(locationLayerKey) ?? 0;
    const resolveOrderIndex = (pathname?: string) => {
      if (!getRouteOrder || !pathname) return null;
      const index = getRouteOrder(pathname);
      return typeof index === 'number' && index >= 0 ? index : null;
    };
    const fromIndex = resolveOrderIndex(currentLayerPathname);
    const toIndex = resolveOrderIndex(location.pathname);
    const nextVariant: TransitionVariant = getTransitionVariant
      ? getTransitionVariant(currentLayerPathname ?? '', location.pathname)
      : 'vertical';

    let nextDirection: TransitionDirection =
      fromIndex === null || toIndex === null || fromIndex === toIndex
        ? 'forward'
        : toIndex > fromIndex
          ? 'forward'
          : 'backward';

    // When using iOS-style stacking, history POP within the same "section" can have equal route order.
    // In that case, prefer treating navigation to an existing layer as a backward (pop) transition.
    if (nextVariant === 'ios' && layers.some((layer) => layer.key === locationLayerKey)) {
      nextDirection = 'backward';
    }

    transitionDirectionRef.current = nextDirection;
    transitionVariantRef.current = nextVariant;

    const shouldSkipExitLayer = (() => {
      if (nextVariant !== 'ios' || nextDirection !== 'backward') return false;
      const normalizeSegments = (pathname: string) =>
        pathname
          .split('/')
          .filter(Boolean)
          .filter((segment) => segment.length > 0);
      const fromSegments = normalizeSegments(currentLayerPathname ?? '');
      const toSegments = normalizeSegments(location.pathname);
      if (!fromSegments.length || !toSegments.length) return false;
      return fromSegments[0] === toSegments[0] && toSegments.length === 1;
    })();

    setLayers((prev) => {
      const variant = transitionVariantRef.current;
      const direction = transitionDirectionRef.current;
      const previousCurrentIndex = prev.findIndex((layer) => layer.status === 'current');
      const resolvedCurrentIndex =
        previousCurrentIndex >= 0 ? previousCurrentIndex : prev.length - 1;
      const previousCurrent = prev[resolvedCurrentIndex];
      const previousStack: Layer[] = prev
        .filter((_, idx) => idx !== resolvedCurrentIndex)
        .map((layer): Layer => ({ ...layer, status: 'stacked' }));

      const nextCurrent: Layer = { key: locationLayerKey, location, status: 'current' };

      if (!previousCurrent) {
        nextLayersRef.current = [nextCurrent];
        return [nextCurrent];
      }

      if (variant === 'ios') {
        if (direction === 'forward') {
          const exitingLayer: Layer = { ...previousCurrent, status: 'exiting' };
          const stackedLayer: Layer = { ...previousCurrent, status: 'stacked' };

          nextLayersRef.current = [...previousStack, stackedLayer, nextCurrent];
          return [...previousStack, exitingLayer, nextCurrent];
        }

        const targetIndex = prev.findIndex((layer) => layer.key === locationLayerKey);
        if (targetIndex !== -1) {
          const targetStack: Layer[] = prev.slice(0, targetIndex + 1).map((layer, idx): Layer => {
            const isTarget = idx === targetIndex;
            return {
              ...layer,
              location: isTarget ? location : layer.location,
              status: isTarget ? 'current' : 'stacked',
            };
          });

          if (shouldSkipExitLayer) {
            nextLayersRef.current = targetStack;
            return targetStack;
          }

          const exitingLayer: Layer = { ...previousCurrent, status: 'exiting' };
          nextLayersRef.current = targetStack;
          return [...targetStack, exitingLayer];
        }
      }

      if (shouldSkipExitLayer) {
        nextLayersRef.current = [nextCurrent];
        return [nextCurrent];
      }

      const exitingLayer: Layer = { ...previousCurrent, status: 'exiting' };

      nextLayersRef.current = [nextCurrent];
      return [exitingLayer, nextCurrent];
    });
    setIsAnimating(true);
  }, [
    isAnimating,
    location,
    locationLayerKey,
    locationRouteIdentity,
    currentLayerKey,
    currentLayerPathname,
    currentLayerRouteIdentity,
    getRouteOrder,
    getTransitionVariant,
    resolveScrollContainer,
    layers,
  ]);

  // Run Motion animation when animating starts
  useLayoutEffect(() => {
    if (!isAnimating) return;

    if (!currentLayerRef.current) return;

    const currentLayerEl = currentLayerRef.current;
    const exitingLayerEl = exitingLayerRef.current;
    const transitionVariant = transitionVariantRef.current;

    clearLayerStyles(currentLayerEl);
    clearLayerStyles(exitingLayerEl);

    const scrollContainer = resolveScrollContainer();
    const exitScrollOffset = exitScrollOffsetRef.current;
    let enterScrollOffset = enterScrollOffsetRef.current;
    if (scrollContainer && currentLayerLocation) {
      const resolvedEnterScrollTop = resolveEnterScrollTop?.({
        location: currentLayerLocation,
        scrollContainer,
        layerElement: currentLayerEl,
        defaultScrollTop: enterScrollOffset,
      });
      if (typeof resolvedEnterScrollTop === 'number' && Number.isFinite(resolvedEnterScrollTop)) {
        const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        enterScrollOffset = Math.max(0, Math.min(maxScrollTop, resolvedEnterScrollTop));
        enterScrollOffsetRef.current = enterScrollOffset;
        scrollPositionsRef.current.set(currentLayerKey, enterScrollOffset);
      }
    }
    if (scrollContainer && exitScrollOffset !== enterScrollOffset) {
      scrollContainer.scrollTo({ top: enterScrollOffset, left: 0, behavior: 'auto' });
    }

    const transitionDirection = transitionDirectionRef.current;
    const isForward = transitionDirection === 'forward';
    const enterFromY = isForward ? VERTICAL_TRAVEL_DISTANCE : -VERTICAL_TRAVEL_DISTANCE;
    const exitToY = isForward ? -VERTICAL_TRAVEL_DISTANCE : VERTICAL_TRAVEL_DISTANCE;
    const exitBaseY = enterScrollOffset - exitScrollOffset;
    const reduceMotion = prefersReducedMotion();
    const activeAnimations: AnimationPlaybackControlsWithThen[] = [];
    let cancelled = false;
    let completed = false;
    const completeTransition = () => {
      if (completed) return;
      completed = true;

      const nextLayers = nextLayersRef.current;
      nextLayersRef.current = null;
      setLayers((prev) => nextLayers ?? prev.filter((layer) => layer.status !== 'exiting'));
      setIsAnimating(false);

      clearLayerStyles(currentLayerEl);
      clearLayerStyles(exitingLayerEl);
    };

    if (reduceMotion) {
      if (exitingLayerEl) {
        exitingLayerEl.style.transform =
          transitionVariant === 'ios'
            ? buildIosTransform(0, exitBaseY)
            : buildVerticalTransform(exitBaseY, 1);
        activeAnimations.push(
          animate(
            exitingLayerEl,
            { opacity: [1, 0] },
            { duration: REDUCED_MOTION_DURATION, ease: easePower2Out }
          )
        );
      }

      currentLayerEl.style.opacity = '0';
      currentLayerEl.style.transform =
        transitionVariant === 'ios' ? buildIosTransform(0, 0) : buildVerticalTransform(0, 1);
      activeAnimations.push(
        animate(
          currentLayerEl,
          { opacity: [0, 1] },
          { duration: REDUCED_MOTION_DURATION, ease: easePower2Out }
        )
      );
    } else if (transitionVariant === 'ios') {
      const exitToXPercent = isForward
        ? IOS_EXIT_TO_X_PERCENT_FORWARD
        : IOS_EXIT_TO_X_PERCENT_BACKWARD;
      const enterFromXPercent = isForward
        ? IOS_ENTER_FROM_X_PERCENT
        : IOS_ENTER_FROM_X_PERCENT_BACKWARD;

      if (exitingLayerEl) {
        exitingLayerEl.style.transform = buildIosTransform(0, exitBaseY);
        exitingLayerEl.style.opacity = '1';
      }

      currentLayerEl.style.transform = buildIosTransform(enterFromXPercent, 0);
      currentLayerEl.style.opacity = '1';

      const topLayerEl = isForward ? currentLayerEl : exitingLayerEl;
      if (topLayerEl) {
        topLayerEl.style.boxShadow = IOS_SHADOW_VALUE;
      }

      if (exitingLayerEl) {
        activeAnimations.push(
          animate(
            exitingLayerEl,
            {
              transform: [
                buildIosTransform(0, exitBaseY),
                buildIosTransform(exitToXPercent, exitBaseY),
              ],
              opacity: [1, isForward ? IOS_EXIT_DIM_OPACITY : 1],
            },
            {
              duration: IOS_TRANSITION_DURATION,
              ease: easePower2Out,
            }
          )
        );
      }

      activeAnimations.push(
        animate(
          currentLayerEl,
          {
            transform: [buildIosTransform(enterFromXPercent, 0), buildIosTransform(0, 0)],
            opacity: [1, 1],
          },
          {
            duration: IOS_TRANSITION_DURATION,
            ease: easePower2Out,
          }
        )
      );
    } else {
      // Exit animation: fade out with slight movement and scale down (runs simultaneously)
      if (exitingLayerEl) {
        exitingLayerEl.style.transform = buildVerticalTransform(exitBaseY, 1);
        activeAnimations.push(
          animate(
            exitingLayerEl,
            {
              transform: [
                buildVerticalTransform(exitBaseY, 1),
                buildVerticalTransform(exitBaseY + exitToY, 0.98),
              ],
              opacity: [1, 0],
            },
            {
              duration: VERTICAL_TRANSITION_DURATION,
              ease: easeCircOut,
            }
          )
        );
      }

      // Enter animation: fade in with slight movement and scale up (runs simultaneously)
      currentLayerEl.style.transform = buildVerticalTransform(enterFromY, 0.98);
      currentLayerEl.style.opacity = '0';
      activeAnimations.push(
        animate(
          currentLayerEl,
          {
            transform: [buildVerticalTransform(enterFromY, 0.98), buildVerticalTransform(0, 1)],
            opacity: [0, 1],
          },
          {
            duration: VERTICAL_TRANSITION_DURATION,
            ease: easeCircOut,
          }
        )
      );
    }

    if (!activeAnimations.length) {
      completeTransition();
    } else {
      void Promise.all(
        activeAnimations.map((animation) => animation.finished.catch(() => undefined))
      ).then(() => {
        if (cancelled) return;
        completeTransition();
      });
    }

    return () => {
      cancelled = true;
      activeAnimations.forEach((animation) => animation.stop());
    };
  }, [
    currentLayerKey,
    currentLayerLocation,
    isAnimating,
    resolveEnterScrollTop,
    resolveScrollContainer,
  ]);

  return (
    <div className={`page-transition${isAnimating ? ' page-transition--animating' : ''}`}>
      {(() => {
        const currentIndex = layers.findIndex((layer) => layer.status === 'current');
        const resolvedCurrentIndex = currentIndex === -1 ? layers.length - 1 : currentIndex;
        const keepStackedIndex = layers
          .slice(0, resolvedCurrentIndex)
          .map((layer, index) => ({ layer, index }))
          .reverse()
          .find(({ layer }) => layer.status === 'stacked')?.index;

        return layers.map((layer, index) => {
          const shouldKeepStacked = layer.status === 'stacked' && index === keepStackedIndex;
          return (
            <div
              key={layer.key}
              className={[
                'page-transition__layer',
                layer.status === 'exiting' ? 'page-transition__layer--exit' : '',
                layer.status === 'stacked' ? 'page-transition__layer--stacked' : '',
                shouldKeepStacked ? 'page-transition__layer--stacked-keep' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-hidden={layer.status !== 'current'}
              inert={layer.status !== 'current'}
              ref={
                layer.status === 'exiting'
                  ? exitingLayerRef
                  : layer.status === 'current'
                    ? currentLayerRef
                    : undefined
              }
            >
              <PageTransitionLayerContext.Provider
                value={{
                  ...PAGE_TRANSITION_LAYER_CONTEXT_VALUES[layer.status],
                  isAnimating,
                }}
              >
                {render(layer.location)}
              </PageTransitionLayerContext.Provider>
            </div>
          );
        });
      })()}
    </div>
  );
}
