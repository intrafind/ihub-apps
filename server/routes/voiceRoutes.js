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
   * Read a message aloud: `POST /api/voice/speech` `{ text, modelId? }`.
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
    const platform = configCache.getPlatform() || {};
    if (!req.user && isAnonymousAccessAllowed(platform)) {
      req.user = enhanceUserWithPermissions(null, platform.auth || {}, platform);
    } else if (req.user && !req.user.permissions) {
      req.user = enhanceUserWithPermissions(req.user, platform.auth || {}, platform);
    }

    const { text, modelId } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required', code: 'invalid-text' });
    }
    if (text.length > MAX_INPUT_CHARACTERS) {
      return res.status(413).json({ error: 'text is too long', code: 'text-too-long' });
    }
    if (modelId !== undefined && typeof modelId !== 'string') {
      return res.status(400).json({ error: 'modelId must be a string', code: 'invalid-model' });
    }

    const resolved = resolveTtsModel({ modelId, user: req.user, platform });
    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: resolved.error, code: resolved.code });
    }
    const { model, provider } = resolved;

    const maxCharacters = platform.speech?.tts?.maxCharacters || DEFAULT_MAX_CHARACTERS;
    const { chunks, characters, truncated } = prepareSpeech(text, { maxCharacters });
    if (!chunks.length) {
      return res.status(422).json({ error: 'Nothing to read aloud', code: 'no-speakable-text' });
    }

    const cfg = provider.resolveUpstream(model);
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

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
      if (!controller.signal.aborted) {
        if (!started) start();
        res.end();
      }
      logger.info(
        controller.signal.aborted ? 'Read aloud stopped by the client' : 'Read aloud finished',
        {
          component: 'VoiceRoutes',
          modelId: model.id,
          userId: req.user?.id,
          characters,
          chunks: chunks.length,
          durationMs: Date.now() - startedAt
        }
      );
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
