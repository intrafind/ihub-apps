import { test, expect, request as playwrightRequest } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Voice mode end to end (issue #2868): a hands-free conversation with an app,
 * once per speech service — a transcription model (`model`, the conversation
 * socket), Azure Speech (`azure`, SDK mocked) and the browser (`browser`,
 * `SpeechRecognition` stubbed).
 *
 * Everything between the browser and the providers is the real iHub: the Vite
 * client, the Express server, the WebSocket bridge, the chat pipeline and the
 * speech route. Only what lives beyond iHub is stubbed, by a small HTTP server
 * this file starts: an OpenAI-compatible chat model that streams a fixed answer,
 * a Mistral-style text-to-speech endpoint that streams a tone, and an
 * OpenAI-compatible transcription endpoint (the batch provider the `model`
 * service runs per commit). The microphone is Chromium's fake device playing
 * `tests/fixtures/voice-mode/question.wav` — "What is the capital of France",
 * spoken by ffmpeg's flite voice after four seconds of silence, so the real
 * Silero VAD in the page finds the turn.
 *
 * Each run asserts that the turn is sent and lands in the chat live, the answer is
 * spoken, and the transcript is still in the chat after End.
 *
 * The test provisions the stack through the admin API (default `admin` /
 * `password123`, see CLAUDE.md) and puts everything back in `afterAll`. Run it
 * against a throwaway instance: `CONTENTS_DIR=/tmp/ihub-e2e npm run test:e2e:voice`.
 * In an environment whose Chromium is not the one Playwright expects, set
 * `PW_CHROMIUM_PATH` to its executable.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const QUESTION_AUDIO = path.resolve(here, '../fixtures/voice-mode/question.wav');
const STUB_PORT = Number(process.env.VOICE_E2E_STUB_PORT || 4177);
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const QUESTION = 'What is the capital of France';
const ANSWER = 'Sure. The capital of France is Paris. Anything else?';
const ADMIN = {
  username: process.env.E2E_ADMIN_USER || 'admin',
  password: process.env.E2E_ADMIN_PASSWORD || 'password123'
};

const MODELS = {
  chat: {
    id: 'e2e-voice-chat',
    modelId: 'e2e-voice-chat-model',
    name: { en: 'E2E voice chat', de: 'E2E voice chat' },
    description: { en: 'Voice mode E2E stub', de: 'Voice mode E2E stub' },
    url: `${STUB}/v1/chat/completions`,
    provider: 'local',
    contextWindow: 32000,
    maxOutputTokens: 4000,
    supportsTools: 'none',
    enabled: true,
    default: false,
    autoDiscovery: false,
    thinking: { enabled: true }
  },
  tts: {
    id: 'e2e-voice-tts',
    modelId: 'e2e-voice-tts-model',
    name: { en: 'E2E voice TTS', de: 'E2E voice TTS' },
    description: { en: 'Voice mode E2E stub', de: 'Voice mode E2E stub' },
    url: `${STUB}/v1/audio/speech`,
    provider: 'mistral',
    modelType: 'tts',
    apiKey: 'e2e-not-a-real-key',
    tts: { voice: 'e2e_voice' },
    enabled: true,
    default: false
  },
  stt: {
    id: 'e2e-voice-stt',
    modelId: 'e2e-voice-stt-model',
    name: { en: 'E2E voice STT', de: 'E2E voice STT' },
    description: { en: 'Voice mode E2E stub', de: 'Voice mode E2E stub' },
    url: `${STUB}/v1`,
    provider: 'openai',
    modelType: 'transcription',
    apiKey: 'e2e-not-a-real-key',
    enabled: true,
    default: false
  }
};

/** What each service needs in `platform.speech` besides voice mode itself. */
const SERVICES = {
  model: { defaultService: 'model', dictation: { modelId: MODELS.stt.id } },
  azure: {
    defaultService: 'azure',
    azure: { enabled: true, host: STUB, region: '', subscriptionKey: '' }
  },
  browser: { defaultService: 'browser' }
};

// ───────────────────────── stub providers ─────────────────────────

function tone(seconds, rate = 24000, hz = 440) {
  const samples = Math.floor(seconds * rate);
  const buffer = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i += 1) {
    buffer.writeFloatLE(0.2 * Math.sin((2 * Math.PI * hz * i) / rate), i * 4);
  }
  return buffer;
}

