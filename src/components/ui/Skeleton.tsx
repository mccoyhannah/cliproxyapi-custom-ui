import type { CSSProperties, HTMLAttributes } from 'react';

export type SkeletonVariant = 'text' | 'card' | 'metric' | 'table' | 'auth-card' | 'config-panel';

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: SkeletonVariant;
  rows?: number;
  width?: number | string;
  height?: number | string;
  rounded?: number | string;
}

const DEFAULT_ROWS: Record<SkeletonVariant, number> = {
  text: 1,
  card: 1,
  metric: 1,
  table: 1,
  'auth-card': 6,
  'config-panel': 5,
};

export function Skeleton({
  variant = 'text',
  rows,
  width,
  height,
  rounded,
  className = '',
  style,
  ...rest
}: SkeletonProps) {
  const classes = ['skeleton', `skeleton-${variant}`, className].filter(Boolean).join(' ');
  const count = Math.max(1, Math.floor(rows ?? DEFAULT_ROWS[variant]));
  const mergedStyle: CSSProperties = {
    ...style,
    width: width ?? style?.width,
    height: height ?? style?.height,
    borderRadius: rounded ?? style?.borderRadius,
  };

  if (variant === 'table') {
    return (
      <div className={classes} style={mergedStyle} aria-hidden="true" {...rest}>
        {Array.from({ length: count }).map((_, index) => (
          <div className="skeleton-table-row" key={index}>
            <span />
            <span />
            <span />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={classes} style={mergedStyle} aria-hidden="true" {...rest}>
      {Array.from({ length: count }).map((_, index) => (
        <span className="skeleton-line" key={index} />
      ))}
    </div>
  );
}
