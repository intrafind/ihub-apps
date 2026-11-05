// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Runs one action of an installed integration for an admin, without a model
 * (#2974, 04-architecture §2 `tester/ActionTester.js`).
 *
 * The call goes through the installation's protocol adapter exactly as a
 * chat's would (`integrationTools.runIntegrationTool`), so the adapter's own
 * rules hold: the SSRF guard, the SSL whitelist and the proxy of `safeFetch`
 * and `httpFetch`, response caps, the credential store. It does not go
 * through `runTool` or the approval seam: a test is an explicit admin action.
 * In exchange, the server itself refuses every action that is not a trusted
 * read unless the request says `confirm: true` ({@link ActionTestError}
 * `CONFIRMATION_REQUIRED`); the UI's checkbox is not the gate.
 *
 * The result shows what an admin needs to judge the action and nothing
 * secret: the call (action, arguments) and every HTTP request it sent
 * (`utils/outboundRecorder.js`), with credential headers, secret keys and
 * every secret the run resolved redacted (`utils/secretRedaction.js`); the raw
 * response, redacted and capped; and the Answer Sources the result produces
 * (`services/sources`).
 *
 * @module services/integrations/tester/ActionTester
 */
import credentialService from '../../CredentialService.js';
import logger from '../../../utils/logger.js';
import { recordOutbound } from '../../../utils/outboundRecorder.js';
import {
  REDACTED,
  redactBody,
  redactDeep,
  redactHeaders,
  redactUrl,
  scrubSecrets,
  secretValuesOf
} from '../../../utils/secretRedaction.js';
import { extractToolSources } from '../../sources/index.js';
import { runToolCallScope } from '../../sources/toolCallScope.js';
import { resolveToolApproval } from '../../../utils/toolApproval.js';
import { getProtocolAdapter } from '../protocols/index.js';
import {
  findAction,
  testConnectionsOf,
  testNeedsConfirmation,
  toolDefinitionOf
} from '../actionDetail.js';
import { recordActionEvent } from '../actionUsage.js';
import { INTEGRATION_AUTH_REQUIRED } from '../auth/integrationAuthRequired.js';
import { ServiceError } from '../../../utils/ServiceError.js';

const COMPONENT = 'ActionTester';

/** Largest argument object a test accepts (JSON characters). */
export const MAX_TEST_ARGS_CHARS = 64 * 1024;
/** Most characters of the raw response the result shows. */
export const MAX_RESPONSE_CHARS = 100_000;
/** Time a test may take when the installation sets none. */
export const DEFAULT_TEST_TIMEOUT_MS = 60_000;
/** Shortest and longest time a test may take, whatever the configuration says. */
export const MIN_TEST_TIMEOUT_MS = 1_000;
export const MAX_TEST_TIMEOUT_MS = 120_000;

/**
 * The time a test may take: the first integer of `candidates` (the action's
 * `timeoutMs`, then the installation's), clamped to
 * [{@link MIN_TEST_TIMEOUT_MS}, {@link MAX_TEST_TIMEOUT_MS}];
 * {@link DEFAULT_TEST_TIMEOUT_MS} when none is set. The schemas bound both
 * values already; the clamp keeps the timer bounded for any definition that
 * reaches the tester.
 *
 * @param {...unknown} candidates
 * @returns {number}
 */
export function testTimeoutMs(...candidates) {
  for (const value of candidates) {
    if (!Number.isInteger(value) || value <= 0) continue;
    if (value < MIN_TEST_TIMEOUT_MS) return MIN_TEST_TIMEOUT_MS;
    if (value > MAX_TEST_TIMEOUT_MS) return MAX_TEST_TIMEOUT_MS;
    return value;
  }
  return DEFAULT_TEST_TIMEOUT_MS;
}

/** A refusal with an HTTP status and a code the route answers with. */
export class ActionTestError extends ServiceError {
  /**
   * @param {string} message
   * @param {string} code - A code of `shared/apiErrors.js`
   * @param {number} status
   * @param {Object} [details]
   */
  constructor(message, code, status, details = undefined) {
    super(code, message, { status, details });
    this.name = 'ActionTestError';
  }
}

/**
 * JSON-schema type of a value, as the schema would name it. Only called for
 * a value that is set: `argumentProblems` skips null and undefined.
 */
function jsonTypeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/**
 * Check test arguments against the action's top-level schema: an object,
 * bounded, the required properties present, the declared types matched.
 * Deeper validation is the adapter's (it validates as for a model's call).
 *
 * @param {unknown} args
 * @param {Object} schema - the action's parameter schema
 * @returns {string[]} problems; empty when the arguments are acceptable
 */
export function argumentProblems(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return ['args must be an object'];
  }
  let size = 0;
  try {
    size = JSON.stringify(args).length;
  } catch {
    return ['args must be JSON'];
  }
  if (size > MAX_TEST_ARGS_CHARS) return [`args must be at most ${MAX_TEST_ARGS_CHARS} characters`];
  const problems = [];
  const properties =
    schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  for (const name of Array.isArray(schema?.required) ? schema.required : []) {
    if (args[name] === undefined || args[name] === null || args[name] === '') {
      problems.push(`${name} is required`);
    }
  }
  for (const [name, value] of Object.entries(args)) {
    const declared = properties[name]?.type;
    if (!declared || value === undefined || value === null) continue;
    const types = Array.isArray(declared) ? declared : [declared];
    const actual = jsonTypeOf(value);
    const ok = types.some(type => type === actual || (type === 'number' && actual === 'integer'));
    if (!ok) problems.push(`${name} must be ${types.join(' or ')}`);
  }
  return problems;
}

