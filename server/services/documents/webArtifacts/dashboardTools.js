// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { activeSkillsOf } from '../../skillAccess.js';
import { toolFailure } from '../documentToolHelpers.js';
import { applyTextEdits, chatFileToEdit, textEditsOf } from '../editableSource.js';
import { GeneratedFileError } from '../generatedFiles.js';
import { dashboardSourceOf, dashboardWarnings, prepareDashboard } from './dashboardPreset.js';
import { packageWebArtifact } from './webArtifactTools.js';

/**
 * The tools the `dashboard` system skill brings (see
 * `server/systemSkills/dashboard`): `create_dashboard` lays out a page of
 * figures from a spec the model passes as data, `edit_dashboard` changes the
 * spec of one this chat made. The page is the fixed layout of the skill
 * (`dashboardPreset.js`); the file is handed to the chat as a web artifact
 * (`webArtifactTools.js` `packageWebArtifact`), so it shows in the Artifacts
 * panel, downloads and versions like one.
 *
 * What the skill says about the numbers ("Numbers come from the data, never
 * from you") is skill text, a tool result that does not reach the next turn.
 * The server therefore holds the rules itself: a call in a turn where the skill
 * was not loaded is refused ({@link requireDashboardRules}); the spec must name
 * the date of the data and its sources (`dashboardPreset.js`); a date far from
 * today comes back as a warning the model has to answer.
 *
 * @module services/documents/webArtifacts/dashboardTools
 */

/** The skill that brings the tools and the rules. */
export const DASHBOARD_SKILL = 'dashboard';

/**
 * Whether the rules of the `dashboard` skill are in front of the model in the
 * turn this call runs in: they are in its system prompt (the skill is active in
 * the chat), it loaded them with `activate_skill` in this turn, or the agent
 * run did. A call that comes with neither a chat turn nor an agent run (no
 * model chose it, so none could have loaded a skill) is let through.
 *
 * @param {Object} params - The call's trusted context (`appConfig`, `turnSkills`).
 * @returns {boolean}
 */
export function dashboardRulesLoaded(params) {
  const inPrompt = activeSkillsOf(params.appConfig).some(
    skill => skill.name === DASHBOARD_SKILL && skill.full
  );
  if (inPrompt || params.turnSkills?.has?.(DASHBOARD_SKILL)) return true;
  const workflow = params.appConfig?._workflowState;
  if (workflow?.data?._activatedSkills?.[DASHBOARD_SKILL]) return true;
  return !params.turnSkills && !workflow;
}

/**
 * Refuse `create_dashboard` when the skill's rules were not loaded in this
 * turn, and say what to do.
 *
 * @param {Object} params
 * @throws {GeneratedFileError} code `skill-required`
 */
function requireDashboardRules(params) {
  if (dashboardRulesLoaded(params)) return;
  throw new GeneratedFileError(
    `Not created: the "${DASHBOARD_SKILL}" skill was not loaded in this turn, and its rules decide what a dashboard may show. Call activate_skill with skill_name "${DASHBOARD_SKILL}" first (a skill used in an earlier turn is not loaded again), read it, then call create_dashboard again. In short: every figure is copied from a tool result or the user's data, never written from memory or from an earlier dashboard of another subject; "asOf" is the date of that data; "sources" says where each figure comes from. If the figures are not in this conversation, get them (a tool, a file) or ask the user.`,
    'skill-required'
  );
}

/**
 * The result words of a dashboard: what was made, what the model checks before
 * it answers. A warning is either a problem of the page or something the spec
 * says that looks wrong (a date far from today).
 *
 * @param {Object} options
 * @param {'Created'|'Updated'} options.verb
 * @param {string[]} [options.warnings] - Findings about the spec.
 * @returns {(held: {name: string, findings: Array<{text: string, blocking: boolean}>}) => Object}
 */
