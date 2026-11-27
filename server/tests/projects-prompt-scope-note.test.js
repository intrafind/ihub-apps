// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `<projects>` block tells the model what the projects are to the
 * conversation: "summarize the documents" in a chat with a project attached
 * means the project's documents, not a question back about which ones.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProjectsBlock } from '../services/knowledge/KnowledgeScopePlanner.js';

const project = mode => ({
  id: 'handbook',
  name: 'Handbook',
  mode,
  documents: 2,
  injected:
    mode === 'loaded'
      ? [{ doc: { id: 'itm_1', name: 'Intro.pdf' }, text: 'Welcome.', tokens: 2 }]
      : [],
  catalog: [{ id: 'itm_2', name: 'Travel.pdf' }]
});

describe('the projects block names what the projects are for', () => {
  test('a loaded project: the documents of the request are the project documents', () => {
    const block = renderProjectsBlock({ projects: [project('loaded')] });
    const [open, note] = block.split('\n');
    assert.equal(open, '<projects>');
    assert.match(note, /"the documents"/);
    assert.match(note, /they mean the documents of these projects/);
    assert.ok(!block.includes('knowledge_list for the complete one'), 'nothing to list');
  });

  test('a searched project: a request about all documents reads them, not a search', () => {
    const block = renderProjectsBlock({ projects: [project('searched')] });
    assert.match(block, /they mean the documents of these projects/);
    assert.match(block, /summarizing or comparing them.*knowledge_list.*knowledge_read/s);
  });

  test('a model without tools is not pointed to them', () => {
    const block = renderProjectsBlock({ projects: [project('searched')], toolless: true });
    assert.match(block, /they mean the documents of these projects/);
    assert.ok(!block.includes('knowledge_list for the complete one'));
  });

  test('no projects, no note', () => {
    assert.equal(renderProjectsBlock({ projects: [] }), '');
  });
});
