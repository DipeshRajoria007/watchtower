import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import { formatDossierForPrompt } from '../../state/dossierStore.js';
import { assembleRecall } from '../../codex/recallAssembler.js';

const dossierArgsSchema = z.object({});

export const getUserDossierSelfTool: ToolDefinition<typeof dossierArgsSchema> = {
  name: 'get_user_dossier_self',
  description:
    "Read the caller's stored dossier — what miniOG knows about them (role, repo affinity, recent activity, pinned facts). Use sparingly; most replies don't need it.",
  capability: 'miniog_dossier_self',
  inputSchema: dossierArgsSchema,
  inputJsonSchema: { type: 'object', properties: {}, required: [] },
  handler: async (_args, context): Promise<ToolResult> => {
    try {
      const dossierStore = context.store.dossierStore();
      const dossier = dossierStore.getDossier(context.task.event.userId);
      const formatted = formatDossierForPrompt(dossier);
      return {
        content: formatted || 'No dossier on file for this user.',
        data: { hasDossier: Boolean(dossier.profile) },
      };
    } catch (err) {
      return { content: `Could not read dossier: ${String(err)}`, isError: true };
    }
  },
};

const recallArgsSchema = z.object({
  workflow: z.enum(['INFORMATIONAL', 'CONVERSATIONAL', 'INVESTIGATION', 'IMPLEMENTATION', 'PR_REVIEW']).optional(),
  token_budget: z.number().int().positive().max(2000).optional(),
});

export const recallUserSignalsTool: ToolDefinition<typeof recallArgsSchema> = {
  name: 'recall_user_signals',
  description:
    'Pull a long-context recall block for the caller — recent signals, preferred response style, common asks. Use when the request is open-ended ("what should I do next?") and you need to ground in the user\'s history.',
  capability: 'miniog_dossier_self',
  inputSchema: recallArgsSchema,
  inputJsonSchema: {
    type: 'object',
    properties: {
      workflow: {
        type: 'string',
        enum: ['INFORMATIONAL', 'CONVERSATIONAL', 'INVESTIGATION', 'IMPLEMENTATION', 'PR_REVIEW'],
        description: 'Which workflow context to assemble for. Defaults to the current task intent.',
      },
      token_budget: { type: 'integer', minimum: 1, maximum: 2000, description: 'Token budget for the recall block.' },
    },
    required: [],
  },
  handler: async (args, context): Promise<ToolResult> => {
    try {
      const recall = await assembleRecall({
        userId: context.task.event.userId,
        workflow: args.workflow ?? (context.task.intent as 'INFORMATIONAL'),
        store: context.store,
        vaultRoot: context.store.readVaultSettings?.().vaultPath ?? null,
        tokenBudget: args.token_budget,
      });
      return {
        content: recall.promptBlock || 'No recall content for this user.',
        data: { estimatedTokens: recall.estimatedTokens, sources: recall.sources },
      };
    } catch (err) {
      return { content: `Could not assemble recall: ${String(err)}`, isError: true };
    }
  },
};