function startStubs(seen) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = req.url || '';
      if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
        let body = null;
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          /* not JSON */
        }
        seen.chat.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const words = ANSWER.split(/(?<= )/);
        let i = 0;
        const timer = setInterval(() => {
          const delta = i < words.length ? { content: words[i] } : {};
          const finish = i < words.length ? null : 'stop';
          res.write(
            `data: ${JSON.stringify({
              id: 'e2e',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta, finish_reason: finish }]
            })}\n\n`
          );
          i += 1;
          if (finish) {
            clearInterval(timer);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        }, 30);
        res.on('close', () => clearInterval(timer));
        return;
      }
      if (req.method === 'POST' && url.startsWith('/v1/audio/speech')) {
        let body = null;
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          /* not JSON */
        }
        seen.tts.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const audio = tone(1.5);
        const half = Math.floor(audio.length / 8) * 4;
        for (const part of [audio.subarray(0, half), audio.subarray(half)]) {
          res.write(
            `event: speech.audio.delta\ndata: ${JSON.stringify({
              type: 'speech.audio.delta',
              audio_data: part.toString('base64')
            })}\n\n`
          );
        }
        res.write(
          `event: speech.audio.done\ndata: ${JSON.stringify({ type: 'speech.audio.done', usage: {} })}\n\n`
        );
        res.end();
        return;
      }
      if (req.method === 'POST' && url.startsWith('/v1/audio/transcriptions')) {
        seen.transcriptions.push({ bytes: raw.length });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: QUESTION }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  });
  return new Promise(resolve => server.listen(STUB_PORT, '127.0.0.1', () => resolve(server)));
}

/**
 * A mock of `microsoft-cognitiveservices-speech-sdk`, served in place of the
 * real module. A recognizer "hears" `window.__sentence` when its audio stream is
 * closed, which is what the adapter does at the end of a turn.
 */
const AZURE_SDK_MOCK = `
const state = (window.__azure = window.__azure || { recognizers: 0, started: 0, bytes: 0 });
export class SpeechConfig {
  static fromHost(url) { const c = new SpeechConfig(); c.url = String(url); return c; }
  static fromAuthorizationToken() { return new SpeechConfig(); }
}
export const AudioStreamFormat = { getWaveFormatPCM: () => ({}) };
class PushStream {
  write(buffer) { state.bytes += buffer.byteLength; }
  close() { this.onclose?.(); }
}
export const AudioInputStream = { createPushStream: () => new PushStream() };
export const AudioConfig = { fromStreamInput: stream => ({ stream }) };
export const ResultReason = { RecognizingSpeech: 1, RecognizedSpeech: 2 };
export const CancellationReason = { Error: 0, EndOfStream: 1 };
export const CancellationErrorCode = { ServiceTimeout: 1, ConnectionFailure: 2 };
export class SpeechRecognizer {
  constructor(config, audio) {
    state.recognizers += 1;
    audio.stream.onclose = () => setTimeout(() => {
      this.recognized?.(this, { result: { reason: ResultReason.RecognizedSpeech, text: window.__sentence } });
      this.sessionStopped?.(this, {});
    }, 30);
  }
  startContinuousRecognitionAsync(ok) { state.started += 1; ok?.(); }
  stopContinuousRecognitionAsync(ok) { ok?.(); }
  close() {}
}
export default { SpeechConfig, AudioStreamFormat, AudioInputStream, AudioConfig, ResultReason, CancellationReason, CancellationErrorCode, SpeechRecognizer };
`;

