import type { HTMLAttributes, PropsWithChildren, ReactNode } from 'react';

export type BadgeVariant =
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'neutral'
  | 'recommended';
export type BadgeSize = 'sm' | 'md';
export type BadgeAppearance = 'soft' | 'outline' | 'solid';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  appearance?: BadgeAppearance;
  dot?: boolean;
  pulse?: boolean;
  icon?: ReactNode;
  mono?: boolean;
}

export function Badge({
  children,
  variant = 'neutral',
  size = 'md',
  appearance = 'soft',
  dot = false,
  pulse = false,
  icon,
  mono = false,
  className = '',
  ...rest
}: PropsWithChildren<BadgeProps>) {
  const classes = [
    'badge',
    `badge-${variant}`,
    `badge-${appearance}`,
    size === 'sm' ? 'badge-sm' : '',
    dot ? 'badge-with-dot' : '',
    dot && pulse ? 'badge-dot-pulse' : '',
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
