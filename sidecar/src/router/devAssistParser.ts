export type DevAssistCommand =
  | { type: 'HELP' }
  | { type: 'STATUS' }
  | { type: 'RUNS'; limit: number }
  | { type: 'FAILURES'; limit: number }
  | { type: 'TRACE'; jobId: string; limit: number }
  | { type: 'DIAGNOSE'; jobId: string }
  | { type: 'LEARN' }
  | { type: 'HEAT'; limit: number };

function stripMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripPrefix(text: string): string | undefined {
  const cleaned = stripMentions(text);
  const match = cleaned.match(/^(wt|watchtower)\b\s*(.*)$/i);
  if (!match) {
    return undefined;
  }
  return match[2]?.trim() ?? '';
}

export function parseDevAssistCommand(text: string): DevAssistCommand | undefined {
  const body = stripPrefix(text);
  if (body === undefined) {
    return undefined;
  }

  if (!body || /^help\b|^commands\b|^\?$/.test(body.toLowerCase())) {
    return { type: 'HELP' };
  }

  if (/^status\b/.test(body.toLowerCase())) {
    return { type: 'STATUS' };
  }

  const runsMatch = body.match(/^runs(?:\s+(\d+))?\b/i);
  if (runsMatch) {
    const rawLimit = Number(runsMatch[1] ?? '5');
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 20) : 5;
    return { type: 'RUNS', limit };
  }

  const failuresMatch = body.match(/^failures(?:\s+(\d+))?\b/i);
  if (failuresMatch) {
    const rawLimit = Number(failuresMatch[1] ?? '5');
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 20) : 5;
    return { type: 'FAILURES', limit };
  }

  const traceMatch = body.match(/^trace\s+([a-z0-9-]{6,})(?:\s+(\d+))?\b/i);
  if (traceMatch) {
    const rawLimit = Number(traceMatch[2] ?? '20');
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;
    return {
      type: 'TRACE',
      jobId: traceMatch[1],
      limit,
    };
  }

  const diagnoseMatch = body.match(/^diagnose\s+([a-z0-9-]{6,})\b/i);
  if (diagnoseMatch) {
    return {
      type: 'DIAGNOSE',
      jobId: diagnoseMatch[1],
    };
  }

  if (/^learn\b|^learning\b/.test(body.toLowerCase())) {
    return { type: 'LEARN' };
  }

  const heatMatch = body.match(/^heat(?:\s+(\d+))?\b/i);
  if (heatMatch) {
    const rawLimit = Number(heatMatch[1] ?? '5');
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 20) : 5;
    return { type: 'HEAT', limit };
  }

  return undefined;
}

export function hasDevAssistCommand(text: string): boolean {
  return Boolean(parseDevAssistCommand(text));
}
