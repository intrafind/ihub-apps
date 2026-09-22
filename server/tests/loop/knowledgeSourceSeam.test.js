/**
 * Knowledge-source badge vocabulary: which tools count as a web search. iFinder
 * searches the organisation's document index, so its answers must not be
 * badged "Based on web search".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyKnowledgeSource } from '../../services/loop/seams/knowledgeSourceSeam.js';

test('web search tools are web search', () => {
  assert.equal(classifyKnowledgeSource('braveSearch'), 'websearch');
  assert.equal(classifyKnowledgeSource('qwantSearch'), 'websearch');
  assert.equal(classifyKnowledgeSource('webSearch'), 'websearch');
});

test('iFinder functions are iFinder documents, not web search', () => {
  assert.equal(classifyKnowledgeSource('iFinder_search'), 'ifinder');
  assert.equal(classifyKnowledgeSource('iFinder_getContent'), 'ifinder');
  assert.equal(classifyKnowledgeSource('iFinder.search'), 'ifinder');
});

test('configured sources and unrelated tools keep their classification', () => {
  assert.equal(classifyKnowledgeSource('source_handbook'), 'sources');
  assert.equal(classifyKnowledgeSource('entraPeopleSearch'), null);
  assert.equal(classifyKnowledgeSource('jira'), null);
  assert.equal(classifyKnowledgeSource(''), null);
});
