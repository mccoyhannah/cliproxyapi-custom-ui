import type { PropsWithChildren, ReactNode } from 'react';

type CardTone = 'default' | 'success' | 'error' | 'warning' | 'info' | 'neutral';
type CardDensity = 'normal' | 'compact';

interface CardProps {
  title?: ReactNode;
  extra?: ReactNode;
  footer?: ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  tone?: CardTone;
  density?: CardDensity;
  interactive?: boolean;
}

export function Card({
  title,
  extra,
  footer,
  children,
  className,
  headerClassName,
  bodyClassName,
  tone = 'default',
  density = 'normal',
  interactive = false,
}: PropsWithChildren<CardProps>) {
  const classes = [
    'card',
    tone !== 'default' ? `card-${tone}` : '',
    density === 'compact' ? 'card-compact' : '',
    interactive ? 'card-interactive' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const headerClasses = ['card-header', headerClassName].filter(Boolean).join(' ');
  const content = bodyClassName ? (
    <div className={`card-body ${bodyClassName}`}>{children}</div>
  ) : (
    children
  );

  return (
    <div className={classes}>
      {(title || extra) && (
        <div className={headerClasses}>
          <div className="title">{title}</div>
          {extra}
        </div>
      )}
      {content}
      {footer && <div className="card-footer">{footer}</div>}
    </div>
  );
}
