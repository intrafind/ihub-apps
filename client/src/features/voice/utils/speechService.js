import AzureSpeechRecognition from '../../../utils/azureRecognitionService';
import VllmRealtimeRecognition from '../../../utils/vllmRealtimeRecognitionService';

/**
 * Dictation (realtime speech-to-text) building blocks shared by the chat's
 * microphone button (`useVoiceRecognition`) and the admin voice-input test
 * panel, so both run exactly the same code path.
 *
 * Services a recognizer can be built for:
 *   - `browser`       — the browser Web Speech API (SpeechRecognition).
 *   - `azure`         — Azure Speech SDK in the browser (token brokered by iHub).
 *   - `vllm-realtime` — mic audio streamed to iHub, proxied to a vLLM endpoint.
 */
export const SPEECH_SERVICES = ['browser', 'azure', 'vllm-realtime'];

/** Display name of a dictation service (admin UI). */
export function getSpeechServiceLabel(service, t) {
  switch (service) {
    case 'azure':
      return t('admin.voiceInput.services.azure', 'Azure Speech');
    case 'vllm-realtime':
      return t('admin.voiceInput.services.vllmRealtime', 'vLLM Realtime (server-proxied)');
    default:
      return t('admin.voiceInput.services.browser', 'Browser (Web Speech API)');
  }
}

export function isBrowserSpeechSupported() {
  return (
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
  );
}

/**
 * Whether a service's platform backend is switched on in Admin → Voice Input.
 * The browser service needs no backend.
 *
 * @param {string} service
 * @param {object} [speech] `platformConfig.speech`
 */
export function isSpeechServiceEnabled(service, speech) {
  if (service === 'azure') return !!speech?.azure?.enabled;
  if (service === 'vllm-realtime') return !!speech?.realtime?.enabled;
  return true;
}

/**
 * The platform-wide default dictation service (`speech.defaultService`). Falls
 * back to the browser when the chosen backend is switched off, so apps that
 * follow the default keep working instead of failing on a disabled backend.
 *
 * @param {object} [speech] `platformConfig.speech`
 * @returns {'browser'|'azure'|'vllm-realtime'}
 */
export function getPlatformDefaultService(speech) {
  const configured = SPEECH_SERVICES.includes(speech?.defaultService)
    ? speech.defaultService
    : 'browser';
  return isSpeechServiceEnabled(configured, speech) ? configured : 'browser';
}

/**
 * The dictation service an app uses. An explicit choice wins; `default` (or no
 * setting) follows the platform default. `custom` has no implementation and has
 * always used the browser.
 *
 * @param {object} app
 * @param {object} [platformConfig]
 * @returns {'browser'|'azure'|'vllm-realtime'}
 */
export function resolveSpeechService(app, platformConfig) {
  const service = app?.settings?.speechRecognition?.service;
  if (service === 'browser' || service === 'azure' || service === 'vllm-realtime') {
    return service;
  }
  if (service === 'custom') return 'browser';
  return getPlatformDefaultService(platformConfig?.speech);
}

/**
 * Build an unstarted recognizer for a service. The caller sets `continuous`,
 * `interimResults`, `lang` and the `on*` handlers, awaits `initRecognizer()`
 * when the recognizer has one (Azure), then calls `start()`.
 *
 * @param {string} service
 * @param {object} [opts]
 * @param {string} [opts.host] Per-app Azure host; falls back to the platform host.
 * @param {object} [opts.speech] `platformConfig.speech` (public shape).
 * @throws {Error} with `code: 'not-supported'` when the browser has no Web Speech API.
 */
