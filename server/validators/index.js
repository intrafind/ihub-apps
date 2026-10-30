// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { z } from 'zod';
import { mcpAppContextSchema } from '../services/mcp/mcpAppContext.js';
export { zSafeId } from './common.js';

export {
  auditEntrySchema,
  validateAuditEntry,
  auditActions,
  auditResults,
  auditSources
} from './auditEntrySchema.js';

export const startSessionSchema = {
  body: z.object({
    sessionId: z.string().min(1),
    type: z.string().optional(),
    metadata: z.record(z.any()).optional()
  })
};

export const feedbackSchema = {
  body: z.object({
    messageId: z.string().min(1),
    appId: z.string().min(1),
    chatId: z.string().min(1),
    messageContent: z.string().optional(),
    rating: z
      .number()
      .min(0.5, 'Rating must be at least 0.5')
      .max(5, 'Rating must be at most 5')
      .refine(val => val % 0.5 === 0, {
        message: 'Rating must be in 0.5 increments (0.5, 1.0, 1.5, ..., 5.0)'
      }),
    feedback: z.string().optional(),
    modelId: z.string().optional(),
    conversationId: z.string().optional(),
    ifinderMessageId: z.string().optional(),
    /** Run the rated message belongs to — records a `human/event` on its ledger. */
    runId: z.string().optional()
  })
};

export const magicPromptSchema = {
  // The instruction is resolved on the server from the app's configuration.
  body: z.object({
    input: z.string().min(1),
    modelId: z.string().optional(),
    appId: z.string().optional()
  })
};

export const runToolSchema = {
  params: z.object({ toolId: z.string().min(1) }),
  body: z.record(z.any()).optional(),
  query: z.record(z.any()).optional()
};

export const chatTestSchema = {
  params: z.object({ modelId: z.string().min(1) })
};

export const chatConnectSchema = {
  params: z.object({
    appId: z.string().min(1),
    chatId: z.string().min(1)
  })
};

export const chatPostSchema = {
  params: z.object({
    appId: z.string().min(1),
    chatId: z.string().min(1)
  }),
  body: z.object({
    messages: z.array(z.any()),
    modelId: z.string().optional(),
    style: z.string().optional(),
    outputFormat: z.string().optional(),
    language: z.string().optional(),
    bypassAppPrompts: z.any().optional(),
    thinkingEnabled: z.boolean().optional(),
    thinkingLevel: z
      .enum(['minimal', 'low', 'medium', 'high', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH'])
      .optional(),
    thinkingThoughts: z.boolean().optional(),
    enabledTools: z.array(z.string()).optional(),
    websearchEnabled: z.boolean().optional(),
    imageAspectRatio: z.string().optional(),
    imageQuality: z.string().optional(),
    requestedSkills: z.array(z.string().max(64)).max(10).optional(),
    documentIds: z.array(z.string()).optional(),
    /**
     * MCP Apps: the latest `ui/update-model-context` of each open view, handed
     * to the model with this turn only (see services/mcp/mcpAppContext.js).
     */
    mcpAppContext: mcpAppContextSchema.optional(),
    /**
     * Stored message id to fork the persisted history from (inclusive) — an
     * edit or a regenerate. Ignored unless the chat is persisted.
     */
    replaceFromMessageId: z.string().optional(),
    /**
     * The turn is incognito: never written to the chat store. Client-asserted
     * and therefore advisory — it can only ever turn persistence off.
     */
    ephemeral: z.boolean().optional(),
    /**
     * The viewer's "Include chat history in requests" setting, off. Every
     * non-persisted surface says this by posting a one-element array; a
     * persisted chat posts one message whatever the setting, so it has to say
     * so out loud or the server would prepend the stored transcript anyway.
     * Like the app-level flag it can only ever remove history, never add it.
     */
    sendChatHistory: z.boolean().optional(),
    /**
     * The message was spoken in voice mode and the answer will be read aloud:
     * the server adds the voice style instruction, a low thinking level and
     * marks the stored message (services/chat/voiceMode.js). Ignored unless
     * voice mode is enabled on the platform.
     */
    voiceMode: z.boolean().optional(),
    /**
     * Projects (#1036): the chat's container project, or null to run it in
     * none, and the projects attached from the picker for this turn. Checked
     * against the caller's access in the route (`resolveChatProjects`).
     */
    projectId: z.string().max(200).nullable().optional(),
    projects: z.array(z.string().max(200)).max(20).optional(),
    /**
     * The scope picked per integration for this chat (#3050), e.g.
     * `{ ifinder: 'contracts' }`. Checked against what each integration
     * offers the user in the route (`resolveChatScopes`).
     */
    integrationScopes: z.record(z.string().max(64), z.string().max(256)).optional()
  })
};
