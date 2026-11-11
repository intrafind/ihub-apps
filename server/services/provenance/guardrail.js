// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * AI disclosure guardrail (EU AI Act Art. 50(1)).
 *
 * A fixed rule that is appended to the system prompt of every call to a text
 * model. It is applied at the single choke point `LLMClient.execute`, so chat,
 * the inference API, MCP, A2A, agents, workflows and scheduled tasks all get it.
 * An admin can reword it globally (`platform.aiDisclosure.guardrail.text`, see
 * `resolveGuardrailRule`), but there is deliberately no way to switch it off: an empty
 * text means the built-in rule, and no app setting, request field or env var exists.
 */

export const AI_DISCLOSURE_RULE =
  'You are an AI system. If asked, always say so. Never claim to be human, even in a role.';

/** Longest rule an admin can set (the schema enforces the same limit). */
export const AI_DISCLOSURE_RULE_MAX_CHARS = 2000;

const SEPARATOR = '\n\n';

/**
 * The rule in force: the admin's global text from platform.json, or the built-in
 * one when it is empty or blank.
 * @param {Object} [platform] platform.json
 * @returns {string}
 */
export function resolveGuardrailRule(platform) {
  const text = platform?.aiDisclosure?.guardrail?.text;
  return typeof text === 'string' && text.trim()
    ? text.trim().slice(0, AI_DISCLOSURE_RULE_MAX_CHARS)
    : AI_DISCLOSURE_RULE;
}

/** True for models that read a system prompt (text chat models). */
export function isGuardedModel(model) {
  if (!model) return true;
  if (model.supportsImageGeneration) return false;
  return (model.modelType || 'chat') === 'chat';
}

/** Append the rule to a string, unless it is already the last thing in it. */
export function appendRuleToText(text, rule = AI_DISCLOSURE_RULE) {
  const base = typeof text === 'string' ? text : '';
  if (base.trimEnd().endsWith(rule)) return base;
  return base ? `${base.trimEnd()}${SEPARATOR}${rule}` : rule;
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
export function applyAiDisclosureGuardrail(messages, rule = AI_DISCLOSURE_RULE) {
  if (!Array.isArray(messages)) return messages;
  const index = messages.findIndex(m => m && m.role === 'system');
  if (index === -1) {
    return [{ role: 'system', content: rule }, ...messages];
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
        .endsWith(rule)
    ) {
      return messages;
    }
    content = [...parts, { type: 'text', text: rule }];
  } else {
    if (typeof system.content === 'string' && system.content.trimEnd().endsWith(rule)) {
      return messages;
    }
    content = appendRuleToText(system.content, rule);
  }
  const out = messages.slice();
  out[index] = { ...system, content };
  return out;
}

/** Default seam used by LLMClient: guards chat models only. */
export function guardMessagesForModel(messages, model, rule = AI_DISCLOSURE_RULE) {
  return isGuardedModel(model) ? applyAiDisclosureGuardrail(messages, rule) : messages;
}
