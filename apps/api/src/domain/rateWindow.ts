export function utcHourWindow(now: number): { window: number; nextAt: number } {
  const window = Math.floor(now / 3_600_000);
  return { window, nextAt: (window + 1) * 3_600_000 };
}
