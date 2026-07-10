// Plain-node test (node server/tests/promptTemplateEngine.test.js).
//
// Extracted from PromptNodeExecutor (#1775) as part of shrinking the god-class:
// this Handlebars-subset engine used to be three private methods on the
// executor with no dedicated test — coverage was only indirect via the
// agent-*.test.js integration tests. These cover the engine's own syntax
// (each/if/compare/this/@index) plus the PromptNodeExecutor-specific hooks
// (previousTaskResults/citations/$.path) it now takes via `deps` instead of
// reading off `this`.
import {
  getNestedValue,
  processEachBlocks,
  resolveTemplateVariables
} from '../services/workflow/executors/promptTemplateEngine.js';

let failures = 0;
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && detail) console.log('   ' + detail);
}

// ---- getNestedValue ----
check('simple path', getNestedValue('a.b', { a: { b: 1 } }) === 1);
check('missing path → undefined', getNestedValue('a.x', { a: { b: 1 } }) === undefined);
check('null intermediate → undefined', getNestedValue('a.b.c', { a: null }) === undefined);
check('array index path', getNestedValue('items.1', { items: ['x', 'y'] }) === 'y');

// ---- resolveTemplateVariables: plain variables ----
{
  const state = { data: { name: 'Ada', nested: { count: 3 } } };
  check('simple {{variable}}', resolveTemplateVariables('Hi {{name}}', state) === 'Hi Ada');
  check('nested {{path.to.value}}', resolveTemplateVariables('{{nested.count}}', state) === '3');
  check('unresolved variable → empty', resolveTemplateVariables('{{missing}}', state) === '');
  check(
    'object value → JSON string',
    resolveTemplateVariables('{{nested}}', state) === JSON.stringify(state.data.nested)
  );
}

// ---- {{#if}} blocks ----
{
  const truthy = { data: { flag: true } };
  const falsy = { data: { flag: false } };
  check(
    '{{#if}} true renders content',
    resolveTemplateVariables('{{#if flag}}yes{{/if}}', truthy) === 'yes'
  );
  check(
    '{{#if}} false renders empty',
    resolveTemplateVariables('{{#if flag}}yes{{/if}}', falsy) === ''
  );
}

// ---- {{#compare}} blocks ----
{
  const state = { data: { a: 5, b: 10 } };
  check(
    '{{#compare}} numeric <',
    resolveTemplateVariables('{{#compare a "<" b}}less{{/compare}}', state) === 'less'
  );
  check(
    '{{#compare}} numeric >',
    resolveTemplateVariables('{{#compare a ">" b}}more{{/compare}}', state) === ''
  );
  check(
    '{{#compare}} literal operands',
    resolveTemplateVariables('{{#compare 1 "<" 2}}yes{{/compare}}', { data: {} }) === 'yes'
  );
}

// ---- {{#each}} blocks (via processEachBlocks + resolveTemplateVariables) ----
{
  const state = { data: { items: [{ name: 'a' }, { name: 'b' }] } };
  check(
    'processEachBlocks renders {{this.property}} and {{@index}}',
    processEachBlocks('{{#each items}}[{{@index}}:{{this.name}}]{{/each}}', state) === '[0:a][1:b]'
  );
  check(
    'empty array → empty output',
    processEachBlocks('{{#each items}}x{{/each}}', { data: { items: [] } }) === ''
  );
  check(
    // Inner {{#each}} resolves its array path against state.data (not the
    // outer loop's `item`), so a nested {{#each items}} re-iterates the same
    // top-level array on every outer pass rather than scoping into `this`.
    'nested each blocks each re-resolve against state.data',
    processEachBlocks('{{#each items}}{{#each items}}{{this.name}}{{/each}}|{{/each}}', state) ===
      'aa|bb|'
  );
  check(
    'resolveTemplateVariables composes each + plain substitution',
    resolveTemplateVariables('{{#each items}}{{this.name}} {{/each}}', state) === 'a b '
  );
}

// ---- deps hooks: previousTaskResults / citations / resolveVariables ----
{
  const calls = [];
  const deps = {
    formatPreviousTaskResults: (_state, opts) => {
      calls.push(['previousTaskResults', opts]);
      return 'PTR';
    },
    formatCitations: () => {
      calls.push(['citations']);
      return 'CITES';
    },
    resolveVariables: value => `${value}+resolved`
  };
  const out = resolveTemplateVariables(
    '{{previousTaskResults}} {{citations}}',
    { data: {} },
    { previousTaskResults: { maxResults: 1 } },
    deps
  );
  check('previousTaskResults hook invoked with opts', calls[0][0] === 'previousTaskResults');
  check('previousTaskResults opts forwarded', calls[0][1]?.maxResults === 1);
  check(
    'citations hook invoked',
    calls.some(c => c[0] === 'citations')
  );
  check('hook outputs substituted', out.startsWith('PTR CITES'));
  check('resolveVariables hook runs last (final $.path pass)', out.endsWith('+resolved'));
}

// ---- deps optional: missing hooks degrade gracefully instead of throwing ----
{
  check(
    'no deps: previousTaskResults placeholder → empty, no throw',
    resolveTemplateVariables('{{previousTaskResults}}', { data: {} }) === ''
  );
  check(
    'no deps: citations placeholder → empty, no throw',
    resolveTemplateVariables('{{citations}}', { data: {} }) === ''
  );
  check(
    'no deps: $.path pass-through unresolved (no resolveVariables hook)',
    resolveTemplateVariables('literal text', { data: {} }) === 'literal text'
  );
}

// ---- currentInboxItem special-case (handled inline, no dep needed) ----
{
  check(
    'currentInboxItem string form',
    resolveTemplateVariables('{{currentInboxItem}}', {
      data: { currentInboxItem: 'Do the thing' }
    }) === 'Do the thing'
  );
  check(
    'currentInboxItem object form with priority',
    resolveTemplateVariables('{{currentInboxItem}}', {
      data: { currentInboxItem: { text: 'Ship it', priority: 'p1' } }
    }) === '(P1) Ship it'
  );
  check(
    'currentInboxItem unprioritized omits the tag',
    resolveTemplateVariables('{{currentInboxItem}}', {
      data: { currentInboxItem: { text: 'Ship it', priority: 'unprioritized' } }
    }) === 'Ship it'
  );
}

// ---- logger dep: warns on malformed {{#each}} without throwing ----
{
  const warnings = [];
  const deps = { logger: { warn: (msg, meta) => warnings.push({ msg, meta }) } };
  const out = processEachBlocks('{{#each items}}unterminated', { data: { items: [1] } }, deps);
  check('malformed each logs a warning', warnings.length === 1, JSON.stringify(warnings));
  check('malformed each leaves template unresolved rather than throwing', out.includes('{{#each'));
}

console.log(`\n${failures === 0 ? '✅ all passed' : `❌ ${failures} failed`}`);
process.exit(failures ? 1 : 0);