/** `SpeechRecognition` that "hears" `window.__sentence` when it is stopped. */
function installBrowserRecognizer() {
  class FakeRecognition {
    constructor() {
      this.running = false;
    }
    start() {
      this.running = true;
      window.__recStarts = (window.__recStarts || 0) + 1;
      setTimeout(() => this.onstart?.(), 0);
    }
    stop() {
      if (!this.running) return;
      this.running = false;
      window.__recStops = (window.__recStops || 0) + 1;
      const result = Object.assign([{ transcript: window.__sentence, confidence: 0.9 }], {
        isFinal: true
      });
      setTimeout(() => {
        this.onresult?.({ resultIndex: 0, results: [result] });
        this.onend?.();
      }, 30);
    }
    abort() {
      this.running = false;
      setTimeout(() => this.onend?.(), 0);
    }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
}

// ───────────────────────── fixtures ─────────────────────────

test.use({
  permissions: ['microphone'],
  launchOptions: {
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${QUESTION_AUDIO}%noloop`,
      '--autoplay-policy=no-user-gesture-required'
    ]
  }
});
test.describe.configure({ mode: 'serial' });

const seen = { chat: [], tts: [], transcriptions: [] };
let stubServer = null;
let api = null;
let cookies = [];
let original = { speech: undefined, features: undefined };

/** Platform config as the admin sees it, with `speech` replaced. */
async function setSpeech(speech) {
  const res = await api.get('/api/admin/configs/platform');
  expect(res.ok()).toBeTruthy();
  const platform = await res.json();
  const next = { ...platform, speech };
  const saved = await api.post('/api/admin/configs/platform', { data: next });
  expect(saved.ok(), await saved.text()).toBeTruthy();
}

test.beforeAll(async () => {
  // Opt-in: the run switches voice mode on and writes three models and the
  // speech config of whatever instance Playwright points at, so the general
  // `npm run test:e2e` leaves it out. `npm run test:e2e:voice` sets the flag.
  test.skip(
    !process.env.VOICE_E2E,
    'Voice mode E2E rewrites config: run it with `npm run test:e2e:voice` on a throwaway instance'
  );
  // The fake microphone and the permission grant are Chromium's, and the stub
  // server and the shared platform config allow one run at a time, so only the
  // plain Chromium project takes part.
  test.skip(
    test.info().project.name !== 'chromium',
    'Voice mode E2E runs in the desktop Chromium project only'
  );
  test.setTimeout(150_000);
  stubServer = await startStubs(seen);
  const baseURL = test.info().project.use.baseURL || 'http://localhost:5173';
  api = await playwrightRequest.newContext({ baseURL });
  // Playwright waits for the Vite port; the API behind its proxy boots a little later.
  await expect
    .poll(async () => (await api.get('/api/health').catch(() => null))?.status() ?? 0, {
      timeout: 90_000,
      message: 'the iHub server answers /api/health'
    })
    .toBe(200);
  const login = await api.post('/api/auth/local/login', { data: ADMIN });
  expect(login.ok(), 'admin login (default admin / password123)').toBeTruthy();
  cookies = (await api.storageState()).cookies;

  const platform = await (await api.get('/api/admin/configs/platform')).json();
  original.speech = platform.speech;
  const features = await (await api.get('/api/admin/features')).json();
  original.features = Object.fromEntries(
    (features.features || []).filter(f => f.id === 'voiceMode').map(f => [f.id, f.enabled])
  );

  const enable = await api.put('/api/admin/features', { data: { voiceMode: true } });
  expect(enable.ok()).toBeTruthy();
  for (const model of Object.values(MODELS)) {
    const res = await api.put(`/api/admin/models/${model.id}`, { data: model });
    expect(res.ok(), `model ${model.id}: ${await res.text()}`).toBeTruthy();
  }
});

test.afterAll(async () => {
  if (api) {
    if (original.speech) await setSpeech(original.speech).catch(() => {});
    await api
      .put('/api/admin/features', { data: { voiceMode: original.features?.voiceMode ?? false } })
      .catch(() => {});
    for (const model of Object.values(MODELS)) {
      await api.delete(`/api/admin/models/${model.id}`).catch(() => {});
    }
    await api.dispose();
  }
  await new Promise(resolve => (stubServer ? stubServer.close(resolve) : resolve()));
});

// ───────────────────────── the runs ─────────────────────────

for (const service of ['browser', 'model', 'azure']) {
  test(`hands-free conversation through the ${service} speech service`, async ({
    page,
    context
  }) => {
    test.setTimeout(120_000);
    seen.chat.length = 0;
    seen.tts.length = 0;
    seen.transcriptions.length = 0;

    await setSpeech({
      ...(original.speech || {}),
      ...SERVICES[service],
      tts: { enabled: true, defaultModelId: MODELS.tts.id, maxCharacters: 20000 },
      voiceMode: {
        ...(original.speech?.voiceMode || {}),
        enabled: true,
        appDefault: true,
        listeningStyle: 'hands-free',
        bargeIn: true,
        endOfTurnSilenceMs: 600
      }
    });

    await context.addCookies(cookies);
    await page.addInitScript(
      ({ question }) => {
        window.__sentence = question;
      },
      { question: QUESTION }
    );
    await page.addInitScript(installBrowserRecognizer);
    if (service === 'azure') {
      await page.route(/microsoft-cognitiveservices-speech-sdk/, route =>
        route.fulfill({ contentType: 'text/javascript', body: AZURE_SDK_MOCK })
      );
    }
    const sockets = [];
    page.on('websocket', ws => {
      if (!ws.url().includes('/voice/realtime')) return;
      const entry = { url: ws.url(), sent: [] };
      ws.on('framesent', frame => {
        if (typeof frame.payload === 'string') entry.sent.push(frame.payload);
      });
      sockets.push(entry);
    });

    await page.goto(`/apps/chat?model=${MODELS.chat.id}`);
    const understand = page.getByRole('button', { name: 'I understand' });
    await understand.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    if (await understand.isVisible().catch(() => false)) await understand.click();

    // The composer is mounted twice (phone and desktop layout), one hidden by CSS.
    const voiceButton = page.locator('[data-testid="voice-mode-button"]:visible').first();
    await expect(voiceButton).toBeVisible({ timeout: 20_000 });
    // It sits right next to Send.
    await expect(voiceButton.locator('xpath=following-sibling::*[1]')).toHaveAttribute(
      'aria-label',
      'Send'
    );

    await voiceButton.click();
    // The dock takes the composer's place; the chat stays in view.
    const dock = page.getByTestId('voice-mode-dock');
    await expect(dock).toBeVisible();
    await expect(page.locator('[data-testid="voice-mode-button"]:visible')).toHaveCount(0);
    const status = page.getByTestId('voice-mode-status');
    await expect(status).toHaveText(/Listening/, { timeout: 30_000 });

    // Nothing is touched from here: the VAD finds the question, the turn ends on
    // silence, the transcript goes to the chat and the answer is spoken.
    await expect(status).toHaveText(/Thinking|Speaking/, { timeout: 45_000 });
    await expect(status).toHaveText(/Speaking/, { timeout: 45_000 });

    // What was asked and what is being answered are in the chat, live.
    await expect(page.locator('.chat-widget-message.user:visible').first()).toContainText(QUESTION);
    await expect(page.locator('.chat-widget-message.assistant:visible').first()).toContainText(
      'Paris'
    );

    // The app listens again once it has spoken.
    await expect(status).toHaveText(/Listening/, { timeout: 45_000 });

    // The turn went through the app's own pipeline, flagged as a voice turn.
    expect(seen.chat.length).toBeGreaterThanOrEqual(1);
    const system = JSON.stringify(
      (seen.chat.at(-1)?.messages || []).filter(m => m.role === 'system')
    );
    expect(system).toMatch(/by voice|read aloud|spoken/i);
    expect(seen.tts.length).toBeGreaterThanOrEqual(1);

    if (service === 'model') {
      const socket = sockets.find(s => s.sent.some(f => f.includes('"conversation":true')));
      expect(socket, 'the conversation socket was opened').toBeTruthy();
      expect(socket.sent.some(f => f.includes('"type":"commit"'))).toBe(true);
      expect(seen.transcriptions.length).toBeGreaterThanOrEqual(1);
      expect(seen.transcriptions[0].bytes).toBeGreaterThan(10_000);
    } else if (service === 'azure') {
      const azure = await page.evaluate(() => window.__azure);
      expect(azure.recognizers).toBeGreaterThanOrEqual(1);
      expect(azure.bytes).toBeGreaterThan(10_000);
    } else {
      const stops = await page.evaluate(() => window.__recStops || 0);
      expect(stops).toBeGreaterThanOrEqual(1);
    }

    // End returns to the chat, and every turn is still there as text.
    await page.getByRole('button', { name: 'End voice mode (Esc)' }).click();
    await expect(dock).toBeHidden();
    await expect(page.locator('.chat-widget-message.user').first()).toContainText(QUESTION);
    await expect(page.locator('.chat-widget-message.assistant').first()).toContainText('Paris');
    // The spoken turn carries the waveform marker.
    await expect(
      page.locator('.chat-widget-message.user .voice-wave-icon:visible').first()
    ).toBeVisible();
    // The button is idle again.
    await expect(voiceButton).toHaveAttribute('aria-pressed', 'false');
  });
}
