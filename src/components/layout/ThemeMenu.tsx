import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import type { Theme } from '@/types';

interface ThemeMenuProps {
  open: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
  theme: Theme;
  buttonIcon: ReactNode;
  onToggle: () => void;
  onSelect: (theme: Theme) => void;
}

const THEME_CARDS: Array<{
  key: Theme;
  labelKey: string;
}> = [
  {
    key: 'auto',
    labelKey: 'theme.auto',
  },
  {
    key: 'white',
    labelKey: 'theme.white',
  },
  {
    key: 'light',
    labelKey: 'theme.light',
  },
  {
    key: 'dark',
    labelKey: 'theme.dark',
  },
];

type PreviewTheme = Exclude<Theme, 'auto'>;

function ThemePreviewPane({ theme, divided = false }: { theme: PreviewTheme; divided?: boolean }) {
  return (
    <div
      data-theme={theme}
      style={{
        display: 'flex',
        minWidth: 0,
        height: '100%',
        flexDirection: 'column',
        borderLeft: divided ? '1px solid var(--border-base)' : undefined,
        background: 'var(--bg-body)',
      }}
    >
      <div
        className="theme-card-header"
        style={{
          background: 'var(--surface-card)',
          borderBottom: '1px solid var(--border-base)',
        }}
      />
      <div className="theme-card-body">
        <div
          className="theme-card-sidebar"
          style={{
            background: 'var(--surface-card)',
            borderRight: '1px solid var(--border-base)',
          }}
        />
        <div className="theme-card-content" style={{ background: 'var(--bg-body)' }}>
          <div className="theme-card-line" style={{ background: 'var(--text-tertiary)' }} />
          <div className="theme-card-line short" style={{ background: 'var(--primary-color)' }} />
        </div>
      </div>
    </div>
  );
}

export function ThemeMenu({
  open,
  menuRef,
  theme,
  buttonIcon,
  onToggle,
  onSelect,
}: ThemeMenuProps) {
  const { t } = useTranslation();

  return (
    <div className={`theme-menu ${open ? 'open' : ''}`} ref={menuRef}>
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggle}
        title={t('theme.switch')}
        aria-label={t('theme.switch')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {buttonIcon}
      </Button>
      {open && (
        <div className="notification entering theme-menu-popover" role="menu" aria-label={t('theme.switch')}>
          {THEME_CARDS.map((tc) => (
            <button
              key={tc.key}
              type="button"
              className={`theme-card ${theme === tc.key ? 'active' : ''}`}
              onClick={() => onSelect(tc.key)}
              role="menuitemradio"
              aria-checked={theme === tc.key}
            >
              <div
                className="theme-card-preview"
                data-theme={tc.key === 'auto' ? undefined : tc.key}
                aria-hidden="true"
                style={{
                  display: 'grid',
                  gridTemplateColumns: tc.key === 'auto' ? '1fr 1fr' : '1fr',
                  background: 'var(--bg-body)',
                  border: '1px solid var(--border-base)',
                }}
              >
                {tc.key === 'auto' ? (
                  <>
                    <ThemePreviewPane theme="white" />
                    <ThemePreviewPane theme="dark" divided />
                  </>
                ) : (
                  <ThemePreviewPane theme={tc.key} />
                )}
              </div>
              <span className="theme-card-label">{t(tc.labelKey)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
