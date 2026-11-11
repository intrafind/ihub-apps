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
  if (diagnosis === 'keys_match') return SELF_TEST_STATE.PASSED;
  if (diagnosis === 'too_short') return SELF_TEST_STATE.INCONCLUSIVE;
  return SELF_TEST_STATE.FAILED;
}

/**
 * Remember a self-test result. Never throws: a failed write must not fail the
 * test the admin just ran.
 *
 * @param {string} modelId
 * @param {{diagnosis: string, matchedKeyId?: string}} result
 * @param {{now?: Date, activeKeyId?: string|null}} [options]
 */
export async function recordSelfTest(modelId, result, { now = new Date(), activeKeyId } = {}) {
  const entry = {
    at: now.toISOString(),
    diagnosis: result.diagnosis,
    state: stateOfDiagnosis(result.diagnosis),
    // The key that was active when the test ran: a later key change makes it stale.
    keyId: activeKeyId === undefined ? getActiveKeyId() : activeKeyId
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

/** @returns {Promise<Object<string, {at: string, diagnosis: string, state: string, keyId: string|null}>>} */
export async function readSelfTests() {
  try {
    const data = await configStore.readJson(SELF_TESTS_FILE);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/**
 * The state of a model's last test against the key that is active now.
 *
 * @param {Object|undefined} entry
 * @param {string|null} activeKeyId
 */
export function selfTestSummary(entry, activeKeyId) {
  if (!entry) return { state: SELF_TEST_STATE.NEVER, at: null, keyId: null, diagnosis: null };
  const stale =
    entry.state !== SELF_TEST_STATE.FAILED && entry.keyId && entry.keyId !== activeKeyId;
  return {
    state: stale ? SELF_TEST_STATE.STALE : entry.state,
    at: entry.at,
    keyId: entry.keyId ?? null,
    diagnosis: entry.diagnosis ?? null
  };
}
