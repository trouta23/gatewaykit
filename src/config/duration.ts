const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

/** Node timers overflow above 2^31-1 ms (~24.8 days) and fire immediately. */
export const MAX_DURATION_MS = 2 ** 31 - 1;

/** Parses "500ms", "30s", "1.5m", "1h" into milliseconds. Returns undefined if invalid. */
export function parseDuration(value: string): number | undefined {
  const match = DURATION.exec(value.trim());
  if (!match) return undefined;
  const ms = Math.round(Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS]);
  return ms > 0 && ms <= MAX_DURATION_MS ? ms : undefined;
}
