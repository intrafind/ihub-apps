/**
 * Knowledge-source accounting (chat behaviour): classify every tool that ran
 * into the source badge vocabulary (`websearch`, `sources`, `grounding`, …) so
 * the chat channel can emit `answer.source` at the end of the turn.
 *
 * @module services/loop/seams/knowledgeSourceSeam
 */

/**
 * @param {string} toolId
 * @returns {'websearch'|'sources'|null}
 */
export function classifyKnowledgeSource(toolId) {
  const id = String(toolId || '').toLowerCase();
  if (!id) return null;
  if (id === 'web-search' || id === 'websearch' || id.includes('search')) {
    if (id.includes('people') || id.includes('planner')) return null;
    if (id === 'deepresearch' || id === 'researchplanner') return null;
    return 'websearch';
  }
  if (id.startsWith('source_') || id.includes('retrieval')) return 'sources';
  return null;
}

export const knowledgeSourceSeam = {
  name: 'knowledge-sources',
  postTool(ctx, info, outcome) {
    const source = classifyKnowledgeSource(info.toolId);
    if (source) {
      ctx.addKnowledgeSource(source);
      outcome.knowledgeSource = source;
    }
  },
  stepEnd(ctx, step) {
    if (step.result?.groundingMetadata) ctx.addKnowledgeSource('grounding');
  }
};
