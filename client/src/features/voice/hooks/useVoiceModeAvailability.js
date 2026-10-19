// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';
import { resolveVoiceModeSettings } from '../../../../../shared/voiceMode.js';
import { isBrowserSpeechSupported, resolveSpeechService } from '../utils/speechService';
import { loadTtsModels } from './useReadAloud';

/**
 * Whether this browser can run a voice conversation at all: a microphone
 * (`getUserMedia`) and an audio graph with worklets (`AudioWorklet`) for
 * capture, voice activity detection and gap-free playback.
 */
export function isVoiceModeBrowserSupported() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const hasMicrophone = typeof navigator.mediaDevices?.getUserMedia === 'function';
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const hasWorklet =
    typeof AudioContextClass === 'function' && 'audioWorklet' in AudioContextClass.prototype;
  return hasMicrophone && hasWorklet;
}

/**
 * Whether the speech service the app's voice input resolves to can run here.
 * `model` needs a transcription model (the server checks that this user may use
 * it and ends the session with an error otherwise), `azure` needs Azure Speech
 * switched on, `browser` needs the Web Speech API (Firefox has none).
 *
 * @param {{ service: string, modelId: string }} choice - from `resolveSpeechService`
 * @param {object} [speech] - `platformConfig.speech`
 */
export function isSpeechChoiceUsable(choice, speech) {
  if (choice?.service === 'model') return Boolean(choice.modelId);
  if (choice?.service === 'azure') return Boolean(speech?.azure?.enabled);
  return isBrowserSpeechSupported();
}

/**
 * Whether this chat offers voice mode, and with what settings.
 *
 * Available when all of these hold: the `voiceMode` feature flag is on and
 * `speech.voiceMode.enabled` is true; the app allows voice input and voice mode
 * is on for it (`inputMode.voiceMode.enabled`, else `appDefault`); a
 * text-to-speech model is configured (the app's, the platform's voice mode
 * model, or the read-aloud default; read aloud itself need not be switched on,
 * the speech endpoint takes a named model either way) and this user may use it; the app's speech
 * service works here; the browser has a microphone and `AudioWorklet`.
 *
 * `reason` names the first failed condition (for the admin and for tests); the
 * chat simply shows no button.
 *
 * @param {Object|null} app
 * @returns {{
 *   available: boolean,
 *   reason: string|null,
 *   settings: ReturnType<typeof resolveVoiceModeSettings>,
 *   speech: { service: 'browser'|'azure'|'model', modelId: string },
 *   platformSpeech: object|undefined,
 *   ttsModelId: string
 * }}
 */
export function useVoiceModeAvailability(app) {
  const { platformConfig } = usePlatformConfig();
  const featureFlags = useFeatureFlags();
  const settings = useMemo(
    () => resolveVoiceModeSettings({ platform: platformConfig, app }),
    [platformConfig, app]
  );
  const speech = useMemo(() => resolveSpeechService(app, platformConfig), [app, platformConfig]);
  const ttsModelId = settings.ttsModelId;
  const flagOn = featureFlags.isEnabled('voiceMode', false);
  // The list of permitted TTS models is one request per page, shared with read
  // aloud and keyed by the platform default model, whichever model this app uses.
  const ttsListKey = platformConfig?.speech?.tts?.defaultModelId || '';

  const staticReason = !flagOn
    ? 'feature-off'
    : !settings.platformEnabled
      ? 'platform-off'
      : !settings.enabled
        ? 'app-off'
        : !ttsModelId
          ? 'no-tts-model'
          : !isSpeechChoiceUsable(speech, platformConfig?.speech)
            ? 'speech-service-unavailable'
            : !isVoiceModeBrowserSupported()
              ? 'browser-unsupported'
              : null;

  // The permitted TTS models are asked for only once everything else holds.
  // The answer is kept with the model it was looked up for, so a change of
  // model shows no button until the new one has been checked.
  const [lookup, setLookup] = useState({ modelId: null, permitted: false });
  useEffect(() => {
    if (staticReason) return undefined;
    let active = true;
    loadTtsModels(ttsListKey).then(models => {
      if (!active) return;
      setLookup({ modelId: ttsModelId, permitted: models.some(model => model.id === ttsModelId) });
    });
    return () => {
      active = false;
    };
  }, [staticReason, ttsModelId, ttsListKey]);

  const permitted = lookup.modelId === ttsModelId && lookup.permitted;
  const reason = staticReason || (permitted ? null : 'tts-not-permitted');
  return {
    available: reason === null,
    reason,
    settings,
    speech,
    platformSpeech: platformConfig?.speech,
    ttsModelId
  };
}

export default useVoiceModeAvailability;
