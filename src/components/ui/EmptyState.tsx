import type { ReactNode } from 'react';
import { LoadingSpinner } from './LoadingSpinner';
import { IconCheck, IconInbox, IconInfo, IconX } from './icons';

type EmptyStateVariant = 'neutral' | 'success' | 'error' | 'warning' | 'info' | 'loading';

interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  variant?: EmptyStateVariant;
  tone?: EmptyStateVariant;
  compact?: boolean;
  className?: string;
}

function getDefaultIcon(variant: EmptyStateVariant) {
  if (variant === 'loading') return <LoadingSpinner size={18} />;
  if (variant === 'success') return <IconCheck size={20} />;
  if (variant === 'error') return <IconX size={20} />;
  if (variant === 'warning' || variant === 'info') return <IconInfo size={20} />;
  return <IconInbox size={20} />;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  variant = 'neutral',
  tone,
  compact = false,
  className = '',
}: EmptyStateProps) {
  const resolvedVariant = tone ?? variant;
  const classes = [
    'empty-state',
    `empty-state-${resolvedVariant}`,
    compact ? 'empty-state-compact' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const role =
    resolvedVariant === 'error' ? 'alert' : resolvedVariant === 'loading' ? 'status' : undefined;

  return (
    <div className={classes} role={role} aria-live={role ? 'polite' : undefined}>
      <div className="empty-content">
        <div className="empty-icon" aria-hidden="true">
          {icon ?? getDefaultIcon(resolvedVariant)}
        </div>
        <div>
          <div className="empty-title">{title}</div>
          {description && <div className="empty-desc">{description}</div>}
        </div>
      </div>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
