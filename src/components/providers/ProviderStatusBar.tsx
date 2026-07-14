import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useId,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { StatusBarData, StatusBlockDetail } from '@/utils/recentRequests';
import defaultStyles from '@/pages/AiProvidersPage.module.scss';

/**
 * 根据成功率 (0–1) 在三个色标之间做 RGB 线性插值
 * 0 → 红 (#ef4444)  →  0.5 → 金黄 (#facc15)  →  1 → 绿 (#22c55e)
 */
const COLOR_STOPS = [
  { r: 239, g: 68, b: 68 },   // #ef4444
  { r: 250, g: 204, b: 21 },  // #facc15
  { r: 34, g: 197, b: 94 },   // #22c55e
] as const;

function rateToColor(rate: number): string {
  const t = Math.max(0, Math.min(1, rate));
  const segment = t < 0.5 ? 0 : 1;
  const localT = segment === 0 ? t * 2 : (t - 0.5) * 2;
  const from = COLOR_STOPS[segment];
  const to = COLOR_STOPS[segment + 1];
  const r = Math.round(from.r + (to.r - from.r) * localT);
  const g = Math.round(from.g + (to.g - from.g) * localT);
  const b = Math.round(from.b + (to.b - from.b) * localT);
  return `rgb(${r}, ${g}, ${b})`;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function formatSuccessRate(rate: number): string {
  const rounded = rate.toFixed(1);
  return `${rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded}%`;
}

type StylesModule = Record<string, string>;
type TooltipPosition = {
  left: number;
  top: number;
  arrowLeft: number;
  placement: 'top' | 'bottom';
};

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export interface StatusBarFailureDetail {
  label: string;
  message: string;
}

function getDefaultFocusableBlockIndex(details: StatusBlockDetail[]): number {
  for (let index = details.length - 1; index >= 0; index -= 1) {
    if (details[index].success + details[index].failure > 0) return index;
  }
  return Math.max(0, details.length - 1);
}

interface ProviderStatusBarProps {
  statusData: StatusBarData;
  styles?: StylesModule;
  highlightedBlockIndex?: number | null;
  failureDetailsByBlockIndex?: Readonly<Record<number, StatusBarFailureDetail[]>>;
}

export function ProviderStatusBar({
  statusData,
  styles: stylesProp,
  highlightedBlockIndex = null,
  failureDetailsByBlockIndex = {},
}: ProviderStatusBarProps) {
  const { t } = useTranslation();
  const s = (stylesProp || defaultStyles) as StylesModule;
  const [activeTooltip, setActiveTooltip] = useState<number | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition | null>(null);
  const [preferredFocusableBlockIndex, setFocusableBlockIndex] = useState(() =>
    getDefaultFocusableBlockIndex(statusData.blockDetails)
  );
  const blocksRef = useRef<HTMLDivElement>(null);
  const blockRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const hideTimeoutRef = useRef<number | null>(null);
  const tooltipIdPrefix = useId();
  const focusableBlockIndex =
    preferredFocusableBlockIndex >= 0 &&
    preferredFocusableBlockIndex < statusData.blockDetails.length
      ? preferredFocusableBlockIndex
      : getDefaultFocusableBlockIndex(statusData.blockDetails);

  const cancelScheduledHide = useCallback(() => {
    if (hideTimeoutRef.current === null) return;
    window.clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = null;
  }, []);
  const showTooltip = useCallback(
    (idx: number) => {
      cancelScheduledHide();
      setTooltipPosition(null);
      setActiveTooltip(idx);
    },
    [cancelScheduledHide]
  );
  const hideTooltip = useCallback(() => {
    cancelScheduledHide();
    setActiveTooltip(null);
    setTooltipPosition(null);
  }, [cancelScheduledHide]);
  const scheduleHideTooltip = useCallback(() => {
    cancelScheduledHide();
    hideTimeoutRef.current = window.setTimeout(() => {
      hideTimeoutRef.current = null;
      setActiveTooltip(null);
      setTooltipPosition(null);
    }, 160);
  }, [cancelScheduledHide]);
  const focusTooltipContent = useCallback(() => {
    window.requestAnimationFrame(() => {
      tooltipRef.current
        ?.querySelector<HTMLElement>('[data-status-tooltip-content="true"]')
        ?.focus();
    });
  }, []);

  useEffect(() => cancelScheduledHide, [cancelScheduledHide]);

  const hasData = statusData.totalSuccess + statusData.totalFailure > 0;
  const rateClass = !hasData
    ? ''
    : statusData.successRate >= 90
      ? s.statusRateHigh
      : statusData.successRate >= 50
        ? s.statusRateMedium
        : s.statusRateLow;

  // 点击外部关闭 tooltip（移动端）
  useEffect(() => {
    if (activeTooltip === null) return;
    const handler = (e: PointerEvent) => {
      const target = e.target as Node;
      if (blocksRef.current?.contains(target) || tooltipRef.current?.contains(target)) return;
      hideTooltip();
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [activeTooltip, hideTooltip]);

  const handlePointerEnter = useCallback(
    (e: React.PointerEvent, idx: number) => {
      if (e.pointerType === 'mouse') {
        showTooltip(idx);
      }
    },
    [showTooltip]
  );

  const handlePointerLeave = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') {
        const relatedTarget = e.relatedTarget;
        if (
          relatedTarget instanceof Node &&
          (blocksRef.current?.contains(relatedTarget) || tooltipRef.current?.contains(relatedTarget))
        ) {
          return;
        }
        scheduleHideTooltip();
      }
    },
    [scheduleHideTooltip]
  );

  const updateTooltipPosition = useCallback(() => {
    if (activeTooltip === null || typeof window === 'undefined') return;
    const anchor = blockRefs.current[activeTooltip];
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const measuredWidth = Math.min(
      tooltipRef.current?.offsetWidth ?? 140,
      Math.max(1, viewportWidth - 24)
    );
    const measuredHeight = Math.min(
      tooltipRef.current?.offsetHeight ?? 142,
      Math.max(1, viewportHeight - 24)
    );
    const centerX = rect.left + rect.width / 2;
    const left = clampNumber(
      centerX - measuredWidth / 2,
      12,
      Math.max(12, viewportWidth - measuredWidth - 12)
    );
    const canPlaceAbove = rect.top >= measuredHeight + 14;
    const canPlaceBelow = rect.bottom + measuredHeight + 14 <= viewportHeight;
    const placement = canPlaceAbove || !canPlaceBelow ? 'top' : 'bottom';
    const top =
      placement === 'top'
        ? clampNumber(rect.top - measuredHeight - 10, 12, viewportHeight - measuredHeight - 12)
        : clampNumber(rect.bottom + 10, 12, viewportHeight - measuredHeight - 12);

    setTooltipPosition({
      left,
      top,
      arrowLeft: clampNumber(centerX - left, 18, Math.max(18, measuredWidth - 18)),
      placement,
    });
  }, [activeTooltip]);

  useEffect(() => {
    if (activeTooltip === null) return;

    updateTooltipPosition();
    const frameId = window.requestAnimationFrame(updateTooltipPosition);
    const tooltip = tooltipRef.current;
    const resizeObserver =
      tooltip && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(updateTooltipPosition)
        : null;
    if (tooltip) resizeObserver?.observe(tooltip);
    window.addEventListener('resize', updateTooltipPosition);
    window.addEventListener('scroll', updateTooltipPosition, true);
    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateTooltipPosition);
      window.removeEventListener('scroll', updateTooltipPosition, true);
    };
  }, [activeTooltip, updateTooltipPosition]);

  const renderTooltip = (detail: StatusBlockDetail, idx: number, tooltipId: string) => {
    const total = detail.success + detail.failure;
    const linkedFailureDetails = failureDetailsByBlockIndex?.[idx] ?? [];
    const timeRange = detail.timeLabel
      ? detail.timeLabel.replace(/\s*[-–—]\s*/, ' – ')
      : `${formatTime(detail.startTime)} – ${formatTime(detail.endTime)}`;
    const unavailableLabel = t('status_bar.failure_reason_unavailable', {
      defaultValue: '原因未记录',
    });
    const tooltipStyle = {
      left: tooltipPosition ? `${tooltipPosition.left}px` : '0',
      top: tooltipPosition ? `${tooltipPosition.top}px` : '0',
      visibility: tooltipPosition ? 'visible' : 'hidden',
      '--status-tooltip-arrow-left': tooltipPosition
        ? `${tooltipPosition.arrowLeft}px`
        : '50%',
    } as CSSProperties;

    return (
      <span
        ref={tooltipRef}
        id={tooltipId}
        role="tooltip"
        className={`${s.statusTooltip} ${
          tooltipPosition?.placement === 'bottom' ? s.statusTooltipBelow : ''
        }`}
        style={tooltipStyle}
        onPointerEnter={cancelScheduledHide}
        onPointerLeave={handlePointerLeave}
      >
        <span
          className={s.statusTooltipContent}
          data-status-tooltip-content="true"
          tabIndex={0}
          onFocus={cancelScheduledHide}
          onBlur={(event) => {
            const relatedTarget = event.relatedTarget;
            if (
              relatedTarget instanceof Node &&
              (blocksRef.current?.contains(relatedTarget) ||
                tooltipRef.current?.contains(relatedTarget))
            ) {
              return;
            }
            hideTooltip();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            hideTooltip();
            window.requestAnimationFrame(() => blockRefs.current[idx]?.focus());
          }}
        >
          <span className={s.tooltipTime}>{timeRange}</span>
          {total > 0 ? (
            <span className={s.tooltipStats}>
              <span className={s.tooltipSuccess}>{t('status_bar.success_short')} {detail.success}</span>
              <span className={s.tooltipFailure}>{t('status_bar.failure_short')} {detail.failure}</span>
              <span className={s.tooltipRate}>({(detail.rate * 100).toFixed(1)}%)</span>
            </span>
          ) : (
            <span className={s.tooltipStats}>{t('status_bar.no_requests')}</span>
          )}
          {detail.failure > 0 &&
            (linkedFailureDetails.length > 0 ? (
              <span className={s.tooltipFailureDetail}>
                {linkedFailureDetails.map((failureDetail) => {
                  const showMessage =
                    failureDetail.message.trim() &&
                    failureDetail.message.trim().toLocaleLowerCase() !==
                      failureDetail.label.trim().toLocaleLowerCase();
                  return (
                    <span
                      key={`${failureDetail.label}\u0000${failureDetail.message}`}
                      className={s.tooltipFailureMessage}
                    >
                      <span className={s.tooltipFailureHeading}>{failureDetail.label}</span>
                      {showMessage ? ` · ${failureDetail.message}` : ''}
                    </span>
                  );
                })}
              </span>
            ) : (
              <span className={s.tooltipFailureUnknown}>{unavailableLabel}</span>
            ))}
        </span>
      </span>
    );
  };

  return (
    <div className={s.statusBar}>
      <div className={s.statusBlocks} ref={blocksRef}>
        {statusData.blockDetails.map((detail, idx) => {
          const isIdle = detail.rate === -1;
          const blockStyle = isIdle ? undefined : { backgroundColor: rateToColor(detail.rate) };
          const isActive = activeTooltip === idx;
          const isHighlighted = highlightedBlockIndex === idx;
          const total = detail.success + detail.failure;
          const timeRange = detail.timeLabel
            ? detail.timeLabel.replace(/\s*[-–—]\s*/, ' – ')
            : `${formatTime(detail.startTime)} – ${formatTime(detail.endTime)}`;
          const tooltipId = `${tooltipIdPrefix}-status-${idx}`;
          const linkedFailureDetails = failureDetailsByBlockIndex?.[idx] ?? [];
          const reasonLabel =
            detail.failure <= 0
              ? ''
              : linkedFailureDetails.length > 0
                ? linkedFailureDetails
                    .map(({ label, message }) => (message ? `${label} · ${message}` : label))
                    .join('; ')
                : t('status_bar.failure_reason_unavailable', {
                    defaultValue: '原因未记录',
                  });
          const ariaLabel =
            total > 0
              ? `${timeRange}, ${t('status_bar.success_short')} ${detail.success}, ${t('status_bar.failure_short')} ${detail.failure}${reasonLabel ? `, ${reasonLabel}` : ''}`
              : `${timeRange}, ${t('status_bar.no_requests')}`;
          const moveKeyboardFocus = (nextIndex: number) => {
            setFocusableBlockIndex(nextIndex);
            showTooltip(nextIndex);
            window.requestAnimationFrame(() => blockRefs.current[nextIndex]?.focus());
          };

          return (
            <button
              type="button"
              key={idx}
              ref={(node) => {
                blockRefs.current[idx] = node;
              }}
              className={`${s.statusBlockWrapper} ${
                isActive || isHighlighted ? s.statusBlockActive : ''
              } ${isHighlighted ? s.statusBlockHighlighted : ''}`}
              tabIndex={idx === focusableBlockIndex ? 0 : -1}
              aria-label={ariaLabel}
              aria-expanded={isActive}
              aria-describedby={isActive ? tooltipId : undefined}
              onPointerEnter={(e) => handlePointerEnter(e, idx)}
              onPointerLeave={handlePointerLeave}
              onFocus={() => {
                setFocusableBlockIndex(idx);
                showTooltip(idx);
              }}
              onBlur={(event) => {
                const relatedTarget = event.relatedTarget;
                if (relatedTarget instanceof Node && tooltipRef.current?.contains(relatedTarget)) {
                  return;
                }
                hideTooltip();
              }}
              onClick={() => {
                setFocusableBlockIndex(idx);
                showTooltip(idx);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  showTooltip(idx);
                  focusTooltipContent();
                  return;
                }
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  const direction = event.key === 'ArrowLeft' ? -1 : 1;
                  const count = statusData.blockDetails.length;
                  if (count > 0) {
                    moveKeyboardFocus((idx + direction + count) % count);
                  }
                  return;
                }
                if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault();
                  const lastIndex = Math.max(0, statusData.blockDetails.length - 1);
                  moveKeyboardFocus(event.key === 'Home' ? 0 : lastIndex);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  hideTooltip();
                  event.currentTarget.blur();
                }
              }}
            >
              <div
                className={`${s.statusBlock} ${isIdle ? s.statusBlockIdle : ''}`}
                style={blockStyle}
              />
              {isActive &&
                typeof document !== 'undefined' &&
                createPortal(renderTooltip(detail, idx, tooltipId), document.body)}
            </button>
          );
        })}
      </div>
      <span className={`${s.statusRate} ${rateClass}`}>
        {hasData ? formatSuccessRate(statusData.successRate) : '--'}
      </span>
    </div>
  );
}
