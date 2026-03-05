/**
 * Migration V013 — Add iAssistant Conversation model configuration
 *
 * Copies the iassistant-conversation model default if not already present.
 */

export const version = '013';
export const description = 'Add iAssistant Conversation model configuration';

export async function precondition(ctx) {
  // Only run if the model file does not already exist
  const exists = await ctx.fileExists('models/iassistant-conversation.json');
  return !exists;
}

export async function up(ctx) {
  const defaultModel = await ctx.readDefaultJson('models/iassistant-conversation.json');
  if (!defaultModel) {
    ctx.warn('Default iassistant-conversation model config not found in defaults');
    return;
  }

  await ctx.writeJson('models/iassistant-conversation.json', defaultModel);
  ctx.log('Added iassistant-conversation model configuration');
}
