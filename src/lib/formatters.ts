export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function formatCostUsd(value: number | null | undefined, fractionDigits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  if (value === 0) return '$0';
  if (value >= 1) return `$${value.toFixed(2)}`;
  const fixed = value.toFixed(fractionDigits);
  return `$${fixed.replace(/\.?0+$/, '')}`;
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  if (value === 0) return '0';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function formatPercent(rate: number | null | undefined, fractionDigits = 0): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return '—';
  }
  return `${(rate * 100).toFixed(fractionDigits)}%`;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return '0ms';
  }
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return formatDurationSeconds(Math.round(ms / 1000));
}

export function formatDurationSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0s';
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${rem}s`;
  }
  const hours = Math.floor(minutes / 60);
  const minuteRem = minutes % 60;
  return `${hours}h ${minuteRem}m`;
}

const IST_TZ = 'Asia/Kolkata';

const istTimeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: IST_TZ,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const istTimeWithSecondsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: IST_TZ,
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

const istDateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TZ,
  day: '2-digit',
  month: 'short',
});

const istDateYearFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TZ,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const istIsoPartsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function istCalendarKey(date: Date): string {
  return istIsoPartsFmt.format(date);
}

export function formatTimestamp(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const diffMs = now.getTime() - date.getTime();
  const todayKey = istCalendarKey(now);
  const dateKey = istCalendarKey(date);
  const sameDay = todayKey === dateKey;

  if (diffMs >= 0 && diffMs < 60_000) {
    return 'just now';
  }
  if (diffMs >= 0 && diffMs < 60 * 60_000) {
    const minutes = Math.floor(diffMs / 60_000);
    return `${minutes}m ago`;
  }
  if (diffMs >= 0 && diffMs < 6 * 60 * 60_000 && sameDay) {
    const hours = Math.floor(diffMs / (60 * 60_000));
    return `${hours}h ago`;
  }

  const time = istTimeFmt.format(date);
  if (sameDay) {
    return `Today, ${time} IST`;
  }

  const sameYear = todayKey.slice(0, 4) === dateKey.slice(0, 4);
  const datePart = sameYear ? istDateFmt.format(date) : istDateYearFmt.format(date);
  return `${datePart}, ${time} IST`;
}

export function formatTimestampFull(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return `${istDateYearFmt.format(date)}, ${istTimeWithSecondsFmt.format(date)} IST`;
}

export function humanizeToken(value: string): string {
  const normalized = value.replace(/[_-]+/g, ' ').trim();
  if (!normalized) {
    return 'Unknown';
  }
  return normalized.replace(/\b\w/g, letter => letter.toUpperCase());
}

export function humanizeMode(mode: string): string {
  return humanizeToken(mode || 'normal');
}

export function getStatusTone(status: string): string {
  const value = status.toLowerCase();
  if (value.includes('fail') || value.includes('error')) {
    return 'failed';
  }
  if (value.includes('run') || value.includes('progress') || value.includes('queue')) {
    return 'running';
  }
  if (value.includes('success') || value.includes('done') || value.includes('complete')) {
    return 'success';
  }
  if (value.includes('pause') || value.includes('stop')) {
    return 'paused';
  }
  if (value.includes('skip') || value.includes('cancel')) {
    return 'skipped';
  }
  if (value.includes('warn')) {
    return 'warn';
  }
  return 'info';
}

export function getPriorityTone(priority: string): string {
  const value = priority.toLowerCase();
  if (value === 'high') {
    return 'priority-high';
  }
  if (value === 'medium') {
    return 'priority-medium';
  }
  if (value === 'low') {
    return 'priority-low';
  }
  return 'info';
}

export function getSidecarTone(status: string): 'good' | 'warn' | 'danger' | 'idle' {
  const value = status.toLowerCase();
  if (value.includes('error') || value.includes('fail') || value.includes('crash')) {
    return 'danger';
  }
  if (value.includes('running') || value.includes('healthy') || value.includes('online')) {
    return 'good';
  }
  if (value.includes('paused') || value.includes('starting')) {
    return 'warn';
  }
  return 'idle';
}

export function formatSidecarLine(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const level = mapPinoLevel(parsed.level);
    const message = typeof parsed.msg === 'string' ? parsed.msg : raw;
    const time = typeof parsed.time === 'string' ? parsed.time : new Date().toISOString();
    const stage = typeof parsed.stage === 'string' ? parsed.stage : '';
    const jobId = typeof parsed.jobId === 'string' ? parsed.jobId : '';
    const workflow = typeof parsed.workflow === 'string' ? parsed.workflow : '';

    const parts = [`[${formatTimestamp(time)}]`, `[${level}]`];
    if (workflow) parts.push(`[${workflow}]`);
    if (stage) parts.push(`[${stage}]`);
    if (jobId) parts.push(`[job=${jobId}]`);
    parts.push(message);
    return parts.join(' ');
  } catch {
    return raw;
  }
}

function mapPinoLevel(level: unknown): string {
  if (typeof level === 'number') {
    if (level >= 50) return 'ERROR';
    if (level >= 40) return 'WARN';
    if (level >= 30) return 'INFO';
    return 'DEBUG';
  }
  return 'INFO';
}
