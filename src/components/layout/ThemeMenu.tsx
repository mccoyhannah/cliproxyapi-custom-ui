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
  colors: { bg: string; card: string; border: string; text: string; textMuted: string };
}> = [
  {
    key: 'auto',
    labelKey: 'theme.auto',
    colors: {
      bg: 'linear-gradient(135deg, #ffffff 0 50%, #111111 50% 100%)',
      card: 'linear-gradient(135deg, #ffffff 0 50%, #171d1a 50% 100%)',
      border: '#b9c7bd',
      text: '#202520',
      textMuted: 'linear-gradient(135deg, #9aa69d 0 50%, #617168 50% 100%)',
    },
  },
  {
    key: 'white',
    labelKey: 'theme.white',
    colors: {
      bg: '#ffffff',
      card: '#ffffff',
      border: '#e1e7df',
      text: '#202520',
      textMuted: '#8a948c',
    },
  },
  {
    key: 'light',
    labelKey: 'theme.light',
    colors: {
      bg: '#f5f7f4',
      card: '#ffffff',
      border: '#dfe6dc',
      text: '#202520',
      textMuted: '#8a948c',
    },
  },
  {
    key: 'dark',
    labelKey: 'theme.dark',
    colors: {
      bg: '#101412',
      card: '#171d1a',
      border: '#2d3a33',
      text: '#f2f6f3',
      textMuted: '#8b9a90',
    },
  },
];

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
                style={{
                  background: tc.colors.bg,
                  border: `1px solid ${tc.colors.border}`,
                }}
              >
                <div
                  className="theme-card-header"
                  style={{
                    background: tc.colors.card,
                    borderBottom: `1px solid ${tc.colors.border}`,
                  }}
                />
                <div className="theme-card-body">
                  <div
                    className="theme-card-sidebar"
                    style={{
                      background: tc.colors.card,
                      borderRight: `1px solid ${tc.colors.border}`,
                    }}
                  />
                  <div className="theme-card-content" style={{ background: tc.colors.bg }}>
                    <div className="theme-card-line" style={{ background: tc.colors.textMuted }} />
                    <div
                      className="theme-card-line short"
                      style={{ background: tc.colors.textMuted }}
                    />
                  </div>
                </div>
              </div>
              <span className="theme-card-label">{t(tc.labelKey)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
