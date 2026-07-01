#!/usr/bin/env node

/**
 * Unit tests for temporal-context injection into workflow node prompts.
 *
 * Workflow executors historically bypassed PromptService's global prompt
 * variables, so the planner, task workers, synthesizer, and verifier had NO
 * notion of "today". That let agents emit training-era dates a tool-using
 * verifier then flagged as "future"/unverifiable, burning whole retry loops
 * (runs wf-exec-4d5952a6 / wf-exec-c9907222). These tests lock in:
 *   - BaseNodeExecutor.applyGlobalPromptVars resolves {{date}}-style placeholders
 *   - BaseNodeExecutor.buildTemporalContextBlock yields a dated preamble
 *   - PromptNodeExecutor (task workers + synthesize) injects the date + resolves
 *     placeholders in system AND user content
 *   - VerifierNodeExecutor prepends the same temporal anchor to its prompts
 *
 * Run directly: `node server/tests/agent-temporal-context.test.js`.
 */

import { BaseNodeExecutor } from '../services/workflow/executors/BaseNodeExecutor.js';
import { PromptNodeExecutor } from '../services/workflow/executors/PromptNodeExecutor.js';
import { VerifierNodeExecutor } from '../services/workflow/executors/VerifierNodeExecutor.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

const YEAR = String(new Date().getFullYear());

async function run() {
  console.log('🧪 BaseNodeExecutor helpers\n');
  {
    const base = new BaseNodeExecutor();

    const out = base.applyGlobalPromptVars('Today is {{date}}; keep {{missing}}', {
      date: '6/30/2026',
      missing: ''
    });
    check('applyGlobalPromptVars replaces resolved vars', out.includes('6/30/2026'), out);
    check(
      'applyGlobalPromptVars leaves empty-valued placeholders untouched',
      out.includes('{{missing}}'),
      out
    );

    const block = base.buildTemporalContextBlock({ language: 'en' });
    check('buildTemporalContextBlock returns a non-empty preamble', !!block && block.length > 0);
    check('buildTemporalContextBlock carries the current year', block.includes(YEAR), block);
  }

  console.log('\n🧪 PromptNodeExecutor.buildMessages (task workers + synthesize)\n');
  {
    const exec = new PromptNodeExecutor();
    const messages = exec.buildMessages(
      {
        system: { en: 'You are a worker. SYS-DATE={{date}}' },
        prompt: { en: 'Answer for {{year}}' }
      },
      { data: {} },
      { language: 'en' }
    );
    const sys = messages.find(m => m.role === 'system');
    const user = messages.find(m => m.role === 'user');

    check('a system message exists', !!sys);
    check(
      'system message carries the current year (date injected)',
      !!sys && sys.content.includes(YEAR),
      sys?.content?.slice(0, 120)
    );
    check(
      'system {{date}} placeholder is resolved (no raw token)',
      !!sys && !sys.content.includes('{{date}}')
    );
    check(
      'user {{year}} placeholder is resolved',
      !!user && !user.content.includes('{{year}}') && user.content.includes(YEAR),
      user?.content
    );
  }

  console.log('\n🧪 PromptNodeExecutor.buildMessages — no system prompt configured\n');
  {
    const exec = new PromptNodeExecutor();
    const messages = exec.buildMessages(
      { prompt: { en: 'bare worker' } },
      { data: {} },
      { language: 'en' }
    );
    const sys = messages.find(m => m.role === 'system');
    check(
      'bare worker still gets a temporal system anchor',
      !!sys && sys.content.includes(YEAR),
      sys?.content
    );
  }

  console.log('\n🧪 VerifierNodeExecutor message builders\n');
  {
    const v = new VerifierNodeExecutor();
    const block = `Current date: 6/30/${YEAR}.`;

    const adv = v.buildAdversarialMessages('criteria', 'output', block);
    check(
      'adversarial system prepends the temporal block',
      adv[0].content.startsWith(block),
      adv[0].content.slice(0, 60)
    );
    check(
      'adversarial keeps its adversarial framing',
      /adversarial verifier/i.test(adv[0].content)
    );

    const qual = v.buildQualityMessages('criteria', 'output', 0.7, block);
    check(
      'quality system prepends the temporal block',
      qual[0].content.startsWith(block),
      qual[0].content.slice(0, 60)
    );

    // Backward-compat: omitting the block must not crash or inject "undefined".
    const advNoBlock = v.buildAdversarialMessages('criteria', 'output');
    check('adversarial without a block is unchanged', !advNoBlock[0].content.includes('undefined'));
  }

  console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
  process.exit(failures ? 1 : 0);
}

run();
