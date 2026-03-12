export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
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

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
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

    const parts = [`[${time}]`, `[${level}]`];
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
