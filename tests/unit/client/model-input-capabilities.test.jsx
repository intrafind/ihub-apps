import {
  modelInputCapabilities,
  modelTakesFileKind
} from '../../../client/src/shared/utils/modelInputCapabilities';

/**
 * What a model takes as input: the one rule behind the uploader's switches and the pending
 * document's attach check.
 */
describe('modelInputCapabilities', () => {
  test("vision: the model's metadata first, its id only when it says nothing", () => {
    expect(modelInputCapabilities({ id: 'gpt-4o', supportsVision: false }).vision).toBe(false);
    expect(modelInputCapabilities({ id: 'x', supportsImages: true }).vision).toBe(true);
    expect(
      modelInputCapabilities({ id: 'x', supportsVision: false, supportsImages: true }).vision
    ).toBe(false);
    expect(modelInputCapabilities({ id: 'claude-3-haiku' }).vision).toBe(true);
    expect(modelInputCapabilities({ id: 'llama' }).vision).toBe(false);
    expect(modelInputCapabilities(null).vision).toBe(false);
  });

  test('audio only where the model says so; transcription is its own mode', () => {
    expect(modelInputCapabilities({ id: 'x', supportsAudio: true }).audio).toBe(true);
    expect(modelInputCapabilities({ id: 'x' }).audio).toBe(false);
    expect(modelInputCapabilities({ id: 'w', modelType: 'transcription' }).transcription).toBe(
      true
    );
  });
});

describe('modelTakesFileKind', () => {
  const seeing = { id: 'm', supportsVision: true };
  const whisper = { id: 'w', modelType: 'transcription', supportsVision: true };

  test.each([
    ['image', seeing, true],
    ['image', { id: 'm', supportsVision: false }, false],
    ['image', whisper, false],
    ['audio', { id: 'm', supportsAudio: true }, true],
    ['audio', seeing, false],
    ['audio', whisper, true],
    ['document', seeing, true],
    ['document', whisper, false],
    ['document', null, true],
    ['image', null, false],
    ['audio', undefined, false]
  ])('%s with %j → %s', (kind, model, expected) => {
    expect(modelTakesFileKind(kind, model)).toBe(expected);
  });
});
