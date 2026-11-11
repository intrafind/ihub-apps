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

/** The message with the rule appended as its last text (unchanged when it already ends with it). */
function withRule(system, rule) {
  if (Array.isArray(system.content)) {
    const last = system.content[system.content.length - 1];
    if (
      last?.type === 'text' &&
      String(last.text || '')
        .trimEnd()
        .endsWith(rule)
    )
      return system;
    return { ...system, content: [...system.content, { type: 'text', text: rule }] };
  }
  const content = appendRuleToText(system.content, rule);
  return content === system.content ? system : { ...system, content };
}

/**
 * Return a copy of `messages` whose system prompt ends with the rule.
 *
 * The first system message always gets it: it is the only one every provider adapter
 * keeps (Anthropic uses the first and drops the rest). Adapters that forward every
 * system message (OpenAI-compatible) would then send a later one after the rule, so
 * when there are several the last one ends with the rule too: whichever the model
 * reads last, the rule comes last. The rule goes at the end so a persona prompt cannot
 * out-rank it by recency. Pure and idempotent: the caller's array and message objects
 * are never mutated.
 *
 * @param {Array} messages
 * @param {string} [rule]
 * @returns {Array}
 */
export function applyAiDisclosureGuardrail(messages, rule = AI_DISCLOSURE_RULE) {
  if (!Array.isArray(messages)) return messages;
  const systemAt = messages.map((m, i) => (m?.role === 'system' ? i : -1)).filter(i => i >= 0);
  if (systemAt.length === 0) {
    return [{ role: 'system', content: rule }, ...messages];
  }
  const out = messages.slice();
  for (const index of new Set([systemAt[0], systemAt[systemAt.length - 1]])) {
    out[index] = withRule(messages[index], rule);
  }
  return out;
}

/** Default seam used by LLMClient: guards chat models only. */
export function guardMessagesForModel(messages, model, rule = AI_DISCLOSURE_RULE) {
  return isGuardedModel(model) ? applyAiDisclosureGuardrail(messages, rule) : messages;
}
