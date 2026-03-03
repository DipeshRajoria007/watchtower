export type DevAssistCommand =
  | { type: 'HELP' }
  | { type: 'STATUS' };

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

  return undefined;
}

export function hasDevAssistCommand(text: string): boolean {
  return Boolean(parseDevAssistCommand(text));
}
