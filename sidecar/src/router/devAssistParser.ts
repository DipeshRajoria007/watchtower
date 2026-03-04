export type DevAssistCommand =
  | { type: 'HELP' }
  | { type: 'STATUS' }
  | { type: 'RUNS'; limit: number }
  | { type: 'FAILURES'; limit: number }
  | { type: 'TRACE'; jobId: string; limit: number }
  | { type: 'DIAGNOSE'; jobId: string }
  | { type: 'LEARN' }
  | { type: 'HEAT'; limit: number }
  | { type: 'PERSONALITY_SET'; mode: 'dark_humor' | 'professional' | 'friendly' | 'chaos'; scope: 'user' | 'channel' }
  | { type: 'PERSONALITY_SHOW'; scope: 'user' | 'channel' }
  | { type: 'MISSION_START'; goal: string }
  | { type: 'MISSION_SHOW' }
  | { type: 'MISSION_RUN_SWARM' }
  | { type: 'TRUST_SET'; target: 'channel' | 'user'; level: 'observe' | 'suggest' | 'execute' | 'merge' }
  | { type: 'REPLAY'; jobId: string }
  | { type: 'FORK'; jobId: string }
  | { type: 'SKILL_INSTALL'; name: string }
  | { type: 'SKILL_USE'; name: string };

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

  const personalitySetMatch = body.match(/^personality\s+set\s+([a-z_-]+)(?:\s+(channel|me))?\b/i);
  if (personalitySetMatch) {
    const modeRaw = personalitySetMatch[1].toLowerCase();
    const scopeRaw = (personalitySetMatch[2] ?? 'me').toLowerCase();
    const scope = scopeRaw === 'channel' ? 'channel' : 'user';

    const modeMap: Record<string, 'dark_humor' | 'professional' | 'friendly' | 'chaos'> = {
      dark: 'dark_humor',
      dark_humor: 'dark_humor',
      darkhumor: 'dark_humor',
      sus: 'dark_humor',
      professional: 'professional',
      serious: 'professional',
      friendly: 'friendly',
      polite: 'friendly',
      chaos: 'chaos',
      chaotic: 'chaos',
    };
    const mode = modeMap[modeRaw];
    if (mode) {
      return {
        type: 'PERSONALITY_SET',
        mode,
        scope,
      };
    }
  }

  const personalityShowMatch = body.match(/^personality\s+show(?:\s+(channel|me))?\b/i);
  if (personalityShowMatch) {
    const scopeRaw = (personalityShowMatch[1] ?? 'me').toLowerCase();
    const scope = scopeRaw === 'channel' ? 'channel' : 'user';
    return {
      type: 'PERSONALITY_SHOW',
      scope,
    };
  }

  const missionStartMatch = body.match(/^mission\s+start\s+(.+)$/i);
  if (missionStartMatch) {
    const goal = missionStartMatch[1]?.trim() ?? '';
    if (goal.length > 0) {
      return {
        type: 'MISSION_START',
        goal,
      };
    }
  }

  if (/^mission\s+show\b/i.test(body)) {
    return { type: 'MISSION_SHOW' };
  }

  if (/^mission\s+run\s+--swarm\b/i.test(body)) {
    return { type: 'MISSION_RUN_SWARM' };
  }

  const trustMatch = body.match(/^trust\s+(channel|user)\s+(observe|suggest|execute|merge)\b/i);
  if (trustMatch) {
    return {
      type: 'TRUST_SET',
      target: trustMatch[1].toLowerCase() as 'channel' | 'user',
      level: trustMatch[2].toLowerCase() as 'observe' | 'suggest' | 'execute' | 'merge',
    };
  }

  const replayMatch = body.match(/^replay\s+([a-z0-9-]{6,})\b/i);
  if (replayMatch) {
    return {
      type: 'REPLAY',
      jobId: replayMatch[1],
    };
  }

  const forkMatch = body.match(/^fork\s+([a-z0-9-]{6,})\b/i);
  if (forkMatch) {
    return {
      type: 'FORK',
      jobId: forkMatch[1],
    };
  }

  const skillInstallMatch = body.match(/^skill\s+install\s+([a-z0-9_.-]+)\b/i);
  if (skillInstallMatch) {
    return {
      type: 'SKILL_INSTALL',
      name: skillInstallMatch[1],
    };
  }

  const skillUseMatch = body.match(/^skill\s+use\s+([a-z0-9_.-]+)\b/i);
  if (skillUseMatch) {
    return {
      type: 'SKILL_USE',
      name: skillUseMatch[1],
    };
  }

  return undefined;
}

export function hasDevAssistCommand(text: string): boolean {
  return Boolean(parseDevAssistCommand(text));
}
