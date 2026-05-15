import type { HTMLAttributes } from 'react';

export type SkeletonVariant = 'text' | 'card' | 'metric' | 'table' | 'auth-card' | 'config-panel';

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: SkeletonVariant;
  rows?: number;
}

const DEFAULT_ROWS: Record<SkeletonVariant, number> = {
  text: 1,
  card: 1,
  metric: 1,
  table: 1,
  'auth-card': 6,
  'config-panel': 5,
};

export function Skeleton({ variant = 'text', rows, className = '', ...rest }: SkeletonProps) {
  const classes = ['skeleton', `skeleton-${variant}`, className].filter(Boolean).join(' ');
  const count = Math.max(1, Math.floor(rows ?? DEFAULT_ROWS[variant]));

  if (variant === 'table') {
    return (
      <div className={classes} aria-hidden="true" {...rest}>
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
    <div className={classes} aria-hidden="true" {...rest}>
      {Array.from({ length: count }).map((_, index) => (
        <span className="skeleton-line" key={index} />
      ))}
    </div>
  );
}