export function createSpeechRecognizer(service, { host = '', speech } = {}) {
  switch (service) {
    case 'azure': {
      const recognition = new AzureSpeechRecognition();
      recognition.host = host || speech?.azure?.host || '';
      // Only ask the server for a token when it holds a subscription key.
      // Without one (on-prem container, air-gapped) the recognizer connects
      // straight to the host and nothing contacts Microsoft.
      recognition.useServerToken = !!(speech?.azure?.enabled && speech?.azure?.keyConfigured);
      return recognition;
    }
    case 'vllm-realtime':
      // The endpoint is configured server-side, so no host is needed here.
      return new VllmRealtimeRecognition();
    default: {
      const SpeechRecognition =
        typeof window !== 'undefined'
          ? window.SpeechRecognition || window.webkitSpeechRecognition
          : undefined;
      if (!SpeechRecognition) {
        const error = new Error('Speech recognition not supported in this browser');
        error.code = 'not-supported';
        throw error;
      }
      return new SpeechRecognition();
    }
  }
}

const RECOGNITION_LANGUAGES = {
  en: 'en-US',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  it: 'it-IT',
  ja: 'ja-JP',
  ko: 'ko-KR',
  zh: 'zh-CN',
  ru: 'ru-RU',
  pt: 'pt-BR',
  nl: 'nl-NL',
  pl: 'pl-PL',
  tr: 'tr-TR',
  ar: 'ar-SA'
};

/** BCP-47 recognition locales offered by the admin test panel. */
export const RECOGNITION_LOCALES = Object.values(RECOGNITION_LANGUAGES);

/**
 * Map a UI language (`de`) to a recognition locale (`de-DE`). Full locales pass
 * through; unknown two-letter codes fall back to `en-US`.
 */
export function toRecognitionLang(language) {
  if (!language) return 'en-US';
  if (language.length !== 2) return language;
  return RECOGNITION_LANGUAGES[language.toLowerCase()] || 'en-US';
}

/**
 * Normalize one recognizer result event to `{ interim, final }` text.
 * Browser SpeechRecognition events carry a results list; the Azure and vLLM
 * realtime services emit `{ text, isFinal }` and set `usesTextEventShape`.
 */
export function parseRecognitionResult(event, usesTextEventShape) {
  let interim = '';
  let final = '';
  if (!usesTextEventShape) {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += text;
      else interim += text;
    }
  } else if (event && 'text' in event) {
    if (event.isFinal === false) interim = event.text;
    else final = event.text;
  }
  return { interim, final };
}

/**
 * User-facing message for a failed `getUserMedia({ audio: true })`: tells an
 * insecure context, a denied permission, a missing device and a busy device
 * apart, since each has a different fix.
 */
export function getMicrophoneErrorMessage(error, t) {
  if (
    typeof window !== 'undefined' &&
    (window.isSecureContext === false || !navigator.mediaDevices?.getUserMedia)
  ) {
    return t(
      'voiceInput.error.insecureContext',
      'Microphone access requires a secure connection (HTTPS or localhost).'
    );
  }
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return t(
        'voiceInput.error.permissionDenied',
        'Please allow microphone access and try again.'
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return t(
        'voiceInput.error.noMicrophone',
        'No microphone found. Please check your device settings.'
      );
    case 'NotReadableError':
    case 'AbortError':
      return t(
        'voiceInput.error.microphoneBusy',
        'The microphone could not be started. It may be in use by another application.'
      );
    default:
      return t('voiceInput.error.general', 'Voice input error. Please try again.');
  }
}

/** User-facing message for a recognizer `onerror` event. */
export function getRecognitionErrorMessage(event, t) {
  switch (event?.error) {
    case 'no-speech':
      return t('voiceInput.error.noSpeech', 'No speech detected. Please try again.');
    case 'audio-capture':
      return t(
        'voiceInput.error.noMicrophone',
        'No microphone found. Please check your device settings.'
      );
    case 'not-allowed':
      return t(
        'voiceInput.error.permissionDenied',
        'Please allow microphone access and try again.'
      );
    case 'network':
      return t('voiceInput.error.network', 'Network error. Please check your connection.');
    case 'service':
      // Error surfaced by a proxied backend (e.g. the vLLM realtime endpoint).
      // Prefer the server-supplied message when available.
      return (
        event.message ||
        t('voiceInput.error.service', 'Transcription service unavailable. Please try again.')
      );
    default:
      return t('voiceInput.error.general', 'Voice input error. Please try again.');
  }
}
