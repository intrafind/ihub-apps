import configCache from '../configCache.js';
import { authRequired } from '../middleware/authRequired.js';
import { getAzureSpeechToken } from '../services/azureSpeechToken.js';
import { isAnonymousAccessAllowed, enhanceUserWithPermissions } from '../utils/authorization.js';
import { buildServerPath } from '../utils/basePath.js';
import logger from '../utils/logger.js';
import {
  resolveTtsModel,
  prepareSpeech,
  synthesizeChunks,
  TTS_AUDIO_ENCODING,
  DEFAULT_MAX_CHARACTERS
} from '../tts/index.js';
import { detectSpeechLanguage, normalizeLanguage } from '../tts/language.js';
import { resolveVoiceModeSettings } from '../../shared/voiceMode.js';

/** Longest message body `/api/voice/speech` accepts, before markup is stripped. */
const MAX_INPUT_CHARACTERS = 200_000;

/**
 * Write one chunk, waiting for the socket to drain when its buffer is full so a
 * slow client throttles the upstream read instead of growing server memory.
 */
function writeWithBackpressure(res, chunk) {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/** Longest `voice` id `/api/voice/speech` accepts (the model schema's limit). */
const MAX_VOICE_ID_LENGTH = 200;

/**
 * Syntheses running per user. Voice mode keeps two in flight for one answer; the
 * cap is for a client that opens far more than any player would. An aborted
 * request is not counted by the rate limiter (it answers 'failed' requests for
 * free), so this is what bounds how much a user can have the provider do at once.
 */
const MAX_CONCURRENT_SPEECH_PER_USER = 6;
const speechInFlight = new Map();

/**
 * The voices a request may pick for a text-to-speech model: the ones the admin
 * set up on the model (`tts.voice`, `tts.voices`) and the ones an app names for
 * it as its voice mode voice (`inputMode.voiceMode.voice`, on an app the user may
 * use whose voice mode is on and speaks with this model). A request cannot reach
 * any other voice of the provider account.
 *
 * @param {Object} model - The text-to-speech model
 * @param {Object} platform - Platform config
 * @param {Object} user - The caller, whose apps count
 * @returns {Promise<Set<string>>}
 */
async function configuredVoices(model, platform, user) {
  const voices = new Set();
  const add = value => {
    if (typeof value === 'string' && value.trim()) voices.add(value.trim());
  };
  add(model?.tts?.voice);
  Object.values(model?.tts?.voices || {}).forEach(add);
  const { data: apps } = (await configCache.getAppsForUser(user, platform)) || {};
  for (const app of Array.isArray(apps) ? apps : []) {
    if (!app?.inputMode?.voiceMode?.voice) continue;
    const settings = resolveVoiceModeSettings({ platform, app });
    if (settings.enabled && settings.ttsModelId === model.id) {
      add(app.inputMode.voiceMode.voice);
    }
  }
  return voices;
}

/**
 * User-facing voice / speech-to-text routes.
 *
 * `/api/voice/azure/token` brokers a short-lived Azure Speech authorization
 * token so the browser SDK never receives the subscription key. Requires
 * authentication; the key is read (decrypted) from platform.speech.azure.
 *
 * Without a configured key it answers `{ token: null }`: on-prem Azure Speech
 * containers accept unauthenticated connections to their host, so the client
 * connects keyless. Azure cloud still needs a key (the client refuses a
 * keyless session without a custom host).
 */
export default function registerVoiceRoutes(app) {
  /**
   * Read a message aloud: `POST /api/voice/speech`
   * `{ text, modelId?, language?, languageFixed?, voice? }`.
   * `language` is a hint (the user's UI language) for when the message's own
   * language cannot be told from its text; it picks the voice from the
   * model's `tts.voices` (see server/tts/language.js).
   *
   * Voice mode reads one answer in several requests (a chunk each). With
   * `languageFixed: true` the `language` is used as given and nothing is
   * detected, so every chunk of the answer gets the voice the first one got
   * (its `X-Speech-Language`) even when a short chunk would be told differently.
   * `voice` picks one of the model's configured voices for the request (see
   * `configuredVoices`); without it the voice follows the language.
   *
   * Streams the speech as it is generated — raw 16-bit signed little-endian
   * mono PCM (`X-Audio-Encoding: pcm_s16le`, rate in `X-Audio-Sample-Rate`)
   * over a chunked response — so the browser starts playing within a second
   * however long the answer is. Errors before the first audio byte are JSON
   * with a status; a failure mid-stream destroys the response so the client
   * sees an interrupted stream rather than a clean end.
   *
   * Closing the request (the user pressed stop, or left the chat) aborts the
   * upstream request, so audio nobody will hear is not paid for.
   */
  app.post(buildServerPath('/api/voice/speech'), authRequired, async (req, res) => {
    // First thing: a client that hangs up at any point, even before this
    // handler ran (its `close` is then already past), starts no synthesis.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    if (res.destroyed || req.socket?.destroyed) controller.abort();

    const platform = configCache.getPlatform() || {};
    if (!req.user && isAnonymousAccessAllowed(platform)) {
      req.user = enhanceUserWithPermissions(null, platform.auth || {}, platform);
    } else if (req.user && !req.user.permissions) {
      req.user = enhanceUserWithPermissions(req.user, platform.auth || {}, platform);
    }

    const {
      text,
      modelId,
      language: languageHint,
      languageFixed,
      voice: requestedVoice
    } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required', code: 'invalid-text' });
    }
    if (text.length > MAX_INPUT_CHARACTERS) {
      return res.status(413).json({ error: 'text is too long', code: 'text-too-long' });
    }
    if (modelId !== undefined && typeof modelId !== 'string') {
      return res.status(400).json({ error: 'modelId must be a string', code: 'invalid-model' });
    }
    if (languageFixed !== undefined && typeof languageFixed !== 'boolean') {
      return res
        .status(400)
        .json({ error: 'languageFixed must be a boolean', code: 'invalid-language' });
    }
    if (languageFixed === true && typeof languageHint !== 'string') {
      return res.status(400).json({
        error: 'language is required when languageFixed is true',
        code: 'invalid-language'
      });
    }
    if (
      requestedVoice !== undefined &&
      (typeof requestedVoice !== 'string' || requestedVoice.length > MAX_VOICE_ID_LENGTH)
    ) {
      return res.status(400).json({ error: 'voice must be a string', code: 'invalid-voice' });
    }

    const resolved = resolveTtsModel({ modelId, user: req.user, platform });
    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: resolved.error, code: resolved.code });
    }
    const { model, provider } = resolved;

    const speechKey = req.user?.id || req.ip || 'unknown';
    const running = speechInFlight.get(speechKey) || 0;
    if (running >= MAX_CONCURRENT_SPEECH_PER_USER) {
      return res
        .status(429)
        .json({ error: 'Too many speech requests at once', code: 'too-many-requests' });
    }
    speechInFlight.set(speechKey, running + 1);
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      const left = (speechInFlight.get(speechKey) || 1) - 1;
      if (left > 0) speechInFlight.set(speechKey, left);
      else speechInFlight.delete(speechKey);
    };
    res.once('close', releaseSlot);
    if (res.destroyed) releaseSlot();

    // A voice the request picks has to be one the admin configured; it replaces
    // the one the language chooses.
    const voice = typeof requestedVoice === 'string' ? requestedVoice.trim() : '';
    if (voice && !(await configuredVoices(model, platform, req.user)).has(voice)) {
      return res.status(400).json({ error: 'Unknown voice for this model', code: 'invalid-voice' });
    }

    const maxCharacters = platform.speech?.tts?.maxCharacters || DEFAULT_MAX_CHARACTERS;
    const { chunks, characters, truncated } = prepareSpeech(text, { maxCharacters });
    if (!chunks.length) {
      return res.status(422).json({ error: 'Nothing to read aloud', code: 'no-speakable-text' });
    }

    // One voice for the whole message: its language decides it once. A caller
    // that already knows the language (the rest of an answer read in chunks)
    // fixes it, and nothing is detected. A language the speech models do not
    // list is not a failure mid-answer: it simply gets the model's own voice.
    const language = languageFixed
      ? normalizeLanguage(languageHint)
      : detectSpeechLanguage(chunks.join('\n\n'), {
          hint: typeof languageHint === 'string' ? languageHint : undefined
        });
    const upstream = provider.resolveUpstream(model, { language });
    const cfg = voice ? { ...upstream, voice } : upstream;

    let started = false;
    const start = () => {
      started = true;
      res.status(200);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Audio-Encoding', TTS_AUDIO_ENCODING);
      res.setHeader('X-Audio-Sample-Rate', String(provider.sampleRate));
      res.setHeader('X-Audio-Channels', '1');
      res.setHeader('X-Speech-Characters', String(characters));
      if (language) res.setHeader('X-Speech-Language', language);
      if (truncated) res.setHeader('X-Speech-Truncated', 'true');
      res.flushHeaders?.();
    };

    const startedAt = Date.now();
    try {
      await synthesizeChunks({
        provider,
        cfg,
        chunks,
        signal: controller.signal,
        onAudio: pcm => {
          if (controller.signal.aborted) return undefined;
          if (!started) start();
          return writeWithBackpressure(res, pcm);
        }
      });
      const summary = {
        component: 'VoiceRoutes',
        modelId: model.id,
        userId: req.user?.id,
        characters,
        chunks: chunks.length,
        language,
        voice: cfg.voice,
        durationMs: Date.now() - startedAt
      };
      if (controller.signal.aborted) {
        logger.info('Read aloud stopped by the client', summary);
        return undefined;
      }
      if (!started) {
        // The provider finished without a single sample: a failure, reported
        // like any other before the first byte rather than as empty audio.
        logger.error('Read aloud returned no audio', summary);
        return res.status(502).json({ error: 'No audio was returned', code: 'no-audio' });
      }
      res.end();
      logger.info('Read aloud finished', summary);
    } catch (error) {
      if (controller.signal.aborted) {
        logger.info('Read aloud stopped by the client', {
          component: 'VoiceRoutes',
          modelId: model.id,
          userId: req.user?.id,
          durationMs: Date.now() - startedAt
        });
        return undefined;
      }
      logger.error('Read aloud failed', {
        component: 'VoiceRoutes',
        modelId: model.id,
        userId: req.user?.id,
        error: error.message,
        status: error.status
      });
      if (!started) {
        // Upstream messages are built to be safe to show (no hosts, no keys);
        // anything else is a bug whose details belong in the log only.
        const message = error.name === 'TtsUpstreamError' ? error.message : 'Text-to-speech failed';
        return res.status(502).json({ error: message, code: 'upstream-error' });
      }
      res.destroy(error);
    }
    return undefined;
  });

  app.get(buildServerPath('/api/voice/azure/token'), authRequired, async (req, res) => {
    try {
      const azure = (configCache.getPlatform() || {}).speech?.azure || {};
      if (!azure.enabled) {
        return res.status(503).json({ error: 'Azure Speech is not enabled' });
      }
      if (!azure.subscriptionKey) {
        return res.json({ token: null, region: azure.region || '' });
      }
      const result = await getAzureSpeechToken({
        subscriptionKey: azure.subscriptionKey, // decrypted by configCache on load
        region: azure.region
      });
      if (!result.ok) {
        return res.status(502).json({ error: result.error });
      }
      return res.json({ token: result.token, region: result.region });
    } catch (error) {
      logger.error('Failed to issue Azure Speech token', {
        component: 'VoiceRoutes',
        error: error.message
      });
      return res.status(500).json({ error: 'Failed to issue Azure Speech token' });
    }
  });
}
