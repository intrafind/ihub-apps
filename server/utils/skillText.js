// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Conditional text in the instructions of a system skill.
 *
 * A skill that sends the model to another skill must do so only in an app that
 * has that skill: a pointer to a skill the model cannot activate sends it to a
 * tool it does not have. A system skill's `SKILL.md` marks such text with HTML
 * comments, which Markdown formatters leave alone:
 *
 *     <!-- if-skill dashboard -->
 *     Activate the dashboard skill.
 *     <!-- else -->
 *     Write the HTML yourself.
 *     <!-- /if-skill -->
 *
 * The first part stays when the skill is among the skills the app offers, the
 * `<!-- else -->` part (optional) when it is not. The kept text is trimmed and
 * takes the place of the whole block; blank lines the block leaves behind are
 * collapsed. Blocks do not nest.
 *
 * @module utils/skillText
 */

const BLOCK_RE =
  /<!--\s*if-skill\s+([a-z0-9-]+)\s*-->([\s\S]*?)(?:<!--\s*else\s*-->([\s\S]*?))?<!--\s*\/if-skill\s*-->/g;

/**
 * The text with each `if-skill` block resolved.
 *
 * @param {string} text - Skill instructions
 * @param {Iterable<string>} [available] - Names of the skills the app offers;
 *   none when omitted (the text a reader without an app sees)
 * @returns {string}
 */
export function resolveSkillText(text, available) {
  const names = available instanceof Set ? available : new Set(available || []);
  const source = String(text ?? '');
  let resolved = false;
  const result = source.replace(BLOCK_RE, (_, name, present, absent) => {
    resolved = true;
    return (names.has(name) ? present : (absent ?? '')).trim();
  });
  return resolved ? result.replace(/\n{3,}/g, '\n\n') : source;
}
