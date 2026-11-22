// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The context of a run: who it acts as, where it came from, what it may use.
 *
 * Built once per run by {@link createRunContext} and frozen, all the way down:
 * a seam, a host or a tool that tries to change the principal, its groups or
 * permissions, or the grant of a run throws instead. A change is a new context
 * ({@link withToolGrant}, {@link childRunContext}), never an edit.
 *
 * | Field | Meaning |
 * | --- | --- |
 * | `principal` | the identity the run acts as, resolved with its permissions (`principalResolver.js`) |
 * | `principalType` | `user` (a person's account), `client` (an OAuth client or a personal API key acting for its owner), `service` (a service account an admin chose) |
 * | `actor` | who acted: `{ kind, id }` |
 * | `agentId`, `agentVersion` | the agent the run belongs to; `null` until agents exist |
 * | `origin` | what started the run: `person` (a request of a person or of a program acting for one, inbound `/v1`, MCP and A2A included) or `schedule` |
 * | `unattended` | no person can answer: every origin other than `person`, and every principal other than `user` |
 * | `runId` | the run's own id, set by the run service when it starts the run (`withToolGrant`); `null` before |
 * | `parentRunId`, `depth` | the run that started this one (an app called as a tool) and how deep it is nested; 0 for a top-level run |
 * | `toolGrant` | the tool ids the run may call; the tool runner refuses any other (`null`: none) |
 * | `integrationGrant` | the installation ids the run may reach, or `null` for what the principal's groups grant |
 * | `approvalRoute` | who answers an approval: `person`, or `deny` where nobody can |
 * | `budget` | limits of the run (`maxToolRounds`, `maxWallClockMs`, `timeoutMs`) |
 * | `taint` | whether untrusted content woke the run; always `false` until the trust rules land |
 *
 * @module services/run/RunContext
 */

import { PRINCIPAL_TYPES, principalTypeOf } from './principalTypes.js';

/** What can start a run. Later origins (a follow-up, a wake, a trigger) come with their features. */
export const RUN_ORIGINS = Object.freeze(['person', 'schedule']);

/** Who answers an approval of the run. */
export const APPROVAL_ROUTES = Object.freeze(['person', 'deny']);

/** How deep a run may be nested: an app called as a tool calls no further app. */
export const MAX_RUN_DEPTH = 1;

/** Codes of a context that could not be built. */
export const RUN_CONTEXT_ERROR_CODES = Object.freeze({
  /** The principal carries no resolved permissions. */
  PRINCIPAL_UNRESOLVED: 'PRINCIPAL_UNRESOLVED',
  /** A field has a value the context does not know. */
  INVALID: 'RUN_CONTEXT_INVALID'
});

/** A context that could not be built. */
export class RunContextError extends Error {
  /**
   * @param {string} code - one of {@link RUN_CONTEXT_ERROR_CODES}
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'RunContextError';
    this.code = code;
  }
}

/** The contexts this module built: only these pass {@link isRunContext}. */
const built = new WeakSet();

/** Sets that are sealed: their `add`, `delete` and `clear` throw. */
const sealedSets = new WeakSet();

/**
 * A `Set` that cannot change once built. It still is a `Set`
 * (`instanceof Set`, `has`, iteration), so the permission checks that read a
 * principal's sets read it unchanged.
 */
class ReadonlySet extends Set {
  constructor(values) {
    super(values);
    sealedSets.add(this);
  }

  add(value) {
    if (sealedSets.has(this)) throw new TypeError('A set of a run context cannot change');
    return super.add(value);
  }

  delete(value) {
    if (sealedSets.has(this)) throw new TypeError('A set of a run context cannot change');
    return super.delete(value);
  }

  clear() {
    if (sealedSets.has(this)) throw new TypeError('A set of a run context cannot change');
    super.clear();
  }
}

const isPlainObject = value => {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * A frozen copy: plain objects and arrays are copied and frozen, sets become
 * read-only sets. Anything else (a function, an instance of a class) is kept
 * as it is: a context holds data, and the principal of a request is data.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (value instanceof Set) return new ReadonlySet([...value].map(frozenCopy));
  if (isPlainObject(value)) {
    const copy = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = frozenCopy(entry);
    return Object.freeze(copy);
  }
  return value;
}

const idList = (value, field) => {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) && !(value instanceof Set)) {
    throw new RunContextError(RUN_CONTEXT_ERROR_CODES.INVALID, `${field} must be a list of ids`);
  }
  return [...new Set([...value].map(String))];
};

/**
 * Build the frozen context of a run.
 *
 * @param {Object} params
 * @param {Object} params.principal - the resolved principal (`principalResolver.resolvePrincipal`)
 * @param {'user'|'client'|'service'} [params.principalType] - derived from the principal when left out
 * @param {'person'|'schedule'} [params.origin='person']
 * @param {{kind: string, id: string}} [params.actor]
 * @param {string|null} [params.agentId]
 * @param {string|number|null} [params.agentVersion]
 * @param {string|null} [params.runId] - the run's own id; the run service sets it
 * @param {string|null} [params.parentRunId]
 * @param {number} [params.depth=0]
 * @param {Iterable<string>|null} [params.toolGrant]
 * @param {Iterable<string>|null} [params.integrationGrant]
 * @param {'person'|'deny'} [params.approvalRoute] - `deny` for an unattended run when left out
 * @param {Object} [params.budget]
 * @param {boolean} [params.taint=false]
 * @returns {Readonly<Object>} the context
 * @throws {RunContextError} a principal without resolved permissions, or an unknown value
 */
