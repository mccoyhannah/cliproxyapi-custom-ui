import { useEffect, useState } from 'react';
import { IconCheck, IconCopy, IconEye, IconEyeOff } from '@/components/ui/icons';
import { copyToClipboard } from '@/utils/clipboard';

interface SensitiveValueFieldProps {
  label: string;
  value: string;
  revealLabel: string;
  hideLabel: string;
  copyLabel: string;
  copiedLabel: string;
  emptyLabel: string;
  disabled?: boolean;
  onCopyResult?: (success: boolean) => void;
}

const MASKED_VALUE = '********';

export function SensitiveValueField({
  label,
  value,
  revealLabel,
  hideLabel,
  copyLabel,
  copiedLabel,
  emptyLabel,
  disabled = false,
  onCopyResult,
}: SensitiveValueFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const displayValue = revealed ? value : value ? MASKED_VALUE : emptyLabel;
  const isMultiline = displayValue.includes('\n') || displayValue.length > 96;

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    if (!value || disabled) return;
    const success = await copyToClipboard(value);
    if (success) {
      setCopied(true);
    }
    onCopyResult?.(success);
  };

  return (
    <div className="sensitive-field">
      <div className="sensitive-field-header">
        <span className="sensitive-field-label">{label}</span>
        <span className="sensitive-field-actions">
          <button
            type="button"
            className="sensitive-field-button"
            onClick={() => setRevealed((current) => !current)}
            disabled={disabled || !value}
            title={revealed ? hideLabel : revealLabel}
            aria-label={revealed ? hideLabel : revealLabel}
          >
            {revealed ? <IconEyeOff size={15} /> : <IconEye size={15} />}
          </button>
          <button
            type="button"
            className="sensitive-field-button"
            onClick={handleCopy}
            disabled={disabled || !value}
            title={copied ? copiedLabel : copyLabel}
            aria-label={copied ? copiedLabel : copyLabel}
          >
            {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
          </button>
        </span>
      </div>
      {isMultiline ? (
        <textarea className="sensitive-field-value" value={displayValue} rows={3} readOnly />
      ) : (
        <input className="sensitive-field-value" value={displayValue} readOnly />
      )}
    </div>
  );
}
