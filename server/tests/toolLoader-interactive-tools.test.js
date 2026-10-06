#!/usr/bin/env node

/**
 * Interactive clarification tools (`ask_user`, anything `requiresUserInput`)
 * survive a chat's `enabledTools` narrowing in `getToolsForApp`.
 *
 * They are a system channel the agent loop drives to pause a turn and ask the
 * user a question — not a user-selectable capability. An app that grants one in
 * `app.tools` must keep it whatever the per-chat toggle (or a stale saved
 * selection that predates the tool) says, or the model loses its only way to
 * ask and the interview loops instead of pausing. These tests pin that: the
 * narrowing still removes ordinary tools, and never the interactive one, while
 * an app that does not grant it never has it injected.
 *
 * Run: node --test server/tests/toolLoader-interactive-tools.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import configCache from '../configCache.js';
import mcpClientManager from '../services/mcp/McpClientManager.js';
import a2aClientManager from '../services/a2a/A2aClientManager.js';
import { getToolsForApp } from '../toolLoader.js';

const askUser = {
  id: 'ask_user',
  requiresUserInput: true,
  name: { en: 'Ask User for Clarification' },
  description: { en: 'Ask the user a clarifying question.' },
  parameters: { type: 'object', properties: {}, required: [] }
};
const customInteractive = {
  id: 'custom_prompt',
  requiresUserInput: true,
  name: { en: 'Custom Prompt' },
  description: { en: 'Another interactive tool.' },
  parameters: { type: 'object', properties: {}, required: [] }
};
const braveSearch = {
  id: 'braveSearch',
  name: { en: 'Brave Search' },
  description: { en: 'Search the web.' },
  parameters: { type: 'object', properties: {}, required: [] }
};

let tools = [];
configCache.getTools = () => ({ data: tools });
configCache.getPlatform = () => ({ defaultLanguage: 'en' });
configCache.getSources = () => ({ data: [] });
// Keep the skills branch out of the way so the offered ids are exactly the
// configured tools under test.
configCache.getFeatures = () => ({ skills: false });
mcpClientManager.listAllTools = async () => [];
a2aClientManager.listAllTools = async () => [];

const ids = list => list.map(t => t.id).sort();

describe('getToolsForApp keeps interactive tools through enabledTools narrowing', () => {
  beforeEach(() => {
    tools = [askUser, customInteractive, braveSearch];
  });

  it('keeps ask_user when the chat enables no tools at all', async () => {
    const app = { id: 'builder', tools: ['ask_user', 'braveSearch'] };
    const offered = await getToolsForApp(app, 'en', { enabledTools: [] });
    assert.deepEqual(ids(offered), ['ask_user']);
  });

  it('keeps ask_user alongside the ordinary tools the chat does enable', async () => {
    const app = { id: 'builder', tools: ['ask_user', 'braveSearch'] };
    const offered = await getToolsForApp(app, 'en', { enabledTools: ['braveSearch'] });
    assert.deepEqual(ids(offered), ['ask_user', 'braveSearch']);
  });

  it('keeps any requiresUserInput tool the app grants, not only ask_user', async () => {
    const app = { id: 'builder', tools: ['custom_prompt', 'braveSearch'] };
    const offered = await getToolsForApp(app, 'en', { enabledTools: [] });
    assert.deepEqual(ids(offered), ['custom_prompt']);
  });

  it('never injects an interactive tool the app does not grant', async () => {
    const app = { id: 'builder', tools: ['braveSearch'] };
    const offered = await getToolsForApp(app, 'en', { enabledTools: ['braveSearch'] });
    assert.deepEqual(ids(offered), ['braveSearch']);
  });

  it('still removes an ordinary tool the chat did not enable', async () => {
    const app = { id: 'builder', tools: ['ask_user', 'braveSearch'] };
    const offered = await getToolsForApp(app, 'en', { enabledTools: ['ask_user'] });
    assert.deepEqual(ids(offered), ['ask_user']);
  });
});
