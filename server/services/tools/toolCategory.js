// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What a tool is, resolved once: the row it makes in the chat (`kind`: a
 * `search`, a `fetch` of one page or document, or a plain `tool` call) and
 * where it looks (`origin`, the footer's vocabulary of answer-basis kinds).
 *
 * The category is a property of the tool, never read from its id. A tool
 * declares it in its definition, next to `sources`, for the whole tool or per
 * function (the function's declaration wins):
 *
 * ```json
 * "activity": { "kind": "search", "origin": "web" }
 * ```
 *
 * - `kind`: `search` | `fetch` | `tool`
 * - `origin`: one of {@link ACTIVITY_ORIGINS}; without it a connected system
 *   (an integration, MCP server or remote agent) is `integration`, any other
 *   tool has none
 * - `place`: free text naming what is searched ("directory"); reserved for
 *   the chat's wording, not sent anywhere yet
 *
 * The code that creates a tool definition (integration actions, the project
 * knowledge tools, the shipped tool files) sets the declaration for the families
 * it generates. A tool that declares nothing is a plain call: a mislabelled
 * tool reads as "1 tool call", never as "Searched the web". An admin corrects
 * an MCP or custom tool in its installation (`actions.overrides[<tool>].activity`)
 * or its tool file, without a code change.
 *
 * Every consumer reads this: the activity row, the answer's basis and badge,
 * the citation harvest, the web source producer, the wrap-up nudge.
 *
 * @module services/tools/toolCategory
 */

import { z } from 'zod';
import { ACTIVITY_KINDS, ACTIVITY_ORIGINS } from '../../../shared/runEvents.js';
import logger from '../../utils/logger.js';

export { ACTIVITY_KINDS };

/** iHub's own tools (scheduling, …) are not a connected system. */
export const IHUB_DEFINITION = 'com.intrafind/ihub';

export const activityDeclarationSchema = z
  .object({
    kind: z.enum(ACTIVITY_KINDS),
    origin: z.enum(ACTIVITY_ORIGINS).optional(),
    place: z.string().min(1).max(60).optional()
  })
  .strict();

/** Declarations already checked, so one object is validated (and, if invalid, reported) once. */
const checked = new WeakMap();

/**
 * The declaration that applies to a tool call, validated; null for none or an
 * invalid one (logged once).
 *
 * @param {Object|undefined} toolDef - the resolved tool (a function tool
 *   carries its parent's `functions` and its own `method`)
 * @returns {{kind: string, origin?: string, place?: string}|null}
 */
export function declaredActivityOf(toolDef) {
  if (!toolDef || typeof toolDef !== 'object') return null;
  const own = toolDef.method ? toolDef.functions?.[toolDef.method]?.activity : undefined;
  const declaration = own ?? toolDef.activity;
  if (declaration === undefined || declaration === null) return null;
  if (typeof declaration !== 'object') {
    logger.warn('Ignoring invalid activity declaration', {
      component: 'toolCategory',
      toolId: toolDef.id
    });
    return null;
  }
  if (checked.has(declaration)) return checked.get(declaration);
  const parsed = activityDeclarationSchema.safeParse(declaration);
  if (!parsed.success) {
    logger.warn('Ignoring invalid activity declaration', {
      component: 'toolCategory',
      toolId: toolDef.id,
      issues: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
    });
  }
  const valid = parsed.success ? parsed.data : null;
  checked.set(declaration, valid);
  return valid;
}

/** Whether the tool belongs to a connected system rather than to iHub itself. */
function isConnectedSystem(toolDef) {
  if (toolDef._mcp || toolDef._a2a) return true;
  return Boolean(toolDef._integration) && toolDef._integration.definition !== IHUB_DEFINITION;
}

/**
 * The category of a tool: what call it is and where it looks.
 *
 * @param {Object|null|undefined} toolDef - the resolved tool definition
 * @returns {{kind: 'search'|'fetch'|'tool', origin?: 'project'|'web'|'ifinder'|'iassistant'|'documents'|'integration'}}
 */
export function categoryOf(toolDef) {
  // The loop's own tools (skills, tool search) are plain calls that inform nobody.
  if (!toolDef || typeof toolDef !== 'object' || toolDef.isInternalTool) return { kind: 'tool' };
  const declared = declaredActivityOf(toolDef);
  const origin = declared?.origin ?? (isConnectedSystem(toolDef) ? 'integration' : undefined);
  return { kind: declared?.kind ?? 'tool', ...(origin ? { origin } : {}) };
}

/**
 * Whether a tool's result carries citable pages or documents: a search or a
 * fetch. Decides the wrap-up nudge and the workflow citation harvest.
 *
 * @param {Object|null|undefined} toolDef
 * @returns {boolean}
 */
export function isCitationProducing(toolDef) {
  const { kind } = categoryOf(toolDef);
  return kind === 'search' || kind === 'fetch';
}
