// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The web artifact checks read end tags the way the HTML parser does: case
 * does not matter, and an end tag may carry whitespace and junk before `>`
 * (`</script >`, `</script\t\n bar>`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspectWebArtifact } from '../services/documents/webArtifacts/webArtifactTools.js';

const page = (open, close) =>
  `<!DOCTYPE html><html><head><title>t</title></head><body>${open}let a = ;${close}</body></html>`;

describe('web artifact end-tag handling', () => {
  it('compiles an inline script whatever its end tag looks like', () => {
    for (const close of [
      '</script>',
      '</script >',
      '</SCRIPT>',
      '</script\t\n bar>',
      '</script/>'
    ]) {
      const findings = inspectWebArtifact(page('<script>', close), 'html');
      assert.ok(
        findings.some(text => text.includes('does not parse')),
        `syntax error not found with end tag ${JSON.stringify(close)}`
      );
      assert.ok(!findings.some(text => /cut off|truncat/i.test(text)), JSON.stringify(close));
    }
  });

  it('still reports a script that never closes as truncated', () => {
    const findings = inspectWebArtifact('<html><body><script>let a = 1;', 'html');
    assert.ok(
      findings.some(text => /cut off|truncat|incomplete/i.test(text)),
      findings.join('|')
    );
  });

  it('does not take </scripts> for the end of a script', () => {
    const findings = inspectWebArtifact(
      '<html><body><script>let a = 1;</scripts></body></html>',
      'html'
    );
    assert.ok(
      findings.some(text => /cut off|truncat|incomplete/i.test(text)),
      findings.join('|')
    );
  });
});
