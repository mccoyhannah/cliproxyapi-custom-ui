export const PORTABLE_SMOKE_TIMEOUT_MS = 90_000;

export function resolvePortableSmokeResult(exitCode, artifactPath) {
  if (exitCode === 0) {
    return {
      exitCode: 0,
      stderr: '',
      stdout: `portable-smoke-pass: ${artifactPath}\n`,
    };
  }

  return {
    exitCode: Number.isInteger(exitCode) && exitCode > 0 ? exitCode : 1,
    stderr: `portable-smoke-exit:${exitCode ?? 'null'}\n`,
    stdout: '',
  };
}
