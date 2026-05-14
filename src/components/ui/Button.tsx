import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'warning';
type ButtonSize = 'md' | 'sm' | 'xs';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  iconOnly?: boolean;
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  loadingLabel,
  leftIcon,
  rightIcon,
  iconOnly = false,
  className = '',
  disabled,
  ...rest
}: PropsWithChildren<ButtonProps>) {
  const hasChildren = children !== null && children !== undefined && children !== false;
  const classes = [
    'btn',
    `btn-${variant}`,
    size === 'sm' ? 'btn-sm' : '',
    size === 'xs' ? 'btn-xs' : '',
    fullWidth ? 'btn-full' : '',
    iconOnly ? 'btn-icon-only' : '',
    className
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="loading-spinner" aria-hidden="true" />}
      {!loading && leftIcon && <span className="btn-icon">{leftIcon}</span>}
      {hasChildren && <span className="btn-label">{loading && loadingLabel ? loadingLabel : children}</span>}
      {!loading && rightIcon && <span className="btn-icon">{rightIcon}</span>}
    </button>
  );
}