export function createRunContext({
  principal,
  principalType,
  origin = 'person',
  actor,
  agentId = null,
  agentVersion = null,
  runId = null,
  parentRunId = null,
  depth = 0,
  toolGrant = null,
  integrationGrant = null,
  approvalRoute,
  budget = {},
  taint = false
} = {}) {
  if (!principal?.permissions || typeof principal.permissions !== 'object') {
    throw new RunContextError(
      RUN_CONTEXT_ERROR_CODES.PRINCIPAL_UNRESOLVED,
      'A run needs a principal with resolved permissions'
    );
  }
  const type = principalType ?? principalTypeOf(principal);
  if (!PRINCIPAL_TYPES.includes(type)) {
    throw new RunContextError(RUN_CONTEXT_ERROR_CODES.INVALID, `Unknown principal type: ${type}`);
  }
  if (!RUN_ORIGINS.includes(origin)) {
    throw new RunContextError(RUN_CONTEXT_ERROR_CODES.INVALID, `Unknown run origin: ${origin}`);
  }
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_RUN_DEPTH) {
    throw new RunContextError(
      RUN_CONTEXT_ERROR_CODES.INVALID,
      `A run is nested at most ${MAX_RUN_DEPTH} deep`
    );
  }
  const unattended = origin !== 'person' || type !== 'user';
  const route = approvalRoute ?? (unattended ? 'deny' : 'person');
  if (!APPROVAL_ROUTES.includes(route)) {
    throw new RunContextError(RUN_CONTEXT_ERROR_CODES.INVALID, `Unknown approval route: ${route}`);
  }
  const context = frozenCopy({
    principal,
    principalType: type,
    actor: actor ?? { kind: origin === 'person' ? type : origin, id: String(principal.id ?? '') },
    agentId,
    agentVersion,
    origin,
    unattended,
    runId: runId ? String(runId) : null,
    parentRunId: parentRunId ? String(parentRunId) : null,
    depth,
    toolGrant: idList(toolGrant, 'toolGrant'),
    integrationGrant: idList(integrationGrant, 'integrationGrant'),
    approvalRoute: route,
    budget: budget && typeof budget === 'object' ? budget : {},
    taint: taint === true
  });
  built.add(context);
  return context;
}

/**
 * Whether a value is a context {@link createRunContext} built. A copy, or an
 * object of the same shape made elsewhere, is not one.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRunContext(value) {
  return Boolean(value && typeof value === 'object' && built.has(value));
}

/** The fields {@link createRunContext} takes, read from a context. */
function fieldsOf(context) {
  const { unattended: _unattended, ...fields } = context;
  return fields;
}

/**
 * The same context with another tool grant and, when given, the run's own id.
 *
 * @param {Object} context - a run context
 * @param {Iterable<string>} toolIds
 * @param {Object} [options]
 * @param {string} [options.runId] - the id of the run the context belongs to
 * @returns {Readonly<Object>}
 */
export function withToolGrant(context, toolIds, { runId } = {}) {
  if (!isRunContext(context)) {
    throw new RunContextError(RUN_CONTEXT_ERROR_CODES.INVALID, 'Not a run context');
  }
  return createRunContext({
    ...fieldsOf(context),
    toolGrant: toolIds,
    runId: runId ?? context.runId
  });
}

/**
 * The context of a run that another run starts (an app called as a tool): the
 * same origin and attendance, one level deeper, under the parent's id, with
 * the principal the child acts as and no tools until the child's are known.
 *
 * Without a parent context (a chat turn, which does not run on the run service
 * yet) the parent is a top-level run of a person with this principal.
 *
 * @param {Object|null} parent - the parent's run context, or null
 * @param {Object} params
 * @param {Object} params.principal - the principal the child acts as
 * @param {string|null} [params.parentRunId]
 * @returns {Readonly<Object>}
 * @throws {RunContextError} past {@link MAX_RUN_DEPTH}, or a principal without permissions
 */
export function childRunContext(parent, { principal, parentRunId = null }) {
  if (parent && !isRunContext(parent)) {
    throw new RunContextError(RUN_CONTEXT_ERROR_CODES.INVALID, 'Not a run context');
  }
  return createRunContext({
    principal,
    principalType: parent?.principalType,
    origin: parent?.origin ?? 'person',
    approvalRoute: parent?.approvalRoute,
    agentId: parent?.agentId ?? null,
    agentVersion: parent?.agentVersion ?? null,
    parentRunId: parentRunId ?? parent?.parentRunId ?? null,
    depth: (parent?.depth ?? 0) + 1,
    integrationGrant: parent?.integrationGrant ?? null,
    budget: parent?.budget ?? {},
    taint: parent?.taint === true
  });
}

export default createRunContext;
