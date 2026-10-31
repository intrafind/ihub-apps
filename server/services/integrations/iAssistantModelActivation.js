// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configStore from '../config/ConfigStore.js';
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';

export const ASSISTANT_MODEL_ID = 'iassistant-conversation';

/**
 * Whether an iFinder connection (`getIFinderConfig()`, or the installation's
 * values with `enabled`) is a working setup: switched on and pointing at an
 * iFinder instance.
 *
 * @param {Object} [iFinder]
 * @returns {boolean}
 */
export function isIFinderConfigured(iFinder) {
  return (
    iFinder?.enabled === true && typeof iFinder.baseUrl === 'string' && !!iFinder.baseUrl.trim()
  );
}

/**
 * Enable the iAssistant conversation model when an admin has just finished
 * configuring the iFinder integration, so the iAssistant app works without a
 * second trip to Admin → Models.
 *
 * Acts on the transition only: a model an admin disabled later stays disabled
 * until the integration is switched off and configured again.
 *
 * @param {Object} [before] - the iFinder connection before the change
 * @param {Object} [after] - the iFinder connection after the change
 * @returns {Promise<boolean>} True when the model was enabled by this call
 */
export async function enableAssistantModelOnIFinderSetup(before, after) {
  if (isIFinderConfigured(before) || !isIFinderConfigured(after)) return false;

  const { data: models } = configCache.getModels(true);
  const model = models.find(m => m.id === ASSISTANT_MODEL_ID);
  if (!model || model.enabled !== false) return false;

  const path = await configStore.resolveIdToPath('models', ASSISTANT_MODEL_ID);
  await configStore.writeJson(path, { ...model, enabled: true });
  await configCache.refreshModelsCache();
  logger.info('Enabled the iAssistant conversation model after iFinder setup', {
    component: 'IFinderIntegration',
    modelId: ASSISTANT_MODEL_ID
  });
  return true;
}
