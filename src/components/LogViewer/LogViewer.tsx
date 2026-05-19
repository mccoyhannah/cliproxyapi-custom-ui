import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject, UIEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconCopy } from '@/components/ui/icons';
import { resolveStatusGroup, type LogState, type ParsedLogLine } from '@/pages/hooks/logTypes';

type LogViewerStyles = Record<string, string>;

interface LogViewerProps {
  styles: LogViewerStyles;
  loading: boolean;
  logState: LogState;
  autoRefresh: boolean;
  followTail: boolean;
  isSearching: boolean;
  hasStructuredFilters: boolean;
  filteredLineCount: number;
  removedCount: number;
  canLoadMore: boolean;
  showRawLogs: boolean;
  rawVisibleText: string;
  parsedVisibleLines: ParsedLogLine[];
  toolbarSlot?: ReactNode;
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
  autoRefresh,
  followTail,
  isSearching,
  hasStructuredFilters,
  filteredLineCount,
  removedCount,
  canLoadMore,
  showRawLogs,
  rawVisibleText,
  parsedVisibleLines,
  toolbarSlot,
  logViewerRef,
  onScroll,
  onCopyLine,
  onLongPressStart,
  onLongPressCancel,
  onLongPressMove,
}: LogViewerProps) {
  const { t } = useTranslation();
  const renderedCount = showRawLogs
    ? rawVisibleText.length > 0
      ? filteredLineCount
      : 0
    : parsedVisibleLines.length;
  const copyHint = t('logs.double_click_copy_hint', {
    defaultValue: 'Double-click a row to copy',
  });
  const copyLineLabel = t('logs.copy_line', { defaultValue: 'Copy line' });
  const emptyPrompt = (
    <span className={styles.emptyPrompt} aria-hidden="true">
      &gt;_
    </span>
  );
  const chrome = (
    <div className={styles.terminalChrome}>
      <div className={styles.terminalIdentity}>
        <div className={styles.terminalLights} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className={styles.terminalTitleBlock}>
          <span className={styles.terminalTitle}>{showRawLogs ? 'raw.log' : 'server.log'}</span>
          <span className={styles.terminalHint}>
            {showRawLogs
              ? t('logs.raw_mode_label', { defaultValue: 'raw buffer' })
              : t('logs.parsed_mode_label', { defaultValue: 'parsed stream' })}
          </span>
        </div>
      </div>
      <div className={styles.terminalStatusList}>
        <span
          className={`${styles.terminalStatusPill} ${autoRefresh ? styles.terminalStatusPillActive : ''}`}
        >
          {autoRefresh
            ? t('logs.auto_refresh')
            : t('logs.auto_refresh_off', { defaultValue: 'Auto refresh off' })}
        </span>
        <span
          className={`${styles.terminalStatusPill} ${followTail ? styles.terminalStatusPillActive : styles.terminalStatusPillPaused}`}
        >
          {followTail
            ? t('logs.auto_scroll_on', { defaultValue: 'Auto-scroll on' })
            : t('logs.auto_scroll_paused', { defaultValue: 'Auto-scroll paused' })}
        </span>
        {(isSearching || hasStructuredFilters) && (
          <span className={styles.terminalStatusPill}>
            {t('logs.filtered_lines', { count: removedCount })}
          </span>
        )}
        <span className={styles.terminalStatusPill}>
          {t('logs.loaded_lines', { count: renderedCount })}
        </span>
      </div>
      {toolbarSlot && <div className={styles.terminalToolbar}>{toolbarSlot}</div>}
    </div>
  );

  if (loading) {
    return (
      <div ref={logViewerRef} className={`${styles.logPanel} ${styles.logPanelEmpty}`}>
        {chrome}
        <EmptyState
          variant="loading"
          compact
          className={styles.logEmptyState}
          title={t('logs.loading')}
          description={t('logs.loading_desc', { defaultValue: 'Fetching the latest server logs.' })}
        />
      </div>
    );
  }

  if (logState.buffer.length > 0 && filteredLineCount === 0) {
    return (
      <div ref={logViewerRef} className={`${styles.logPanel} ${styles.logPanelEmpty}`}>
        {chrome}
        <EmptyState
          className={styles.logEmptyState}
          icon={emptyPrompt}
          title={t('logs.search_empty_title')}
          description={t('logs.search_empty_desc')}
          variant="info"
        />
      </div>
    );
  }

  if (logState.buffer.length === 0) {
    return (
      <div ref={logViewerRef} className={`${styles.logPanel} ${styles.logPanelEmpty}`}>
        {chrome}
        <EmptyState
          className={styles.logEmptyState}
          icon={emptyPrompt}
          title={t('logs.empty_title')}
          description={t('logs.empty_desc')}
        />
      </div>
    );
  }

  return (
    <div ref={logViewerRef} className={styles.logPanel} onScroll={onScroll}>
      {chrome}
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
        <pre
          className={styles.rawLog}
          spellCheck={false}
          title={t('logs.raw_copy_hint', {
            defaultValue: 'Select text or double-click to copy the visible buffer',
          })}
          onDoubleClick={() => {
            if (rawVisibleText) onCopyLine(rawVisibleText);
          }}
        >
          {rawVisibleText}
        </pre>
      ) : (
        <div className={styles.logList}>
          {parsedVisibleLines.map((line, index) => {
            const rowClassNames = [styles.logRow];
            if (line.level === 'info') rowClassNames.push(styles.rowInfo);
            if (line.level === 'debug') rowClassNames.push(styles.rowDebug);
            if (line.level === 'trace') rowClassNames.push(styles.rowTrace);
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
                title={copyHint}
              >
                <div className={styles.timestamp}>{line.timestamp || ''}</div>
                <div className={styles.rowMain}>
                  {line.level && (
                    <span
                      className={[
                        styles.badge,
                        line.level === 'info' ? styles.levelInfo : '',
                        line.level === 'warn' ? styles.levelWarn : '',
                        line.level === 'error' || line.level === 'fatal' ? styles.levelError : '',
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
                      title={t('logs.http_status_title', {
                        defaultValue: 'HTTP {{status}}',
                        status: line.statusCode,
                      })}
                      aria-label={t('logs.http_status_aria', {
                        defaultValue: 'HTTP status {{status}}',
                        status: line.statusCode,
                      })}
                    >
                      <span className={styles.statusBadgePrefix}>
                        {resolveStatusGroup(line.statusCode) ?? 'HTTP'}
                      </span>
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

                  <button
                    type="button"
                    className={styles.copyButton}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCopyLine(line.raw);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={copyLineLabel}
                    aria-label={copyLineLabel}
                  >
                    <IconCopy size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
