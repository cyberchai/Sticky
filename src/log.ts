/** One-line structured logs the person running the demo can grep: `[sticky:<area>] key=value ...`. */
export function log(area: string, fields: Record<string, unknown> = {}, level: 'log' | 'warn' | 'error' = 'log'): void {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' && !v.includes(' ') ? v : JSON.stringify(v)}`);
  console[level](`[sticky:${area}] ${parts.join(' ')}`.trim());
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Phone numbers are logged by their last four digits only. */
export function last4(phone: string | null | undefined): string {
  return phone ? `…${phone.replace(/\D/g, '').slice(-4)}` : 'none';
}
