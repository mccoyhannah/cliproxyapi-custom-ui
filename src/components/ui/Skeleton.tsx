import type { HTMLAttributes } from 'react';

export type SkeletonVariant = 'text' | 'card' | 'metric' | 'table';

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: SkeletonVariant;
  rows?: number;
}

export function Skeleton({
  variant = 'text',
  rows = 1,
  className = '',
  ...rest
}: SkeletonProps) {
  const classes = ['skeleton', `skeleton-${variant}`, className].filter(Boolean).join(' ');
  const count = Math.max(1, Math.floor(rows));

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