/**
 * The secret values of the installation's credential profile (every string
 * field but the descriptive ones), to scrub them from what is shown.
 * @param {Object} instance
 * @returns {string[]}
 */
function credentialSecretsOf(instance) {
  const ref = instance?.auth?.credentialRef;
  if (!ref) return [];
  let profile = null;
  try {
    profile = credentialService.tryResolve(ref);
  } catch {
    profile = null;
  }
  if (!profile || typeof profile !== 'object') return [];
  const descriptive = new Set(['type', 'id', 'name', 'label', 'description', 'username', 'user']);
  return Object.entries(profile)
    .filter(([key, value]) => !descriptive.has(key) && typeof value === 'string' && value)
    .map(([, value]) => value);
}

/** A result as display text: JSON for objects, the string itself otherwise; capped. */
function responseText(value) {
  if (value === undefined) return { text: null, truncated: false };
  let text;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (text.length > MAX_RESPONSE_CHARS) {
    return { text: text.slice(0, MAX_RESPONSE_CHARS), truncated: true };
  }
  return { text, truncated: false };
}

/** Run a promise with a deadline; the controller is aborted when it passes. */
async function withDeadline(run, timeoutMs, controller) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new ActionTestError(`The action did not answer within ${timeoutMs} ms`, 'TIMEOUT', 504)
      );
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Test one action.
 *
 * @param {Object} params
 * @param {Object} params.resolved - `installedIntegrationService.resolve()` result
 * @param {string} params.actionName
 * @param {Object} params.args - the arguments the admin entered
 * @param {string} [params.connection] - `me` or `shared` (see `testConnectionsOf`)
 * @param {boolean} [params.confirm] - the admin confirmed a non-read test
 * @param {Object} params.user - the acting admin
 * @param {string} [params.language='en']
 * @param {Object} [params.platform] - platform config (for the side-effect resolution)
 * @returns {Promise<Object>} the test result (see the module docs); a failed
 *   call is a result with `status: 'error'`, not a throw
 * @throws {ActionTestError} when the test is refused before anything runs
 */
