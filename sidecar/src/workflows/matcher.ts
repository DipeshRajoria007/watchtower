import type { WorkflowTemplate } from './registry.js';

/**
 * Scores how well a user message matches a workflow template.
 * Returns a number between 0 and 1.
 */
function scoreMatch(text: string, template: WorkflowTemplate): number {
  const normalized = text.toLowerCase().trim();
  let score = 0;
  let maxScore = 0;

  // Trigger phrase match (high weight — exact substring match)
  if (template.triggers.length > 0) {
    maxScore += 3;
    for (const trigger of template.triggers) {
      if (normalized.includes(trigger.toLowerCase())) {
        score += 3;
        break;
      }
    }
  }

  // Keyword match (lower weight — count how many keywords appear)
  if (template.keywords.length > 0) {
    maxScore += 2;
    let keywordHits = 0;
    for (const keyword of template.keywords) {
      if (normalized.includes(keyword.toLowerCase())) {
        keywordHits++;
      }
    }
    if (template.keywords.length > 0) {
      score += 2 * (keywordHits / template.keywords.length);
    }
  }

  return maxScore > 0 ? score / maxScore : 0;
}

/**
 * Finds the best matching workflow template for a user message.
 * Returns undefined if no template matches above the threshold.
 */
export function matchWorkflowTemplate(
  text: string,
  templates: WorkflowTemplate[],
  threshold = 0.4
): WorkflowTemplate | undefined {
  let bestTemplate: WorkflowTemplate | undefined;
  let bestScore = 0;

  for (const template of templates) {
    const score = scoreMatch(text, template);
    if (score > bestScore && score >= threshold) {
      bestScore = score;
      bestTemplate = template;
    }
  }

  return bestTemplate;
}
