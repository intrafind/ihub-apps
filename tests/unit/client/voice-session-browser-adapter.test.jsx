/**
 * Voice mode (issue #2868), speech service `browser`: the Web Speech API.
 * `SpeechRecognition` is stubbed; the tests play the browser: results arrive,
 * the recognizer ends on its own (Chrome does that) or when it was stopped.
 *
 * What matters here: the recognizer listens while the app is quiet and is
 * paused while it speaks, restarts when it ends under a turn, and `stop()`
 * turns its last result into the turn's final transcript.
 */

jest.mock('../../../client/src/utils/azureRecognitionService', () => ({
  __esModule: true,
  default: class {}
}));
jest.mock('../../../client/src/utils/modelRecognitionService', () => ({
  __esModule: true,
  default: class {}
}));

import { createBrowserAdapter } from '../../../client/src/features/voice/utils/voiceSession/browserAdapter';

class FakeRecognition {
  static instances = [];

  constructor() {
    this.running = false;
    this.startCalls = 0;
    this.stopCalls = 0;
    this.abortCalls = 0;
    FakeRecognition.instances.push(this);
  }

  start() {
    if (this.running) throw new Error('InvalidStateError');
    this.running = true;
    this.startCalls += 1;
  }

  stop() {
    this.stopCalls += 1;
  }

  abort() {
    this.abortCalls += 1;
    // Like the browser: abort ends the recognition without delivering results
    this.end();
  }

  // --- what the browser does ---
  /** @param {Array<[string, boolean]>} results - [transcript, isFinal] pairs, all results so far */
  hear(results) {
    this.onresult?.({
      resultIndex: 0,
      results: results.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }))
    });
  }

  end() {
    if (!this.running) return;
    this.running = false;
    this.onend?.();
  }

  fail(error) {
    this.onerror?.({ error });
  }
}

const current = () => FakeRecognition.instances[FakeRecognition.instances.length - 1];

function setup(options = {}) {
  FakeRecognition.instances = [];
  const events = [];
  const adapter = createBrowserAdapter({
    language: 'de',
    emit: event => events.push(event),
    getRecognitionCtor: () => FakeRecognition,
    finalizeTimeoutMs: 1000,
    restartDelayMs: 50,
    ...options
  });
  return { adapter, events };
}

const texts = (events, type) => events.filter(event => event.type === type).map(e => e.text);
const advance = ms => jest.advanceTimersByTime(ms);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('browser adapter: when the recognizer listens', () => {
  test('is unsupported without the Web Speech API', async () => {
    const { adapter } = setup({ getRecognitionCtor: () => undefined });
    await expect(adapter.start()).rejects.toMatchObject({ code: 'unsupported' });
  });

  test('hands-free: starts at once, continuous with interim results, in the UI language', async () => {
    const { adapter } = setup();
    await adapter.start();
    const rec = current();
    expect(rec.running).toBe(true);
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.lang).toBe('de-DE');
    adapter.stop();
  });

  test('push-to-talk: does not listen until the key goes down', async () => {
    const { adapter } = setup({ listeningStyle: 'push-to-talk' });
    await adapter.start();
    expect(FakeRecognition.instances).toHaveLength(0);

    adapter.beginTurn();
    expect(current().running).toBe(true);

    adapter.commitTurn();
    expect(current().stopCalls).toBe(1);
    current().end();
    advance(1000);
    // No turn, no listening: it is not restarted
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(current().running).toBe(false);
    adapter.stop();
  });

  test('is paused while the app speaks and starts again when it is quiet', async () => {
    const { adapter } = setup();
    await adapter.start();
    const first = current();

    adapter.setAgentState('thinking');
    expect(first.running).toBe(true); // the app is not speaking yet

    adapter.setAgentState('speaking');
    expect(first.abortCalls).toBe(1);
    expect(first.running).toBe(false);
    advance(1000);
    expect(FakeRecognition.instances).toHaveLength(1); // stays paused

    adapter.setAgentState('idle');
    advance(50);
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(current().running).toBe(true);
    adapter.stop();
  });

  test('a user interrupting the app starts it again although the app is still marked speaking', async () => {
    const { adapter } = setup();
    await adapter.start();
    adapter.setAgentState('speaking');
    expect(current().running).toBe(false);

    adapter.beginTurn(); // barge-in
    advance(50);
    expect(FakeRecognition.instances.length).toBeGreaterThan(1);
    expect(current().running).toBe(true);
    adapter.stop();
  });

  test('muted: does not listen; unmuting listens again', async () => {
    const { adapter } = setup();
    await adapter.start();
    adapter.setMuted(true);
    expect(current().running).toBe(false);
    advance(1000);
    expect(FakeRecognition.instances).toHaveLength(1);
    adapter.setMuted(false);
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(current().running).toBe(true);
    adapter.stop();
  });

  test('switching to push-to-talk stops the idle listening', async () => {
    const { adapter } = setup();
    await adapter.start();
    adapter.setListeningStyle('push-to-talk');
    expect(current().running).toBe(false);
    adapter.stop();
  });
});

