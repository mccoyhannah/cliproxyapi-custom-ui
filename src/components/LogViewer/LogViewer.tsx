import type { PointerEvent as ReactPointerEvent, RefObject, UIEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import type { LogState, ParsedLogLine } from '@/pages/hooks/logTypes';

type LogViewerStyles = Record<string, string>;

interface LogViewerProps {
  styles: LogViewerStyles;
  loading: boolean;
  logState: LogState;
  filteredLineCount: number;
  removedCount: number;
  canLoadMore: boolean;
  showRawLogs: boolean;
  rawVisibleText: string;
  parsedVisibleLines: ParsedLogLine[];
  logViewerRef: RefObject<HTMLDivElement | null>;
  onScroll: (e: UIEvent<HTMLDivElement>) => void;
  onCopyLine: (raw: string) => void;
  onLongPressStart: (event: ReactPointerEvent<HTMLDivElement>, id?: string) => void;
  onLongPressCancel: () => void;
  onLongPressMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function LogViewer({
  styles,
  loading,
  logState,
  filteredLineCount,
  removedCount,
  canLoadMore,
  showRawLogs,
  rawVisibleText,
  parsedVisibleLines,
  logViewerRef,
  onScroll,
  onCopyLine,
  onLongPressStart,
  onLongPressCancel,
  onLongPressMove,
}: LogViewerProps) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <EmptyState
        variant="loading"
        compact
        title={t('logs.loading')}
        description={t('logs.loading_desc', { defaultValue: 'Fetching the latest server logs.' })}
      />
    );
  }

  if (logState.buffer.length > 0 && filteredLineCount === 0) {
    return (
      <EmptyState
        title={t('logs.search_empty_title')}
        description={t('logs.search_empty_desc')}
        variant="info"
      />
    );
  }

  if (logState.buffer.length === 0) {
    return <EmptyState title={t('logs.empty_title')} description={t('logs.empty_desc')} />;
  }

  return (
    <div ref={logViewerRef} className={styles.logPanel} onScroll={onScroll}>
      {canLoadMore && (
        <div className={styles.loadMoreBanner}>
          <span>{t('logs.load_more_hint')}</span>
          <div className={styles.loadMoreStats}>
            <span>{t('logs.loaded_lines', { count: filteredLineCount })}</span>
            {removedCount > 0 && (
              <span className={styles.loadMoreCount}>
                {t('logs.filtered_lines', { count: removedCount })}
              </span>
            )}
            <span className={styles.loadMoreCount}>
              {t('logs.hidden_lines', { count: logState.visibleFrom })}
            </span>
          </div>
        </div>
      )}
      {showRawLogs ? (
        <pre className={styles.rawLog} spellCheck={false}>
          {rawVisibleText}
        </pre>
      ) : (
        <div className={styles.logList}>
          {parsedVisibleLines.map((line, index) => {
            const rowClassNames = [styles.logRow];
            if (line.level === 'warn') rowClassNames.push(styles.rowWarn);
            if (line.level === 'error' || line.level === 'fatal')
              rowClassNames.push(styles.rowError);

            return (
              <div
                key={`${logState.visibleFrom + index}-${line.raw}`}
                className={rowClassNames.join(' ')}
                onDoubleClick={() => onCopyLine(line.raw)}
                onPointerDown={(event) => onLongPressStart(event, line.requestId)}
                onPointerUp={onLongPressCancel}
                onPointerLeave={onLongPressCancel}
                onPointerCancel={onLongPressCancel}
                onPointerMove={onLongPressMove}
                title={t('logs.double_click_copy_hint', {
                  defaultValue: 'Double-click to copy',
                })}
              >
                <div className={styles.timestamp}>{line.timestamp || ''}</div>
                <div className={styles.rowMain}>
                  {line.level && (
                    <span
                      className={[
                        styles.badge,
                        line.level === 'info' ? styles.levelInfo : '',
                        line.level === 'warn' ? styles.levelWarn : '',
                        line.level === 'error' || line.level === 'fatal'
                          ? styles.levelError
                          : '',
                        line.level === 'debug' ? styles.levelDebug : '',
                        line.level === 'trace' ? styles.levelTrace : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {line.level.toUpperCase()}
                    </span>
                  )}

                  {line.source && (
                    <span className={styles.source} title={line.source}>
                      {line.source}
                    </span>
                  )}

                  {line.requestId && (
                    <span
                      className={[styles.badge, styles.requestIdBadge].join(' ')}
                      title={line.requestId}
                    >
                      {line.requestId}
                    </span>
                  )}

                  {typeof line.statusCode === 'number' && (
                    <span
                      className={[
                        styles.badge,
                        styles.statusBadge,
                        line.statusCode >= 200 && line.statusCode < 300
                          ? styles.statusSuccess
                          : line.statusCode >= 300 && line.statusCode < 400
                            ? styles.statusInfo
                            : line.statusCode >= 400 && line.statusCode < 500
                              ? styles.statusWarn
                              : styles.statusError,
                      ].join(' ')}
                    >
                      {line.statusCode}
                    </span>
                  )}

                  {line.latency && <span className={styles.pill}>{line.latency}</span>}
                  {line.ip && <span className={styles.pill}>{line.ip}</span>}

                  {line.method && (
                    <span className={[styles.badge, styles.methodBadge].join(' ')}>
                      {line.method}
                    </span>
                  )}

                  {line.path && (
                    <span className={styles.path} title={line.path}>
                      {line.path}
                    </span>
                  )}

                  {line.message && <span className={styles.message}>{line.message}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
