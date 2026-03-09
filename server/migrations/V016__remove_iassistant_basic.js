/**
 * Migration V016 — Remove old iAssistant (Basic) model and demo app
 *
 * The iAssistant (Basic) one-shot RAG integration has been removed.
 * Only the iAssistant (Workspace) Conversation API integration is supported.
 * This migration removes any deployed iassistant model and iassistant-demo app files.
 */

export const version = '016';
export const description = 'remove_iassistant_basic';

export async function up(ctx) {
  let changed = false;

  if (await ctx.fileExists('models/iassistant.json')) {
    await ctx.deleteFile('models/iassistant.json');
    ctx.log('Removed old iAssistant (Basic) model configuration');
    changed = true;
  }

  if (await ctx.fileExists('apps/iassistant-demo.json')) {
    await ctx.deleteFile('apps/iassistant-demo.json');
    ctx.log('Removed old iAssistant RAG Demo app configuration');
    changed = true;
  }

  if (!changed) {
    ctx.log('No old iAssistant (Basic) files found, nothing to remove');
  }
}