export async function testAction({
  resolved,
  actionName,
  args = {},
  connection,
  confirm = false,
  user,
  language = 'en',
  platform = {}
}) {
  if (!resolved?.definition) {
    throw new ActionTestError(
      'The definition of this installation is not loaded',
      'DEFINITION_MISSING',
      422
    );
  }
  if (resolved.incompatible || resolved.blocked) {
    throw new ActionTestError(
      resolved.incompatible
        ? `The definition cannot run on this server: ${resolved.statusReason || 'incompatible'}`
        : `The installation cannot run until its migration state is resolved (${resolved.migration?.status || 'migration'})`,
      'NOT_RUNNABLE',
      409
    );
  }
  const found = await findAction(resolved, actionName, language);
  if (!found) throw new ActionTestError(`No action ${actionName}`, 'ACTION_NOT_FOUND', 404);
  const { action, fingerprint } = found;
  if (action.error || action.requirementsMet === false) {
    throw new ActionTestError(
      `The action cannot run: ${action.error || 'its installation settings do not offer it'}`,
      'ACTION_UNAVAILABLE',
      409
    );
  }

  const connections = testConnectionsOf(resolved.instance);
  const chosen = connection || connections[0].id;
  if (!connections.some(option => option.id === chosen)) {
    throw new ActionTestError(
      `This installation cannot run as "${chosen}"; it offers: ${connections.map(c => c.id).join(', ')}`,
      'INVALID_CONNECTION',
      400
    );
  }

  const toolDef = toolDefinitionOf(resolved, action, fingerprint);
  const policy = resolveToolApproval(toolDef, null, platform, { installation: resolved.instance });
  if (testNeedsConfirmation(policy) && confirm !== true) {
    throw new ActionTestError(
      `This action is not a read (${policy.sideEffect}, from ${policy.sideEffectSource}): confirm the test to run it`,
      'CONFIRMATION_REQUIRED',
      409,
      { sideEffect: policy.sideEffect, sideEffectSource: policy.sideEffectSource }
    );
  }

  const problems = argumentProblems(args, action.parameters);
  if (problems.length) {
    throw new ActionTestError(
      `Invalid arguments: ${problems.join('; ')}`,
      'INVALID_ARGUMENTS',
      400,
      {
        problems
      }
    );
  }

  // Every secret the run touches, to scrub it from whatever is shown.
  const secrets = new Set([...credentialSecretsOf(resolved.instance), ...secretValuesOf(args)]);
  const resolveSecret = ref => {
    const value = credentialService.resolveSecret(ref);
    if (typeof value === 'string' && value) secrets.add(value);
    return value;
  };

  const adapter = getProtocolAdapter(resolved.definition.protocol.type);
  const definitionAction = resolved.definition.actions.find(a => a.name === actionName) || {
    name: actionName,
    sideEffect: 'unknown'
  };
  const controller = new AbortController();
  const params = { ...args, user, language };
  const reported = [];
  const timeoutMs = testTimeoutMs(definitionAction.timeoutMs, resolved.instance.timeoutMs);
  const started = Date.now();

  const outcome = await recordOutbound(() =>
    withDeadline(
      () =>
        runToolCallScope(reported, () =>
          adapter.run({
            definition: resolved.definition,
            instance: resolved.instance,
            document: resolved.document,
            security: resolved.security,
            action: definitionAction,
            args: { ...args },
            resolveSecret,
            context: {
              scope: null,
              user,
              chatId: null,
              params,
              tool: toolDef,
              options: { signal: controller.signal }
            }
          })
        ),
      timeoutMs,
      controller
    )
  );
  const durationMs = Date.now() - started;
  recordActionEvent(resolved.instance.id, actionName, 'test');

  // Headers first: their credential values are secrets for everything else.
  const requestHeaders = outcome.requests.map(request => {
    const { headers, found: headerSecrets } = redactHeaders(request.headers, secrets);
    for (const value of headerSecrets) secrets.add(value);
    return headers;
  });
  const http = outcome.requests.map((request, index) => ({
    /** Its position, 1-based (a stable key for the list). */
    seq: index + 1,
    method: request.method,
    url: redactUrl(request.url, secrets),
    headers: Object.fromEntries(
      Object.entries(requestHeaders[index]).map(([key, value]) => [
        key,
        value === REDACTED ? value : scrubSecrets(value, secrets)
      ])
    ),
    body: redactBody(request.body, secrets).text,
    status: request.status,
    durationMs: request.durationMs,
    error: request.error ? scrubSecrets(request.error, secrets) : null
  }));

  const failed = Boolean(outcome.error) || resultReportsFailure(outcome.result);
  const timedOut = outcome.error instanceof ActionTestError && outcome.error.code === 'TIMEOUT';
  let sources = null;
  if (!outcome.error) {
    sources = extractToolSources({
      toolId: toolDef.id,
      toolDef,
      args,
      result: outcome.result,
      reported,
      failed
    });
  }
  const response = outcome.error
    ? { text: null, truncated: false }
    : responseText(redactDeep(outcome.result, secrets));
  const errorMessage = outcome.error
    ? scrubSecrets(String(outcome.error?.message || outcome.error), secrets)
    : failed
      ? scrubSecrets(String(outcome.result?.message || failureFallback(outcome.result)), secrets)
      : null;
  const lastStatus = [...http].reverse().find(r => Number.isInteger(r.status))?.status ?? null;

  if (outcome.error && !timedOut) {
    logger.info('Integration action test failed', {
      component: COMPONENT,
      instanceId: resolved.instance.id,
      action: actionName,
      error: errorMessage
    });
  }

  return {
    status: timedOut ? 'timeout' : failed ? 'error' : 'ok',
    httpStatus:
      lastStatus ?? (Number.isInteger(outcome.result?.status) ? outcome.result.status : null),
    durationMs,
    error: errorMessage,
    connection: chosen,
    sideEffect: policy.sideEffect,
    confirmed: confirm === true,
    request: {
      action: actionName,
      toolId: toolDef.id,
      args: redactDeep(args, secrets),
      http,
      httpTruncated: outcome.requests.length >= 20
    },
    response: { text: response.text, truncated: response.truncated },
    sources
  };
}

/**
 * Whether an action's result reports a failure: `error: true`, or the
 * structured "connect first" result (`error: 'INTEGRATION_AUTH_REQUIRED'`) an
 * integration returns, without calling the vendor, when the connection the
 * test runs with is missing or expired. That one is no success: nothing ran.
 *
 * @param {*} result
 * @returns {boolean}
 */
export function resultReportsFailure(result) {
  if (!result || typeof result !== 'object') return false;
  return result.error === true || result.error === INTEGRATION_AUTH_REQUIRED;
}

/** The message of a failed result that carries none of its own. */
function failureFallback(result) {
  return result?.error === INTEGRATION_AUTH_REQUIRED
    ? 'The connection this test runs with is missing or expired. Connect it, then run the test again.'
    : 'The action reported an error';
}

/**
 * The arguments of a test as the audit entry records them: secret keys and
 * known secrets redacted, at most 500 characters.
 * @param {Object} args
 * @returns {string}
 */
export function auditArgs(args) {
  let text;
  try {
    text = JSON.stringify(redactDeep(args || {}, secretValuesOf(args || {})));
  } catch {
    text = '{}';
  }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
