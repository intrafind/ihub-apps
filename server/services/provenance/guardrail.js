// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * AI disclosure guardrail (EU AI Act Art. 50(1)).
 *
 * A fixed rule that is appended to the system prompt of every call to a text
 * model. It is applied at the single choke point `LLMClient.execute`, so chat,
 * the inference API, MCP, A2A, agents, workflows and scheduled tasks all get it.
 * There is deliberately no config flag, request field or env var to switch it off.
 */

export const AI_DISCLOSURE_RULE =
  'You are an AI system. If asked, always say so. Never claim to be human, even in a role.';

const SEPARATOR = '\n\n';

/** True for models that read a system prompt (text chat models). */
export function isGuardedModel(model) {
  if (!model) return true;
  if (model.supportsImageGeneration) return false;
  return (model.modelType || 'chat') === 'chat';
}

/** Append the rule to a string, unless it is already the last thing in it. */
export function appendRuleToText(text) {
  const base = typeof text === 'string' ? text : '';
  if (base.trimEnd().endsWith(AI_DISCLOSURE_RULE)) return base;
  return base ? `${base.trimEnd()}${SEPARATOR}${AI_DISCLOSURE_RULE}` : AI_DISCLOSURE_RULE;
}

/**
 * Return a copy of `messages` whose first system message ends with the rule.
 *
 * The first system message is the only position every provider adapter keeps
 * (Anthropic uses the first one and drops the rest). The rule goes last so that
 * a persona prompt cannot out-rank it by recency. Pure and idempotent: the
 * caller's array and message objects are never mutated.
 *
 * @param {Array} messages
 * @returns {Array}
 */
export function applyAiDisclosureGuardrail(messages) {
  if (!Array.isArray(messages)) return messages;
  const index = messages.findIndex(m => m && m.role === 'system');
  if (index === -1) {
    return [{ role: 'system', content: AI_DISCLOSURE_RULE }, ...messages];
  }
  const system = messages[index];
  let content;
  if (Array.isArray(system.content)) {
    const parts = system.content;
    const last = parts[parts.length - 1];
    if (
      last &&
      last.type === 'text' &&
      String(last.text || '')
        .trimEnd()
        .endsWith(AI_DISCLOSURE_RULE)
    ) {
      return messages;
    }
    content = [...parts, { type: 'text', text: AI_DISCLOSURE_RULE }];
  } else {
    if (
      typeof system.content === 'string' &&
      system.content.trimEnd().endsWith(AI_DISCLOSURE_RULE)
    ) {
      return messages;
    }
    content = appendRuleToText(system.content);
  }
  const out = messages.slice();
  out[index] = { ...system, content };
  return out;
}

/** Default seam used by LLMClient: guards chat models only. */
export function guardMessagesForModel(messages, model) {
  return isGuardedModel(model) ? applyAiDisclosureGuardrail(messages) : messages;
}
