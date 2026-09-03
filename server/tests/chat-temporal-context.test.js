#!/usr/bin/env node

/**
 * Unit tests for temporal-context injection into CHAT system prompts.
 *
 * Workflow nodes have been temporally grounded for a while
 * (BaseNodeExecutor.buildTemporalContextBlock), but the chat path only ever
 * exposed the date as a {{date}} / {{platform_context}} template placeholder.
 * No shipped app referenced either, so chat models - including the
 * websearch-enabled ones, where "latest"/"today"/"recent" is the whole point -
 * had NO notion of today and fell back to training-era dates.
 *
 * These tests lock in:
 *   - the resolved platform context is prepended when the app does not place it
 *   - an app that positions {{platform_context}} itself is not double-injected
 *   - an app using a bare {{date}} placeholder is likewise left alone
 *   - clearing platform.globalPromptVariables.context disables injection
 *   - the injected block carries the real current year
 *
 * Run directly: `node server/tests/chat-temporal-context.test.js`.
 */

import configCache from '../configCache.js';
import PromptService from '../services/PromptService.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

const YEAR = String(new Date().getFullYear());
const CONTEXT = 'The current date is {{date}}. Timezone {{timezone}}.';

function setPlatform(context) {
  Object.assign(configCache, {
    getPlatform: () => ({
      defaultLanguage: 'en',
      globalPromptVariables: context === null ? {} : { context, variables: {} }
    })
  });
}

async function systemPromptFor(app) {
  const messages = [{ role: 'user', content: 'What happened this week?', variables: {} }];
  const result = await PromptService.processMessageTemplates(
    messages,
    app,
    null,
    null,
    'en',
    null,
    null,
    null,
    null,
    null
  );
  const system = result.find(m => m.role === 'system');
  return system ? system.content : '';
}

async function run() {
  console.log('🧪 Chat temporal context\n');

  setPlatform(CONTEXT);

  {
    const system = await systemPromptFor({ system: { en: 'You are a websearch assistant.' } });
    check(
      'date is injected when the app does not place it',
      system.includes('current date is'),
      system
    );
    check('injected date carries the real current year', system.includes(YEAR), system);
    check('app instructions are preserved', system.includes('websearch assistant'), system);
    check(
      'temporal block comes first so the model reads it before instructions',
      system.indexOf('current date is') < system.indexOf('websearch assistant'),
      system
    );
    check('no unresolved placeholder leaks', !system.includes('{{date}}'), system);
  }

  {
    const system = await systemPromptFor({
      system: { en: 'Prefix: {{platform_context}} You are a bot.' }
    });
    const occurrences = system.split('current date is').length - 1;
    check('an app placing {{platform_context}} is not double-injected', occurrences === 1, system);
  }

  {
    const system = await systemPromptFor({ system: { en: 'Today is {{date}}. You are a bot.' } });
    const occurrences = system.split(YEAR).length - 1;
    check('an app using a bare {{date}} is not additionally prefixed', occurrences === 1, system);
  }

  {
    setPlatform(null);
    const system = await systemPromptFor({ system: { en: 'You are a bot.' } });
    check(
      'clearing globalPromptVariables.context disables injection',
      system.trim() === 'You are a bot.',
      system
    );
  }

  console.log(
    failures === 0
      ? '\n✅ All chat temporal context tests passed'
      : `\n❌ ${failures} check(s) failed`
  );
  if (failures > 0) process.exit(1);
}

run().catch(error => {
  console.error('❌ Test crashed:', error);
  process.exit(1);
});
