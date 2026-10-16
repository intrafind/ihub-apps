import { describe, it, expect } from '@jest/globals';
import {
  filterModelsForApp,
  pickInitialModelForApp
} from '../../../client/src/utils/modelFiltering';

const models = [
  { id: 'plain', supportsTools: 'none' },
  { id: 'chooser', supportsTools: 'auto' },
  { id: 'forced', supportsTools: 'required' },
  { id: 'legacy' }
];

const ids = list => list.map(model => model.id);

describe('filterModelsForApp', () => {
  it('keeps every model for an app without tools', () => {
    expect(ids(filterModelsForApp(models, { id: 'chat' }))).toEqual([
      'plain',
      'chooser',
      'forced',
      'legacy'
    ]);
  });

  it('keeps models that can take tools, and only those, for an app with tools', () => {
    // "none" is a non-empty string: a truthiness check would keep it.
    expect(ids(filterModelsForApp(models, { id: 'agent', tools: ['read_url'] }))).toEqual([
      'chooser',
      'forced'
    ]);
    expect(ids(filterModelsForApp(models, { id: 'search', websearch: { enabled: true } }))).toEqual(
      ['chooser', 'forced']
    );
  });

  it('matches a settings.model.filter value as is, or any entry of an array', () => {
    const app = filter => ({ id: 'a', settings: { model: { filter } } });

    expect(ids(filterModelsForApp(models, app({ supportsTools: 'required' })))).toEqual(['forced']);
    expect(ids(filterModelsForApp(models, app({ supportsTools: ['auto', 'required'] })))).toEqual([
      'chooser',
      'forced'
    ]);
  });
});

describe('transcription models', () => {
  const live = { id: 'gemini-live', modelType: 'transcription', default: true };
  const withLive = [...models, live];

  it('stay selectable in an app with tools: they never answer a prompt', () => {
    expect(filterModelsForApp(withLive, { tools: ['braveSearch'] }).map(m => m.id)).toEqual([
      'chooser',
      'forced',
      'gemini-live'
    ]);
  });

  it('are still bound by allowedModels', () => {
    expect(filterModelsForApp(withLive, { allowedModels: ['plain'] }).map(m => m.id)).toEqual([
      'plain'
    ]);
  });

  it('are not where a chat opens, unless the app prefers one', () => {
    expect(pickInitialModelForApp(withLive, {})).toBe('plain');
    expect(pickInitialModelForApp(withLive, { preferredModel: 'gemini-live' })).toBe('gemini-live');
  });
});