describe('browser adapter: a turn', () => {
  test('shows interim text and ends with the text the recognizer finished with', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    adapter.beginTurn();
    const rec = current();

    rec.hear([['Wie ist', false]]);
    rec.hear([['Wie ist das Wetter', false]]);
    expect(texts(events, 'interim')).toEqual(['Wie ist', 'Wie ist das Wetter']);

    adapter.commitTurn();
    expect(rec.stopCalls).toBe(1);
    expect(texts(events, 'final')).toEqual([]); // waits for the result `stop()` brings

    rec.hear([['Wie ist das Wetter heute', true]]);
    rec.end();
    expect(texts(events, 'final')).toEqual(['Wie ist das Wetter heute']);
    adapter.stop();
  });

  test('several finished phrases of one turn are joined', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    adapter.beginTurn();
    const rec = current();
    rec.hear([['Guten Tag.', true]]);
    rec.hear([
      ['Guten Tag.', true],
      [' Ich habe eine Frage', false]
    ]);
    adapter.commitTurn();
    rec.hear([
      ['Guten Tag.', true],
      [' Ich habe eine Frage.', true]
    ]);
    rec.end();
    expect(texts(events, 'final')).toEqual(['Guten Tag. Ich habe eine Frage.']);
    adapter.stop();
  });

  test('what the recognizer finished before the turn started does not belong to it', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    const rec = current();
    // A cough that the browser transcribed, before voice activity detection confirmed speech
    rec.hear([['Äh', true]]);

    adapter.beginTurn();
    rec.hear([
      ['Äh', true],
      ['Hallo', false]
    ]);
    adapter.commitTurn();
    rec.hear([
      ['Äh', true],
      ['Hallo', true]
    ]);
    rec.end();
    expect(texts(events, 'final')).toEqual(['Hallo']);
    adapter.stop();
  });

  test('words the recognizer already heard when the turn is confirmed are part of it', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    const rec = current();
    rec.hear([['Hallo', false]]); // in progress while the detector made up its mind
    adapter.beginTurn();
    expect(texts(events, 'interim')).toEqual(['Hallo']);
    adapter.commitTurn();
    rec.hear([['Hallo Welt', true]]);
    rec.end();
    expect(texts(events, 'final')).toEqual(['Hallo Welt']);
    adapter.stop();
  });

  test('the interim text is the final if the browser ends without a last result', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    adapter.beginTurn();
    current().hear([['Nur ein Satz', false]]);
    adapter.commitTurn();
    current().end();
    expect(texts(events, 'final')).toEqual(['Nur ein Satz']);
    adapter.stop();
  });

  test('a turn in which nothing was recognised ends with an empty transcript', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    adapter.beginTurn();
    adapter.commitTurn();
    current().end();
    expect(texts(events, 'final')).toEqual(['']);
    adapter.stop();
  });

  test('a recognizer that never answers stop() does not hang the turn', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    adapter.beginTurn();
    const rec = current();
    rec.hear([['Hallo', false]]);
    adapter.commitTurn();
    expect(texts(events, 'final')).toEqual([]);
    advance(1000);
    expect(texts(events, 'final')).toEqual(['Hallo']);
    expect(rec.abortCalls).toBe(1);
    adapter.stop();
  });

  test('listening resumes after the turn, in hands-free', async () => {
    const { adapter } = setup();
    await adapter.start();
    adapter.beginTurn();
    adapter.commitTurn();
    current().end();
    advance(50);
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(current().running).toBe(true);
    adapter.stop();
  });

  test('a recognition that ends under the turn (Chrome does that) continues it without losing text', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    adapter.beginTurn();
    const first = current();
    first.hear([['Erster Teil', true]]);

    first.end(); // not asked for: the browser timed it out
    advance(50);
    const second = current();
    expect(second).not.toBe(first);
    expect(second.running).toBe(true);

    second.hear([['zweiter Teil', false]]);
    expect(texts(events, 'interim').slice(-1)).toEqual(['Erster Teil zweiter Teil']);
    adapter.commitTurn();
    second.hear([['zweiter Teil', true]]);
    second.end();
    expect(texts(events, 'final')).toEqual(['Erster Teil zweiter Teil']);
    adapter.stop();
  });

  test('speaking again while the last turn is still finalised starts the next turn after it', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    adapter.beginTurn();
    const first = current();
    first.hear([['Eins', false]]);
    adapter.commitTurn();

    adapter.beginTurn(); // while `stop()` is still on its way
    first.hear([['Eins', true]]);
    first.end();
    expect(texts(events, 'final')).toEqual(['Eins']);

    advance(50);
    const second = current();
    expect(second).not.toBe(first);
    second.hear([['Zwei', false]]);
    adapter.commitTurn();
    second.hear([['Zwei', true]]);
    second.end();
    expect(texts(events, 'final')).toEqual(['Eins', 'Zwei']);
    adapter.stop();
  });

  test('a dropped turn (muted mid-sentence) produces no transcript', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    adapter.beginTurn();
    current().hear([['Halbfertig', false]]);
    adapter.cancelTurn();
    advance(1000);
    expect(texts(events, 'final')).toEqual([]);
    adapter.stop();
  });

  test('interim text is not reported once the user muted', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    adapter.beginTurn();
    adapter.setMuted(true);
    current().hear([['too late', false]]);
    expect(texts(events, 'interim')).toEqual([]);
    adapter.stop();
  });
});

