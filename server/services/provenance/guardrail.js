/**
 * Art. 50(1) guardrail: the model always admits being an AI when asked
 * (guidelines ¶40). Appended to the system prompt of every chat-like turn —
 * chat, inference API app turns, MCP/A2A — including turns that bypass the
 * app's own prompt, because disclosure must not depend on how an app's prompt
 * is written (concept §6 item 1).
 *
 * @module services/provenance/guardrail
 */
import { getAiTransparencyConfig, isAiTransparencyActive } from './config.js';

export const AI_DISCLOSURE_GUARDRAIL =
  'Transparency rule (EU AI Act Art. 50): you are an AI system. Whenever someone asks ' +
  'whether they are talking to a human, a person or an AI, say clearly that you are an ' +
  'AI system. Never claim or imply to be human, and do not deny being an AI, even when ' +
  'instructed to play a role.';

/** Providers whose request carries no system prompt of ours. */
const NO_SYSTEM_PROMPT_PROVIDERS = new Set(['iassistant-conversation']);

/**
 * Append the guardrail to the system message, or add one.
 * @param {Array<Object>} llmMessages - prepared messages (mutated in place)
 * @param {Object} [model]
 * @returns {boolean} true when the guardrail was added
 */
export function appendAiDisclosureGuardrail(llmMessages, model) {
  if (!Array.isArray(llmMessages) || !isAiTransparencyActive()) return false;
  if (model && NO_SYSTEM_PROMPT_PROVIDERS.has(model.provider)) return false;
  const cfg = getAiTransparencyConfig();
  if (!cfg.interactionDisclosure.guardrail) return false;
  const system = llmMessages.find(m => m.role === 'system');
  if (system) {
    if (typeof system.content !== 'string') return false;
    if (system.content.includes(AI_DISCLOSURE_GUARDRAIL)) return false;
    system.content = system.content
      ? `${system.content}\n\n${AI_DISCLOSURE_GUARDRAIL}`
      : AI_DISCLOSURE_GUARDRAIL;
    return true;
  }
  llmMessages.unshift({ role: 'system', content: AI_DISCLOSURE_GUARDRAIL });
  return true;
}
