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

  {
    // `9/3/2026` is 3 September under en-US and 9 March to anyone reading a
    // German conversation — a model cannot tell which, and a six-month-wrong
    // "today" looks exactly like a correct answer. A named month cannot be
    // misread whichever locale renders it.
    setPlatform('The current date is {{date}} ({{date_iso}}).');
    for (const lang of ['en', 'de']) {
      const vars = PromptService.resolveGlobalPromptVariables(null, null, lang, null);
      check(
        `${lang}: injected date names the month`,
        /[A-Za-zÄÖÜäöü]{3,}/.test(vars.date),
        vars.date
      );
      check(
        `${lang}: injected date is not a bare numeric date`,
        !/^\d{1,2}[./]\d{1,2}[./]\d{4}$/.test(vars.date.trim()),
        vars.date
      );
      check(
        `${lang}: date_iso is ISO-8601`,
        /^\d{4}-\d{2}-\d{2}$/.test(vars.date_iso),
        vars.date_iso
      );
    }

    const tokyo = PromptService.resolveGlobalPromptVariables(
      { timezone: 'Asia/Tokyo' },
      null,
      'en',
      null
    );
    check(
      'date_iso resolves in the user timezone',
      /^\d{4}-\d{2}-\d{2}$/.test(tokyo.date_iso),
      tokyo.date_iso
    );
    check('timezone is carried through', tokyo.timezone === 'Asia/Tokyo', tokyo.timezone);
  }

  {
    setPlatform(CONTEXT);
    const system = await systemPromptFor({ system: { en: 'You search the web.' } });
    const MONTHS =
      /January|February|March|April|May|June|July|August|September|October|November|December|Januar|Februar|März|Mai|Juni|Juli|Oktober|Dezember/;
    check(
      'system prompt carries a named month end to end',
      MONTHS.test(system),
      system.slice(0, 160)
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
