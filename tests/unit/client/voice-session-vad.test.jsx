/**
 * Voice mode (issue #2868), turn detection: the controller that turns the
 * voice activity detector's raw events into "a user turn started / the user
 * interrupted the app / the turn ended", and the self-hosted asset pipeline.
 *
 * The real Silero model and ONNX Runtime cannot run under jest, so the
 * detector is a fake behind the same factory shape as `createSileroVad`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const mockBuildAssetUrl = jest.fn();
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildAssetUrl: (...args) => mockBuildAssetUrl(...args)
}));

import {
  VAD_DEFAULTS,
  createVadController,
  vadThresholds
} from '../../../client/src/features/voice/utils/voiceSession/vad';
import { getVadAssetBaseUrl } from '../../../client/src/features/voice/utils/voiceSession/vadAssets';
import { VAD_ASSETS, VAD_ASSET_DIR } from '../../../client/vite-plugins/vad-asset-files';

/** A detector the test drives by hand. */
function fakeVadFactory() {
  const created = [];
  const factory = jest.fn(async options => {
    const vad = {
      options,
      setOptions: jest.fn(),
      start: jest.fn(async () => {}),
      pause: jest.fn(async () => {}),
      destroy: jest.fn(async () => {})
    };
    created.push(vad);
    return vad;
  });
  return { factory, created, last: () => created[created.length - 1] };
}

/** Run a full utterance through the detector callbacks. */
const speak = (vad, { real = true, end = true } = {}) => {
  vad.options.onSpeechStart();
  if (real) vad.options.onSpeechRealStart();
  if (end) vad.options.onSpeechEnd();
};

async function setup(options = {}) {
  const fake = fakeVadFactory();
  let clock = 1000;
  const handlers = {
    onSpeechStart: jest.fn(),
    onBargeIn: jest.fn(),
    onSpeechEnd: jest.fn()
  };
  const controller = await createVadController({
    createVad: fake.factory,
    stream: { id: 'stream' },
    audioContext: { id: 'context' },
    assetBaseUrl: 'http://localhost/vad/',
    now: () => clock,
    ...handlers,
    ...options
  });
  return { ...fake, controller, handlers, vad: fake.last(), advance: ms => (clock += ms) };
}

describe('vadThresholds', () => {
  test('idle: the defaults of the concept', () => {
    expect(vadThresholds({ speaking: false })).toEqual({
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      minSpeechMs: 250
    });
  });

  test('while the app speaks: +0.15 on both thresholds and the longer minimum speech', () => {
    expect(vadThresholds({ speaking: true })).toEqual({
      positiveSpeechThreshold: 0.65,
      negativeSpeechThreshold: 0.5,
      minSpeechMs: 350
    });
  });

  test('the barge-in minimum never lowers a longer minimum speech', () => {
    expect(vadThresholds({ speaking: true, minSpeechMs: 500 }).minSpeechMs).toBe(500);
  });

  test('stays inside what the model can use', () => {
    const high = vadThresholds({ speaking: true, positiveSpeechThreshold: 0.9 });
    expect(high.positiveSpeechThreshold).toBeLessThanOrEqual(0.95);
    expect(high.negativeSpeechThreshold).toBeLessThan(high.positiveSpeechThreshold);
  });

  test('the defaults are the documented ones', () => {
    expect(VAD_DEFAULTS).toMatchObject({
      redemptionMs: 800,
      minSpeechMs: 250,
      preSpeechPadMs: 300,
      bargeInMinSpeechMs: 350,
      bargeInThresholdBoost: 0.15
    });
  });
});

