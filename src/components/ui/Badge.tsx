import type { HTMLAttributes, PropsWithChildren, ReactNode } from 'react';

export type BadgeVariant =
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'neutral'
  | 'recommended';
export type BadgeSize = 'sm' | 'md';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  dot?: boolean;
  icon?: ReactNode;
  mono?: boolean;
}

export function Badge({
  children,
  variant = 'neutral',
  size = 'md',
  dot = false,
  icon,
  mono = false,
  className = '',
  ...rest
}: PropsWithChildren<BadgeProps>) {
  const classes = [
    'badge',
    `badge-${variant}`,
    size === 'sm' ? 'badge-sm' : '',
    dot ? 'badge-with-dot' : '',
    mono ? 'badge-mono' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes} {...rest}>
      {dot && <span className="badge-dot" aria-hidden="true" />}
      {icon && (
        <span className="badge-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="badge-label">{children}</span>
    </span>
  );
}
