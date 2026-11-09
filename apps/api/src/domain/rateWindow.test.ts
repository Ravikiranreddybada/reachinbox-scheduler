import { describe, expect, it } from 'vitest';
import { utcHourWindow } from './rateWindow.js';

describe('utcHourWindow', () => {
  it('returns the next exact UTC hour boundary', () => {
    const now = Date.parse('2026-10-28T10:37:42.500Z');
    expect(new Date(utcHourWindow(now).nextAt).toISOString()).toBe('2026-10-28T11:00:00.000Z');
  });

  it('advances a full hour when called exactly on a boundary', () => {
    const now = Date.parse('2026-10-28T10:00:00.000Z');
    expect(new Date(utcHourWindow(now).nextAt).toISOString()).toBe('2026-10-28T11:00:00.000Z');
  });
});
