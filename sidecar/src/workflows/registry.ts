import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logging/logger.js';

export interface WorkflowTemplate {
  name: string;
  description: string;
  triggers: string[];
  keywords: string[];
  environment?: string;
  promptTemplate: string;
}

const DEFAULT_WORKFLOWS_DIR = path.resolve(process.cwd(), '.workflows');

let templates: WorkflowTemplate[] = [];

/**
 * Parses a workflow.yaml file with simple YAML key:value pairs.
 * Does NOT use a full YAML parser — handles the subset needed.
 */
function parseWorkflowYaml(content: string): Partial<WorkflowTemplate> {
  const result: Record<string, string | string[]> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    if (key === 'triggers' || key === 'keywords') {
      result[key] = value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else {
      result[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }

  return {
    name: typeof result.name === 'string' ? result.name : undefined,
    description: typeof result.description === 'string' ? result.description : undefined,
    triggers: Array.isArray(result.triggers) ? result.triggers : [],
    keywords: Array.isArray(result.keywords) ? result.keywords : [],
    environment: typeof result.environment === 'string' ? result.environment : undefined,
  };
}

/**
 * Loads workflow templates from the .workflows/ directory.
 * Each subdirectory should contain workflow.yaml and prompt.md.
 */
export function loadWorkflowTemplates(workflowsDir?: string): void {
  const dir = workflowsDir ?? DEFAULT_WORKFLOWS_DIR;
  templates = [];

  if (!fs.existsSync(dir)) {
    logger.info({ dir }, 'no .workflows directory found, file-based workflows inactive');
    return;
  }

  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    const stat = fs.statSync(entryPath);
    if (!stat.isDirectory()) continue;

    const yamlPath = path.join(entryPath, 'workflow.yaml');
    const promptPath = path.join(entryPath, 'prompt.md');

    if (!fs.existsSync(yamlPath) || !fs.existsSync(promptPath)) {
      logger.warn({ workflow: entry }, 'workflow directory missing workflow.yaml or prompt.md, skipping');
      continue;
    }

    try {
      const yamlContent = fs.readFileSync(yamlPath, 'utf8');
      const promptTemplate = fs.readFileSync(promptPath, 'utf8');
      const parsed = parseWorkflowYaml(yamlContent);

      const template: WorkflowTemplate = {
        name: parsed.name || entry,
        description: parsed.description || '',
        triggers: parsed.triggers || [],
        keywords: parsed.keywords || [],
        environment: parsed.environment,
        promptTemplate,
      };

      templates.push(template);
      logger.info(
        { name: template.name, triggers: template.triggers.length, keywords: template.keywords.length },
        'loaded workflow template',
      );
    } catch (error) {
      logger.warn({ workflow: entry, error: String(error) }, 'failed to load workflow template');
    }
  }

  logger.info({ count: templates.length }, 'workflow template registry loaded');
}

export function getWorkflowTemplates(): WorkflowTemplate[] {
  return templates;
}

export function findTemplateByName(name: string): WorkflowTemplate | undefined {
  return templates.find(t => t.name.toLowerCase() === name.toLowerCase());
}
