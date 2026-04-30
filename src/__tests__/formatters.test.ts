import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatSidecarLine, formatTimestamp, formatTimestampFull } from '../lib/formatters';

const NOW_UTC = new Date('2026-04-30T16:12:00.000Z');
const NOW = NOW_UTC;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_UTC);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('formatTimestamp', () => {
  it('returns "just now" for sub-minute deltas', () => {
    const recent = new Date(NOW_UTC.getTime() - 30_000).toISOString();
    expect(formatTimestamp(recent, NOW)).toBe('just now');
  });

  it('returns relative minutes within the hour', () => {
    const recent = new Date(NOW_UTC.getTime() - 5 * 60_000).toISOString();
    expect(formatTimestamp(recent, NOW)).toBe('5m ago');
  });

  it('returns relative hours within the 6-hour window', () => {
    const earlier = new Date(NOW_UTC.getTime() - 3 * 60 * 60_000).toISOString();
    expect(formatTimestamp(earlier, NOW)).toBe('3h ago');
  });

  it('renders "Today" for older same-IST-day timestamps (past the 6h relative window)', () => {
    const sameIstDayDifferentUtcDay = '2026-04-29T19:00:00.000Z';
    expect(formatTimestamp(sameIstDayDifferentUtcDay, NOW)).toBe('Today, 12:30 AM IST');
  });

  it('renders short absolute form for earlier in the same year', () => {
    const out = formatTimestamp('2026-03-15T06:30:00.000Z', NOW);
    expect(out).toBe('15 Mar, 12:00 PM IST');
  });

  it('includes the year for older timestamps', () => {
    const out = formatTimestamp('2025-03-15T06:30:00.000Z', NOW);
    expect(out).toBe('15 Mar 2025, 12:00 PM IST');
  });

  it('renders 12-hour AM in the absolute form', () => {
    const morning = formatTimestamp('2026-04-30T04:12:00.000Z', new Date('2026-04-30T23:30:00.000Z'));
    expect(morning).toBe('30 Apr, 9:42 AM IST');
  });

  it('handles year-rollover at the IST boundary', () => {
    const out = formatTimestamp('2025-12-31T20:30:00.000Z', new Date('2026-01-01T03:00:00.000Z'));
    expect(out).toBe('Today, 2:00 AM IST');
  });

  it('returns the raw string when input is invalid', () => {
    expect(formatTimestamp('not-a-date', NOW)).toBe('not-a-date');
  });
});

describe('formatTimestampFull', () => {
  it('shows day, month, year, seconds-precision time, and the IST suffix', () => {
    expect(formatTimestampFull('2026-04-30T16:12:08.000Z')).toBe('30 Apr 2026, 9:42:08 PM IST');
  });

  it('returns the raw string when input is invalid', () => {
    expect(formatTimestampFull('garbage')).toBe('garbage');
  });
});

describe('formatSidecarLine', () => {
  it('renders the bracketed time in IST', () => {
    const raw = JSON.stringify({
      level: 30,
      time: '2026-04-30T16:12:00.000Z',
      msg: 'hello',
    });
    const out = formatSidecarLine(raw);
    expect(out.startsWith('[just now]')).toBe(true);
    expect(out).toContain('[INFO]');
    expect(out).toContain('hello');
  });

  it('falls through to the raw string for non-JSON input', () => {
    expect(formatSidecarLine('plain log line')).toBe('plain log line');
  });
});