function dashboardReport({ verb, warnings: specWarnings = [] }) {
  return ({ name, findings }) => {
    const warnings = [...specWarnings, ...findings.filter(f => f.blocking).map(f => f.text)];
    const notes = findings.filter(f => !f.blocking).map(f => f.text);
    let message;
    if (warnings.length) {
      message = `${verb} the dashboard "${name}", but ${warnings.length} warning(s) in "warnings" need an answer, and the user already sees it. Do NOT answer yet: check each one and fix it with edit_dashboard (filename "${name}", "edits" that change only the field at fault) or, when it does not apply, say so in your answer. Then answer, without pasting the JSON or adding a link.`;
    } else {
      message = `${verb} the dashboard "${name}". The user sees it in the Artifacts panel (Preview | Code, a table view for every chart, "Sources and formulas" at the bottom) and gets a download card in the chat — do not paste the JSON or add a link.`;
    }
    if (notes.length) {
      message += ` "notes" lists ${notes.length} thing(s) that work but could be better; leave them.`;
    }
    return {
      message,
      ...(warnings.length ? { warnings } : {}),
      ...(notes.length ? { notes } : {})
    };
  };
}

/**
 * `create_dashboard`: check the spec, lay out the page and hold it for the
 * chat as an `.html` artifact.
 *
 * @param {Object} params - `filename`, `data`, brand parameters, plus trusted
 *   context (`user`, `chatId`, `appConfig`, `turnSkills`).
 * @returns {Promise<Object>}
 */
export async function runCreateDashboard(params) {
  try {
    requireDashboardRules(params);
    const { html, spec } = prepareDashboard(params.data);
    return await packageWebArtifact(params, {
      content: html,
      format: 'html',
      name: params.filename || params.name || spec.title,
      verb: 'Created',
      report: dashboardReport({ verb: 'Created', warnings: dashboardWarnings(spec) })
    });
  } catch (error) {
    return toolFailure(error, 'The dashboard could not be created.');
  }
}

/**
 * `edit_dashboard`: change the spec of a dashboard of this chat by exact text
 * replacements, lay the page out again and hold it under the same name as the
 * file's newest version (artifacts are written once; the earlier version
 * stays). The spec is read back out of the stored page, as indented JSON: the
 * text `chat_artifacts_read` shows, so an `oldText` copied from there matches.
 * The changed spec is checked like a new one, so `asOf` and `sources` stay
 * required; a date far from today is reported only when the edit changed it.
 *
 * @param {Object} params - `filename`, `edits`, plus trusted context.
 * @returns {Promise<Object>}
 */
export async function runEditDashboard(params) {
  try {
    const edits = textEditsOf(params.edits, {
      rewriteHint: 'create the dashboard again with create_dashboard'
    });
    const target = await chatFileToEdit(params);
    const source = /\.html?$/i.test(target.name)
      ? dashboardSourceOf(target.data.toString('utf8'))
      : null;
    if (!source) {
      throw new GeneratedFileError(
        `"${target.name}" is not a dashboard made by create_dashboard. edit_dashboard changes only those; change a web artifact with edit_web_artifact.`,
        'invalid'
      );
    }
    const updated = applyTextEdits(source.text, edits);
    if (updated === source.text) {
      throw new GeneratedFileError(
        'The edits change nothing: every newText equals its oldText.',
        'invalid'
      );
    }
    let changed;
    try {
      changed = JSON.parse(updated);
    } catch (error) {
      throw new GeneratedFileError(
        `The edits leave the dashboard's spec as invalid JSON (${error.message}). No edit was applied: keep the quotes, commas and brackets around the text you change.`,
        'invalid'
      );
    }
    const { html, spec } = prepareDashboard(changed);
    const warnings = spec.asOf === source.spec.asOf ? [] : dashboardWarnings(spec);
    const result = await packageWebArtifact(params, {
      content: html,
      format: 'html',
      name: target.name,
      verb: 'Updated',
      report: dashboardReport({ verb: 'Updated', warnings })
    });
    return { ...result, edited: edits.length };
  } catch (error) {
    return toolFailure(error, 'The dashboard could not be changed.');
  }
}
