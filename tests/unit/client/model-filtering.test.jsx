import { describe, it, expect } from '@jest/globals';
import { filterModelsForApp } from '../../../client/src/utils/modelFiltering';

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