describe('createVadController', () => {
  test('creates the detector on the session stream and context with the idle parameters', async () => {
    const { factory, vad } = await setup({
      redemptionMs: 1200,
      minSpeechMs: 200,
      preSpeechPadMs: 300
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(vad.options).toMatchObject({
      stream: { id: 'stream' },
      audioContext: { id: 'context' },
      assetBaseUrl: 'http://localhost/vad/',
      redemptionMs: 1200,
      preSpeechPadMs: 300,
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      minSpeechMs: 200
    });
  });

  test('speech while the app is quiet starts a turn once and ends it once', async () => {
    const { vad, handlers, advance } = await setup();
    vad.options.onSpeechStart();
    advance(260);
    vad.options.onSpeechRealStart();
    expect(handlers.onSpeechStart).toHaveBeenCalledTimes(1);
    // The turn knows when the speech really began, 260 ms earlier
    expect(handlers.onSpeechStart).toHaveBeenCalledWith({ speechStartedAt: 1000 });
    expect(handlers.onBargeIn).not.toHaveBeenCalled();
    expect(handlers.onSpeechEnd).not.toHaveBeenCalled();
    vad.options.onSpeechEnd();
    expect(handlers.onSpeechEnd).toHaveBeenCalledTimes(1);
  });

  test('a blip shorter than the minimum speech starts nothing', async () => {
    const { vad, handlers } = await setup();
    vad.options.onSpeechStart();
    vad.options.onMisfire();
    expect(handlers.onSpeechStart).not.toHaveBeenCalled();
    expect(handlers.onSpeechEnd).not.toHaveBeenCalled();
  });

  test('speech while the app speaks is a barge-in, not a speech start', async () => {
    const { vad, handlers, controller } = await setup();
    controller.setAgentSpeaking(true);
    speak(vad);
    expect(handlers.onBargeIn).toHaveBeenCalledTimes(1);
    expect(handlers.onSpeechStart).not.toHaveBeenCalled();
    expect(handlers.onSpeechEnd).toHaveBeenCalledTimes(1);
  });

  test('with interruptions off, speech over the app is ignored altogether', async () => {
    const { vad, handlers, controller } = await setup({ bargeIn: false });
    controller.setAgentSpeaking(true);
    speak(vad);
    expect(handlers.onBargeIn).not.toHaveBeenCalled();
    expect(handlers.onSpeechStart).not.toHaveBeenCalled();
    expect(handlers.onSpeechEnd).not.toHaveBeenCalled();
  });

  test('an ignored utterance stays ignored when the app falls silent while it goes on', async () => {
    const { vad, handlers, controller } = await setup({ bargeIn: false });
    controller.setAgentSpeaking(true);
    vad.options.onSpeechStart();
    vad.options.onSpeechRealStart();
    controller.setAgentSpeaking(false);
    vad.options.onSpeechEnd();
    expect(handlers.onSpeechStart).not.toHaveBeenCalled();
    expect(handlers.onSpeechEnd).not.toHaveBeenCalled();
    // The next utterance is a turn again
    speak(vad);
    expect(handlers.onSpeechStart).toHaveBeenCalledTimes(1);
  });

  test('with interruptions off, speech while the app only thinks starts no turn either', async () => {
    const { vad, handlers, controller } = await setup({ bargeIn: false });
    controller.setAgentBusy(true);
    speak(vad);
    expect(handlers.onSpeechStart).not.toHaveBeenCalled();
    expect(handlers.onBargeIn).not.toHaveBeenCalled();
    expect(handlers.onSpeechEnd).not.toHaveBeenCalled();

    // Once the app is done the user's next utterance is a turn again.
    controller.setAgentBusy(false);
    speak(vad);
    expect(handlers.onSpeechStart).toHaveBeenCalledTimes(1);
    expect(handlers.onSpeechEnd).toHaveBeenCalledTimes(1);
  });

  test('a controller created while the app is busy ignores speech with interruptions off', async () => {
    const { vad, handlers } = await setup({ bargeIn: false, agentBusy: true });
    speak(vad);
    expect(handlers.onSpeechStart).not.toHaveBeenCalled();
  });

  test('with interruptions on, speech while the app thinks is an ordinary turn start, thresholds unchanged', async () => {
    const { vad, handlers, controller } = await setup();
    controller.setAgentBusy(true);
    expect(vad.setOptions).not.toHaveBeenCalled();
    speak(vad);
    expect(handlers.onSpeechStart).toHaveBeenCalledTimes(1);
    expect(handlers.onBargeIn).not.toHaveBeenCalled();
    expect(handlers.onSpeechEnd).toHaveBeenCalledTimes(1);
  });

  test('interruptions can be switched on and off while the session runs', async () => {
    const { vad, handlers, controller } = await setup({ bargeIn: false });
    controller.setAgentSpeaking(true);
    controller.setBargeIn(true);
    speak(vad);
    expect(handlers.onBargeIn).toHaveBeenCalledTimes(1);
  });

  test('the thresholds rise while the app speaks and fall back after', async () => {
    const { vad, controller } = await setup();
    controller.setAgentSpeaking(true);
    expect(vad.setOptions).toHaveBeenLastCalledWith({
      positiveSpeechThreshold: 0.65,
      negativeSpeechThreshold: 0.5,
      minSpeechMs: 350
    });
    controller.setAgentSpeaking(false);
    expect(vad.setOptions).toHaveBeenLastCalledWith({
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      minSpeechMs: 250
    });
    expect(vad.setOptions).toHaveBeenCalledTimes(2);
  });

  test('repeating the same state does not touch the detector', async () => {
    const { vad, controller } = await setup();
    controller.setAgentSpeaking(false);
    controller.setAgentSpeaking(true);
    controller.setAgentSpeaking(true);
    expect(vad.setOptions).toHaveBeenCalledTimes(1);
  });

  test('a detector created while the app speaks starts with the raised thresholds', async () => {
    const { vad } = await setup({ agentSpeaking: true });
    expect(vad.options).toMatchObject({
      positiveSpeechThreshold: 0.65,
      negativeSpeechThreshold: 0.5,
      minSpeechMs: 350
    });
  });

  test('custom parameters carry through to the boosted values', async () => {
    const { vad, controller } = await setup({
      positiveSpeechThreshold: 0.4,
      bargeInThresholdBoost: 0.2,
      bargeInMinSpeechMs: 500
    });
    controller.setAgentSpeaking(true);
    const update = vad.setOptions.mock.calls.at(-1)[0];
    expect(update.positiveSpeechThreshold).toBeCloseTo(0.6);
    expect(update.minSpeechMs).toBe(500);
  });

  test('when the detector skips its "real start" the utterance is still a turn', async () => {
    // The minimum speech changes while an utterance runs (the app starts or stops
    // speaking); the detector can then end it without ever reporting the start.
    const { vad, handlers } = await setup();
    vad.options.onSpeechStart();
    vad.options.onSpeechEnd();
    expect(handlers.onSpeechStart).toHaveBeenCalledTimes(1);
    expect(handlers.onSpeechEnd).toHaveBeenCalledTimes(1);
  });

  test('a turn that the detector later calls a blip still ends', async () => {
    const { vad, handlers } = await setup();
    vad.options.onSpeechStart();
    vad.options.onSpeechRealStart();
    vad.options.onMisfire();
    expect(handlers.onSpeechStart).toHaveBeenCalledTimes(1);
    expect(handlers.onSpeechEnd).toHaveBeenCalledTimes(1);
  });

  test('a disabled controller pauses the detector and ignores utterances', async () => {
    const { vad, handlers, controller } = await setup();
    await controller.setEnabled(false);
    expect(vad.pause).toHaveBeenCalledTimes(1);
    // Events still in flight when it paused
    speak(vad);
    expect(handlers.onSpeechStart).not.toHaveBeenCalled();
    await controller.setEnabled(true);
    expect(vad.start).toHaveBeenCalledTimes(1);
    speak(vad);
    expect(handlers.onSpeechStart).toHaveBeenCalledTimes(1);
  });

  test('a controller created disabled pauses the detector at once', async () => {
    const { vad } = await setup({ enabled: false });
    expect(vad.pause).toHaveBeenCalledTimes(1);
  });

  test('isTurnActive follows the utterance', async () => {
    const { vad, controller } = await setup();
    expect(controller.isTurnActive()).toBe(false);
    vad.options.onSpeechStart();
    vad.options.onSpeechRealStart();
    expect(controller.isTurnActive()).toBe(true);
    vad.options.onSpeechEnd();
    expect(controller.isTurnActive()).toBe(false);
  });

  test('destroy releases the detector once and silences later events', async () => {
    const { vad, handlers, controller } = await setup();
    await controller.destroy();
    await controller.destroy();
    expect(vad.destroy).toHaveBeenCalledTimes(1);
    speak(vad);
    expect(handlers.onSpeechStart).not.toHaveBeenCalled();
    await controller.setEnabled(false);
    expect(vad.pause).not.toHaveBeenCalled();
  });

  test('a detector that throws does not break the controller', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { vad, controller } = await setup();
    vad.setOptions.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => controller.setAgentSpeaking(true)).not.toThrow();
    vad.pause.mockRejectedValue(new Error('boom'));
    await expect(controller.setEnabled(false)).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('self-hosted VAD assets', () => {
  beforeEach(() => mockBuildAssetUrl.mockReset());

  test('the base URL is absolute and follows the deployment base path', () => {
    mockBuildAssetUrl.mockReturnValue('/ihub/vad/');
    expect(getVadAssetBaseUrl()).toBe('http://localhost/ihub/vad/');
    expect(mockBuildAssetUrl).toHaveBeenCalledWith('/vad/');
  });

  test('at the root of the host it is /vad/', () => {
    mockBuildAssetUrl.mockReturnValue('/vad/');
    expect(getVadAssetBaseUrl()).toBe('http://localhost/vad/');
  });

  test('a host that serves the API from another origin keeps that origin', () => {
    mockBuildAssetUrl.mockReturnValue('https://ihub.example.com/vad/');
    expect(getVadAssetBaseUrl()).toBe('https://ihub.example.com/vad/');
  });

  describe('the build publishes every file the detector loads', () => {
    const clientDir = path.resolve(__dirname, '../../../client');
    const requireFromClient = createRequire(path.join(clientDir, 'package.json'));

    test('they are published under /vad/', () => {
      expect(VAD_ASSET_DIR).toBe('vad');
      expect(VAD_ASSETS.map(asset => asset.name).sort()).toEqual([
        'ort-wasm-simd-threaded.mjs',
        'ort-wasm-simd-threaded.wasm',
        'silero_vad_v5.onnx',
        'vad.worklet.bundle.min.js'
      ]);
    });

    test.each(VAD_ASSETS.map(asset => [asset.name, asset.specifier]))(
      '%s exists in node_modules',
      (_name, specifier) => {
        const file = requireFromClient.resolve(specifier);
        expect(fs.existsSync(file)).toBe(true);
        expect(fs.statSync(file).size).toBeGreaterThan(1000);
      }
    );

    test('the library and the runtime that ship the files are pinned exactly', () => {
      const { dependencies } = JSON.parse(
        fs.readFileSync(path.join(clientDir, 'package.json'), 'utf8')
      );
      // The wasm and the model must match the library's JavaScript: no ranges.
      expect(dependencies['@ricky0123/vad-web']).toMatch(/^\d+\.\d+\.\d+$/);
      expect(dependencies['onnxruntime-web']).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });
});