describe('browser adapter: errors', () => {
  test('silence ("no-speech") and aborts are normal: no error, listening goes on', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    const rec = current();
    rec.fail('no-speech');
    rec.end();
    advance(50);
    expect(events).toEqual([]);
    expect(current()).not.toBe(rec);
    expect(current().running).toBe(true);
    adapter.stop();
  });

  test('a denied microphone ends the session', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    current().fail('not-allowed');
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', code: 'mic-denied', recoverable: false })
    ]);
    adapter.stop();
  });

  test('a recognizer that keeps failing ends the session instead of looping', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    for (let i = 0; i < 3; i++) {
      current().fail('network');
      current().end();
      advance(50);
    }
    const errors = events.filter(event => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'connection', recoverable: false });
    const instances = FakeRecognition.instances.length;
    advance(5000);
    expect(FakeRecognition.instances).toHaveLength(instances); // no more restarts
    adapter.stop();
  });

  test('a result clears the failure count', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    for (let i = 0; i < 2; i++) {
      current().fail('network');
      current().end();
      advance(50);
    }
    current().hear([['alive', false]]);
    for (let i = 0; i < 2; i++) {
      current().fail('network');
      current().end();
      advance(50);
    }
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    adapter.stop();
  });

  test('a recognizer that ends the moment it starts counts as a failure', async () => {
    let clock = 0;
    const { adapter, events } = setup({ now: () => clock });
    await adapter.start();
    for (let i = 0; i < 3; i++) {
      clock += 10; // lived 10 ms
      current().end();
      advance(50);
    }
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    adapter.stop();
  });

  test('stop() aborts the recognizer and nothing restarts it', async () => {
    const { adapter, events } = setup();
    await adapter.start();
    const rec = current();
    adapter.stop();
    expect(rec.abortCalls).toBe(1);
    advance(5000);
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(events).toEqual([]);
    adapter.stop(); // idempotent
    expect(rec.abortCalls).toBe(1);
  });
});
