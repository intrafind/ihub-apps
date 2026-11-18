// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `if-skill` blocks in the instructions of a system skill and the log of the
 * skills a turn loaded.
 *
 * Run: node --test server/tests/skill-text.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSkillText } from '../utils/skillText.js';
import { createTurnSkillLog } from '../services/chat/turnSkillLog.js';

const text = [
  'Before.',
  '',
  '<!-- if-skill dashboard -->',
  '',
  'Use the dashboard skill.',
  '',
  '<!-- else -->',
  '',
  'Write the HTML yourself.',
  '',
  '<!-- /if-skill -->',
  '',
  'After.'
].join('\n');

describe('resolveSkillText', () => {
  it('keeps the first part when the skill is offered, and drops the else part', () => {
    assert.equal(
      resolveSkillText(text, ['dashboard']),
      'Before.\n\nUse the dashboard skill.\n\nAfter.'
    );
    assert.equal(
      resolveSkillText(text, new Set(['dashboard', 'pdf'])),
      'Before.\n\nUse the dashboard skill.\n\nAfter.'
    );
  });

  it('keeps the else part when it is not, or when nothing is known', () => {
    const alone = 'Before.\n\nWrite the HTML yourself.\n\nAfter.';
    assert.equal(resolveSkillText(text, ['pdf']), alone);
    assert.equal(resolveSkillText(text, []), alone);
    assert.equal(resolveSkillText(text), alone);
  });

  it('removes a block without an else part and the gap it leaves', () => {
    const only = 'A.\n\n<!-- if-skill dashboard -->\n\nPointer.\n\n<!-- /if-skill -->\n\nB.';
    assert.equal(resolveSkillText(only, ['dashboard']), 'A.\n\nPointer.\n\nB.');
    assert.equal(resolveSkillText(only, []), 'A.\n\nB.');
  });

  it('works inside a line, and for several blocks', () => {
    const inline =
      'Use <!-- if-skill a -->A<!-- else -->plain<!-- /if-skill --> and <!-- if-skill b -->B<!-- /if-skill -->.';
    assert.equal(resolveSkillText(inline, ['a', 'b']), 'Use A and B.');
    assert.equal(resolveSkillText(inline, ['b']), 'Use plain and B.');
    assert.equal(resolveSkillText(inline, []), 'Use plain and .');
  });

  it('leaves a text without blocks exactly as it is, blank lines included', () => {
    const plain = 'One.\n\n\n\nTwo.';
    assert.equal(resolveSkillText(plain, ['dashboard']), plain);
    assert.equal(resolveSkillText('', []), '');
    assert.equal(resolveSkillText(undefined, []), '');
  });

  it('leaves other comments and a block with an unknown shape alone', () => {
    const other = '<!-- a note -->\n<!-- if-skill Dashboard -->x<!-- /if-skill -->';
    assert.equal(resolveSkillText(other, ['Dashboard']), other);
  });
});

describe('createTurnSkillLog', () => {
  it('knows what was noted in this turn and nothing else', () => {
    const log = createTurnSkillLog();
    assert.equal(log.has('dashboard'), false);
    log.note('dashboard');
    log.note('');
    log.note(undefined);
    assert.equal(log.has('dashboard'), true);
    assert.equal(log.has('pdf'), false);
    assert.equal(createTurnSkillLog().has('dashboard'), false, 'a new turn starts empty');
  });
});
