// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The skills the model loaded in one chat turn.
 *
 * A skill's instructions reach the model as the result of `activate_skill`.
 * They are a tool result: a later turn does not carry them (only the final
 * answer does), so a model that used a skill before often calls the skill's
 * tool straight away in the next turn, without the rules in front of it. A tool
 * whose skill carries rules the server cannot check by itself (the `dashboard`
 * skill: "numbers come from the data, never from you") asks this log whether
 * the skill was loaded in the turn it runs in, and refuses the call when it was
 * not (`services/documents/webArtifacts/dashboardTools.js`).
 *
 * The turn creates the log and hands it to every tool call as `turnSkills`
 * (a trusted context key, see `utils/toolCallContext.js`); `activate_skill`
 * writes to it, a tool reads it. A skill that is active in the chat is not part
 * of it: its instructions are in the system prompt of every turn, and
 * `appConfig._activeSkills` says so.
 *
 * @module services/chat/turnSkillLog
 */

/**
 * @returns {{note: (skillName: string) => void, has: (skillName: string) => boolean}}
 */
export function createTurnSkillLog() {
  const loaded = new Set();
  return {
    /** Record that `activate_skill` returned the skill's instructions. */
    note(skillName) {
      if (typeof skillName === 'string' && skillName) loaded.add(skillName);
    },
    /** Whether the skill's instructions were returned in this turn. */
    has(skillName) {
      return loaded.has(skillName);
    }
  };
}
