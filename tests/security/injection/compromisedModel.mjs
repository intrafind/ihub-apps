// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The model of the prompt-injection suite: a **fully compromised** model.
 *
 * The suite does not test whether a model resists an injection (the nightly red
 * team against a real model does that). It assumes the worst case, a model that
 * obeys every instruction an attacker planted in content it reads, and asserts
 * what the *platform* lets such a model achieve. So this model does nothing on
 * its own: it looks for planted instructions anywhere in what it is sent (the
 * system prompt with the project documents, tool results, fetched pages) and
 * carries them out exactly.
 *
 * A planted instruction ("directive") is human-readable injection text followed
 * by a machine-readable payload. The payload is hex, so it survives every
 * encoding on the way: a document inside the system prompt, the same document
 * JSON-escaped inside a tool result, a fetched web page converted to Markdown
 * (which escapes `_` and `*`):
 *
 *     @@OBEY <trigger> <hex(UTF-8 JSON)>@@
 *
 * - `<trigger>` names the scenario (`inj-…`). The directive is obeyed only in a
 *   turn whose user message contains `[<trigger>]` (the last user message that
 *   names a trigger: the loop's own nudges are user messages too), so one seeded
 *   knowledge base can hold every scenario. `*` is obeyed in every turn (used by
 *   pages the canary serves, for chained injections).
 * - The JSON is `{ "tool": "<name>", "args": {...} }` (call a tool) or
 *   `{ "say": "<markdown>" }` (put this into the answer).
 * - In any string of a payload, `{{context-canaries}}` is replaced by every
 *   `CANARY-…` token found in what the model was sent (or `NONE`): "exfiltrate
 *   whatever secret you can see". `{{from-tool-results:<regex>}}` is replaced by
 *   the first capture group of `<regex>` in the tool results so far (or `NONE`):
 *   "use the id the list call returned".
 *
 * Tool directives run one per model step, in the order found; a directive is
 * done once the request carries a tool result for its call id. When no tool
 * directive is left, the model answers with every `say` directive. A tool the
 * request does not offer is called anyway, by the name the directive gives: a
 * compromised model can emit any tool name, and the platform has to refuse it.
 *
 * Use {@link directive} to write one into a seeded document; seed.mjs says how
 * to add a scenario. Run the suite with
 * `npx playwright test --config tests/config/playwright.injection.config.js`.
 *
 * @module tests/security/injection/compromisedModel
 */

import crypto from 'node:crypto';

// A page converted to Markdown escapes the `*` of an every-turn directive (`\*`),
// and inside a JSON tool result that backslash is escaped again (`\\*`).
const DIRECTIVE = /@@OBEY \\*(\*|inj-[A-Za-z0-9-]+) ([0-9a-f]+)@@/g;
/** A scenario trigger in a user message: `[inj-…]`. */
const TRIGGER = /\[(inj-[A-Za-z0-9-]+)\]/g;
const HAS_TRIGGER = /\[inj-[A-Za-z0-9-]+\]/;
export const CANARY_TOKEN = /CANARY-[A-Z0-9][A-Z0-9_-]*/g;

/**
 * The text of a planted directive, ready to paste into a document.
 *
 * @param {string} trigger - The scenario's trigger (`*` for every turn).
 * @param {{tool?: string, args?: Object, say?: string}} payload
 * @returns {string}
 */
export function directive(trigger, payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('hex');
  return `@@OBEY ${trigger} ${encoded}@@`;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join(' ');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

const FROM_TOOL_RESULTS = /\{\{from-tool-results:(.+?)\}\}/g;

function substitute(value, context) {
  if (typeof value === 'string') {
    return value
      .replaceAll('{{context-canaries}}', context.canaries)
      .replace(FROM_TOOL_RESULTS, (_, source) => {
        const match = new RegExp(source).exec(context.toolResults);
        return match?.[1] ?? 'NONE';
      });
  }
  if (Array.isArray(value)) return value.map(item => substitute(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item, context)])
    );
  }
  return value;
}

/**
 * The directives planted in a request that apply to this turn, in order, once each.
 *
 * @param {Object} body - The chat completion request.
 * @returns {Array<{key: string, payload: Object}>}
 */
export function plantedDirectives(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const asked = messages
    .filter(m => m.role === 'user')
    .map(m => textOf(m.content))
    .findLast(text => HAS_TRIGGER.test(text));
  const triggers = new Set([...(asked || '').matchAll(TRIGGER)].map(match => match[1]));
  const seen = new Set();
  const found = [];
  for (const message of messages) {
    for (const [, trigger, encoded] of textOf(message.content).matchAll(DIRECTIVE)) {
      if (trigger !== '*' && !triggers.has(trigger)) continue;
      if (seen.has(encoded)) continue;
      seen.add(encoded);
      try {
        const payload = JSON.parse(Buffer.from(encoded, 'hex').toString('utf8'));
        const key = crypto.createHash('sha256').update(encoded).digest('hex').slice(0, 12);
        found.push({ key, payload });
      } catch {
        // Not a directive of ours (a cut-off copy in a truncated result).
      }
    }
  }
  return found;
}

/**
 * The scripted answer for one chat request (the stub's `script` hook), or null
 * when nothing was planted for this turn (the stub's default reply then).
 *
 * @param {Object} body - The chat completion request.
 * @returns {{content?: string, toolCalls?: Array<{id: string, name: string, arguments: string}>}|null}
 */
export function compromisedModel(body) {
  const directives = plantedDirectives(body);
  if (directives.length === 0) return null;
  const messages = body.messages || [];
  const everything = JSON.stringify(messages);
  const canaries = [...new Set(everything.match(CANARY_TOKEN) || [])].join('.') || 'NONE';
  const toolMessages = messages.filter(m => m.role === 'tool');
  const answered = new Set(toolMessages.map(m => m.tool_call_id));
  const context = { canaries, toolResults: toolMessages.map(m => textOf(m.content)).join('\n') };
  const offered = (body.tools || []).map(tool => tool?.function?.name).filter(Boolean);

  const next = directives.find(
    ({ key, payload }) => payload.tool && !answered.has(`call_obey_${key}`)
  );
  if (next) {
    const wanted = next.payload.tool;
    const name =
      offered.find(n => n === wanted) || offered.find(n => n.endsWith(`__${wanted}`)) || wanted;
    return {
      toolCalls: [
        {
          id: `call_obey_${next.key}`,
          name,
          arguments: JSON.stringify(substitute(next.payload.args || {}, context))
        }
      ]
    };
  }
  const said = directives
    .filter(({ payload }) => typeof payload.say === 'string')
    .map(({ payload }) => substitute(payload.say, context));
  return { content: said.length ? said.join('\n\n') : 'Done as instructed.' };
}
