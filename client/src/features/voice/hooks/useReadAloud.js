import { useEffect, useState } from 'react';
import { fetchTtsModels } from '../../../api/endpoints/models';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';

// One request for the permitted TTS models per page, however many messages
// ask. Keyed by the default model id so a change in Admin → Voice Input is
// picked up without a reload.
let ttsModelsRequest = null;
let ttsModelsRequestKey = null;

function loadTtsModels(key) {
  if (!ttsModelsRequest || ttsModelsRequestKey !== key) {
    ttsModelsRequestKey = key;
    ttsModelsRequest = fetchTtsModels()
      .then(models => (Array.isArray(models) ? models : []))
      .catch(() => {
        // A failed lookup must not stick for the rest of the session.
        ttsModelsRequest = null;
        return [];
      });
  }
  return ttsModelsRequest;
}

/**
 * Whether this chat offers read aloud: switched on in Admin → Voice Input with
 * a default model, not opted out by the app (`features.textToSpeech: false`),
 * and the default model is one this user's groups may use.
 *
 * @param {Object|null} app
 * @returns {{ available: boolean, modelId: string|null }}
 */
export function useReadAloudAvailability(app) {
  const { platformConfig } = usePlatformConfig();
  const featureFlags = useFeatureFlags();
  const tts = platformConfig?.speech?.tts;
  const defaultModelId = tts?.enabled ? tts.defaultModelId || '' : '';
  const appAllows = featureFlags.isAppFeatureEnabled(app, 'textToSpeech', true);
  const wanted = Boolean(defaultModelId) && appAllows;
  const [permitted, setPermitted] = useState(null);

  useEffect(() => {
    if (!wanted) return undefined;
    let active = true;
    loadTtsModels(defaultModelId).then(models => {
      if (active) setPermitted(models.some(model => model.id === defaultModelId));
    });
    return () => {
      active = false;
    };
  }, [wanted, defaultModelId]);

  return {
    available: wanted && permitted === true,
    modelId: wanted ? defaultModelId : null
  };
}

export default useReadAloudAvailability;
