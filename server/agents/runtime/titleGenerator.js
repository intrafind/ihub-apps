/**
 * Title Generator
 *
 * Fire-and-forget LLM call that produces a short, human-friendly title for
 * an agent run based on the inbox item / brief that triggered it. The title
 * is persisted to `state.data._title` via the state manager and surfaces in
 * the run detail UI header (e.g. "Recherche: Daniel Manzke").
 *
 * Why a separate LLM call instead of a heuristic: titles benefit from
 * normalisation (strip leading verbs like "Recherchiere", drop trailing
 * punctuation, translate to the operator's language). A 1-line LLM call
 * with a fast model is cheap (<200 tokens, <2s) and produces better
 * titles than a naive truncation of the raw inbox text.
 *
 * Failure mode: any error here MUST NOT affect the run. The title is a
 * nice-to-have; the run completes regardless. Errors are logged at warn
 * level and the UI falls back to the inbox item text.
 */

import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import WorkflowLLMHelper from '../../services/workflow/WorkflowLLMHelper.js';

function pickTitleModel(preferredModelId) {
  try {
    const { data: models = [] } = configCache.getModels?.() || { data: [] };
    const textCapable = models.filter(m => m.enabled !== false && !m.supportsImageGeneration);
    if (textCapable.length === 0) return null;
    // Prefer the caller's profile model — that's the one they've already
    // verified has API access for this run. Falls back to the platform
    // default, then to the first text-capable model.
    if (preferredModelId) {
      const fromProfile = textCapable.find(m => m.id === preferredModelId);
      if (fromProfile) return fromProfile;
    }
    const def = textCapable.find(m => m.default);
    return def || textCapable[0];
  } catch {
    return null;
  }
}

function shortenSource(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 600);
}

/**
 * Generate and persist a title for the given run. Fire-and-forget; never
 * throws back to the caller — failures are logged.
 *
 * @param {object} args
 * @param {string} args.executionId  - The run id (used as the state key).
 * @param {string} [args.brief]      - The trigger brief.
 * @param {string} [args.inboxText]  - The picked inbox item's text, if any.
 * @param {string} [args.language]   - User's language (en|de|…).
 */
export function generateRunTitleAsync({
  executionId,
  brief,
  inboxText,
  preferredModelId,
  language = 'en'
}) {
  // Run the whole thing in a detached promise — the caller doesn't wait.
  (async () => {
    if (!executionId) return;

    const model = pickTitleModel(preferredModelId);
    if (!model) {
      logger.warn('Title generation skipped: no text-capable model available', {
        component: 'TitleGenerator',
        executionId,
        requestedModelId: preferredModelId
      });
      return;
    }
    logger.info('Title generation starting', {
      component: 'TitleGenerator',
      executionId,
      modelId: model.id
    });

    const source = shortenSource(inboxText) || shortenSource(brief);
    if (!source) {
      logger.debug('Title generation skipped: no source text', {
        component: 'TitleGenerator',
        executionId
      });
      return;
    }

    const helper = new WorkflowLLMHelper();
    let title;
    try {
      const apiKeyResult = await helper.verifyApiKey(model, language);
      if (!apiKeyResult.success) {
        logger.warn('Title generation skipped: API key verification failed', {
          component: 'TitleGenerator',
          modelId: model.id,
          executionId,
          error: apiKeyResult.error?.message
        });
        return;
      }
      const messages = [
        {
          role: 'system',
          content:
            'You generate SHORT, CRISP titles for agent runs — like a ' +
            'news headline or a tab title, not a sentence. ' +
            'Strict rules:\n' +
            '- 3 to 6 words maximum.\n' +
            '- No quotes, no trailing punctuation, no "Run:" / "Task:" / ' +
            '  "Title:" prefix.\n' +
            '- No filler verbs like "Research", "Investigate", "Find out" ' +
            '  unless they are the actual core action.\n' +
            "- Match the source's language (German source → German title).\n" +
            '- Lead with the subject (person, topic, system, …), not the verb.\n' +
            'Examples:\n' +
            '  Source: "Recherchiere wer Daniel Manzke ist?"\n' +
            '    → Title: Profil Daniel Manzke\n' +
            '  Source: "Investigate yesterday\'s checkout 500 errors"\n' +
            '    → Title: Checkout 500s yesterday\n' +
            '  Source: "Find recent papers on retrieval-augmented generation"\n' +
            '    → Title: Recent RAG papers'
        },
        { role: 'user', content: `Source:\n${source}\n\nTitle:` }
      ];
      const response = await helper.executeStreamingRequest({
        model,
        messages,
        apiKey: apiKeyResult.apiKey,
        options: { temperature: 0.2, maxTokens: 24 },
        language
      });
      title = (response?.content || '').replace(/^["'\s]+|["'\s.,!?:]+$/g, '').trim();
      // Hard guards: single line, max 60 chars (≈ 6 short words).
      title = title.split('\n')[0].slice(0, 60).trim();
    } catch (err) {
      logger.warn('Title generation failed', {
        component: 'TitleGenerator',
        executionId,
        error: err.message
      });
      return;
    }

    if (!title) return;

    try {
      const { getStateManager } = await import('../../services/workflow/StateManager.js');
      const stateManager = getStateManager();
      await stateManager.update(executionId, { data: { _title: title } });
      logger.info('Run title generated', {
        component: 'TitleGenerator',
        executionId,
        title
      });
    } catch (err) {
      logger.warn('Failed to persist run title', {
        component: 'TitleGenerator',
        executionId,
        error: err.message
      });
    }
  })().catch(err => {
    logger.warn('Detached title generation rejected', {
      component: 'TitleGenerator',
      error: err.message
    });
  });
}

export default { generateRunTitleAsync };
