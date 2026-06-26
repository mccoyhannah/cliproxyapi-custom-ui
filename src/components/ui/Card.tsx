import type { PropsWithChildren, ReactNode } from 'react';

interface CardProps {
  title?: ReactNode;
  extra?: ReactNode;
  className?: string;
  headerClassName?: string;
  density?: 'compact' | 'normal' | string;
}

export function Card({
  title,
  extra,
  children,
  className,
  headerClassName,
  density,
}: PropsWithChildren<CardProps>) {
  const rootClassName = [
    'card',
    density ? `card-${density}` : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClassName}>
      {(title || extra) && (
        <div className={headerClassName ? `card-header ${headerClassName}` : 'card-header'}>
          <div className="title">{title}</div>
          {extra}
        </div>
      )}
      {children}
    </div>
  );
}
