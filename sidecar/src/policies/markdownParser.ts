export interface PolicyRule {
  id: string;
  tier: 'critical-deny' | 'non-master';
  description: string;
  matchTerms: string[];
}

export interface PolicyFile {
  tier: 'critical-deny' | 'non-master';
  description: string;
  rules: PolicyRule[];
}

/**
 * Parses a markdown policy file with YAML frontmatter.
 *
 * Expected format:
 * ```markdown
 * ---
 * tier: critical-deny
 * description: Rules that apply to all users
 * ---
 *
 * ## rule-id
 * Description of the rule.
 * match: term1, term2, term3
 * ```
 */
export function parsePolicyMarkdown(content: string): PolicyFile | undefined {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return undefined;
  }

  const frontmatter = fmMatch[1];
  const body = content.slice(fmMatch[0].length).trim();

  const tierMatch = frontmatter.match(/^tier:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

  const rawTier = tierMatch?.[1]?.trim() ?? '';
  if (rawTier !== 'critical-deny' && rawTier !== 'non-master') {
    return undefined;
  }

  const tier = rawTier;
  const description = descMatch?.[1]?.trim() ?? '';

  const rules: PolicyRule[] = [];
  const ruleBlocks = body.split(/^##\s+/m).filter(Boolean);

  for (const block of ruleBlocks) {
    const lines = block.trim().split('\n');
    const id = lines[0]?.trim() ?? '';
    if (!id) continue;

    const ruleDescription = lines
      .slice(1)
      .filter(l => !l.startsWith('match:'))
      .map(l => l.trim())
      .filter(Boolean)
      .join(' ');

    const matchLine = lines.find(l => l.trim().startsWith('match:'));
    const matchTerms = matchLine
      ? matchLine
          .replace(/^match:\s*/i, '')
          .split(',')
          .map(t => t.trim().toLowerCase())
          .filter(Boolean)
      : [];

    rules.push({
      id,
      tier,
      description: ruleDescription,
      matchTerms,
    });
  }

  return { tier, description, rules };
}
