import { z } from 'zod';

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
    modelId: z.string().optional()
  })
};

export const magicPromptSchema = {
  body: z.object({
    input: z.string().min(1),
    prompt: z.string().optional(),
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
    temperature: z.any().optional(),
    style: z.string().optional(),
    outputFormat: z.string().optional(),
    language: z.string().optional(),
    useMaxTokens: z.any().optional(),
    bypassAppPrompts: z.any().optional(),
    thinkingEnabled: z.boolean().optional(),
    thinkingBudget: z.number().optional(),
    thinkingThoughts: z.boolean().optional(),
    enabledTools: z.array(z.string()).optional(),
    imageConfig: z
      .object({
        aspectRatio: z
          .enum(['1:1', '16:9', '9:16', '5:4', '4:5', '3:2', '2:3', '3:4', '4:3', '21:9'])
          .optional(),
        imageSize: z.enum(['1K', '2K', '4K']).optional()
      })
      .optional()
  })
};
