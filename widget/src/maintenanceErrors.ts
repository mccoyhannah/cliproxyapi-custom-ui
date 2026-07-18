export type LedgerMaintenancePhase = 'preview' | 'execute';

const hasMaintenanceCode = (error: unknown, code: string): boolean =>
  error instanceof Error && error.message.includes(code);

export function describeLedgerMaintenanceError(
  error: unknown,
  phase: LedgerMaintenancePhase
): string {
  if (hasMaintenanceCode(error, 'ledger-maintenance-low-space')) {
    return phase === 'preview'
      ? '可用磁盘空间不足，安全预览未完成。没有修改正式账本，也没有删除日志。请先释放 D 盘空间后重试。'
      : '可用磁盘空间不足，入账未能安全写入，未执行日志清理。请先释放 D 盘空间后重新预览。';
  }

  if (hasMaintenanceCode(error, 'ledger-maintenance-total-regression')) {
    return phase === 'preview'
      ? '候选账本尚未追上当前合计；未写入账本、未删除日志。请稍后重新预览。'
      : '总量安全核验未通过。维护已停止；请重新预览后再试。';
  }

  if (
    phase === 'execute' &&
    (hasMaintenanceCode(error, 'ledger-maintenance-preview-expired') ||
      hasMaintenanceCode(error, 'ledger-maintenance-preview-unavailable'))
  ) {
    return '本次安全预览已失效。没有继续执行；请重新预览后再试。';
  }

  return phase === 'preview'
    ? '安全预览未完成。没有修改正式账本，也没有删除日志。'
    : '维护没有完成。安全流程已停止；请重新预览后再试。';
}
