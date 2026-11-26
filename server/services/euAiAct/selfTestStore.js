// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The last watermark self-test per model (#3329), kept so the status page can say
 * "passed", "failed" or "outdated since the key changed" without running the
 * test (which costs tokens) again. One small file, written under the config
 * store's cluster-safe update; holds no key and no generated text.
 *
 * @module services/euAiAct/selfTestStore
 */
import configStore from '../config/ConfigStore.js';
import { getActiveKeyId } from '../provenance/watermark/activeKeySnapshot.js';
import logger from '../../utils/logger.js';

export const SELF_TESTS_FILE = 'config/eu-ai-act-self-tests.json';

/** Self-test states the status reports (the diagnosis of step 4 mapped onto them). */
export const SELF_TEST_STATE = Object.freeze({
  NEVER: 'never',
  PASSED: 'passed',
  FAILED: 'failed',
  INCONCLUSIVE: 'inconclusive',
  STALE: 'stale'
});

/**
 * Map the diagnosis of `runSelfTest` to a state. `too_short` is inconclusive
 * (temperature-1 text may stop early); everything else that is not a match is a
 * failure of the chain.
 *
 * @param {string} diagnosis
 * @returns {'passed'|'failed'|'inconclusive'}
 */
export function stateOfDiagnosis(diagnosis) {
  // `watermark_found`: a model whose image holds the key (no iHub key to compare).
  if (diagnosis === 'keys_match' || diagnosis === 'watermark_found') return SELF_TEST_STATE.PASSED;
  if (diagnosis === 'too_short') return SELF_TEST_STATE.INCONCLUSIVE;
  return SELF_TEST_STATE.FAILED;
}

/**
 * Remember a self-test result. Never throws: a failed write must not fail the
 * test the admin just ran.
 *
 * @param {string} modelId
 * @param {{diagnosis: string, matchedKeyId?: string}} result
 * @param {{now?: Date, activeKeyId?: string|null, keyHolder?: 'ihub'|'model',
 *   detector?: {api: string, url: string|null}|null}} [options] - `activeKeyId` and
 *   `detector` as they were when the test started
 */
export async function recordSelfTest(
  modelId,
  result,
  { now = new Date(), activeKeyId, keyHolder = 'ihub', detector = null } = {}
) {
  const entry = {
    at: now.toISOString(),
    diagnosis: result.diagnosis,
    state: stateOfDiagnosis(result.diagnosis),
    // The key that was active when the test ran: a later key change makes it stale.
    keyId: activeKeyId === undefined ? getActiveKeyId() : activeKeyId,
    // Who held the key: a test of the image's key says nothing about iHub's, and back.
    keyHolder,
    // Where the text was detected (image, gateway, iHub's detector): a test of one
    // route says nothing about another one.
    ...(detector ? { detector: { api: detector.api, url: detector.url ?? null } } : {})
  };
  try {
    await configStore.updateJson(SELF_TESTS_FILE, current => ({
      ...(current && typeof current === 'object' ? current : {}),
      [modelId]: entry
    }));
  } catch (error) {
    logger.warn('Could not store the self-test result', {
      component: 'EuAiActSelfTest',
      error: error.message
    });
  }
}

/** @returns {Promise<Object<string, {at: string, diagnosis: string, state: string, keyId: string|null, keyHolder?: string}>>} */
export async function readSelfTests() {
  try {
    const data = await configStore.readJson(SELF_TESTS_FILE);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/**
 * The state of a model's last test against the key that is active now. A passed
 * test is stale after a key change, after the key holder changed (an entry
 * without `keyHolder` predates the image-held keys and tested iHub's key), and
 * after the detection route or its address changed (an entry without `detector`
 * cannot tell and is not aged by it).
 *
 * @param {Object|undefined} entry
 * @param {string|null} activeKeyId
 * @param {'ihub'|'model'} [keyHolder]
 * @param {{api: string, url: string|null}|null} [detector] - The current route
 */
export function selfTestSummary(entry, activeKeyId, keyHolder = 'ihub', detector = null) {
  if (!entry) return { state: SELF_TEST_STATE.NEVER, at: null, keyId: null, diagnosis: null };
  const holderChanged = (entry.keyHolder ?? 'ihub') !== keyHolder;
  const keyChanged = Boolean(entry.keyId) && entry.keyId !== activeKeyId;
  const routeChanged =
    Boolean(entry.detector && detector) &&
    (entry.detector.api !== detector.api ||
      (entry.detector.url ?? null) !== (detector.url ?? null));
  const stale =
    entry.state !== SELF_TEST_STATE.FAILED && (holderChanged || keyChanged || routeChanged);
  return {
    state: stale ? SELF_TEST_STATE.STALE : entry.state,
    at: entry.at,
    keyId: entry.keyId ?? null,
    diagnosis: entry.diagnosis ?? null
  };
}
