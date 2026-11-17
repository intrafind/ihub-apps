// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `edit_web_artifact`: a fix or a small change to a web artifact is a few
 * exact replacements on the chat's newest version of the file, not the whole
 * file written again.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runCreateWebArtifact,
  runEditWebArtifact
} from '../services/documents/webArtifacts/webArtifactTools.js';
import { applyTextEdits as applyArtifactEdits } from '../services/documents/editableSource.js';
import {
  clearHeldGeneratedFiles,
  heldGeneratedFile,
  holdGeneratedFile
} from '../services/documents/generatedFiles.js';

const user = { id: 'u-edit' };
// Not a stored chat: the edit finds the files held for this turn.
const chatId = 'agent:edit-test';

const PAGE = `<!DOCTYPE html>
<html><head><title>Calc</title></head>
<body>
  <h1>ROI calculator</h1>
  <button id="go">Compute</button>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      const rate = 0.05;
      alert(rate * 100);
    });
  </script>
</body></html>`;

async function create(content = PAGE, filename = 'roi.html') {
  const res = await runCreateWebArtifact({ filename, content, user, chatId });
  assert.equal(res.success, true, res.error);
  return res;
}

function textOf(res) {
  return heldGeneratedFile(user, res.file.id, { chatId }).data.toString('utf8');
}

afterEach(() => clearHeldGeneratedFiles());

describe('applyArtifactEdits', () => {
  it('replaces each unique text in order, the later ones on the result of the earlier', () => {
    assert.equal(
      applyArtifactEdits('a-b-c', [
        { oldText: 'b', newText: 'B' },
        { oldText: 'B-c', newText: 'X' }
      ]),
      'a-X'
    );
  });

  it('deletes with an empty newText and takes "$" in newText literally', () => {
    assert.equal(applyArtifactEdits('keep drop', [{ oldText: ' drop', newText: '' }]), 'keep');
    assert.equal(applyArtifactEdits('x', [{ oldText: 'x', newText: "$&$'$1" }]), "$&$'$1");
  });

  it('refuses text that is missing or not unique, naming the edit', () => {
    assert.throws(
      () => applyArtifactEdits('abc', [{ oldText: 'zz', newText: 'y' }]),
      /edits\[0\]\.oldText does not occur.*chat_artifacts_read/
    );
    assert.throws(
      () =>
        applyArtifactEdits('aa', [
          { oldText: 'a', newText: 'b' } // two matches
        ]),
      /edits\[0\]\.oldText occurs 2 times/
    );
    assert.throws(
      () =>
        applyArtifactEdits('abc', [
          { oldText: 'a', newText: 'x' },
          { oldText: 'a', newText: 'y' } // gone after the first edit
        ]),
      /edits\[1\]\.oldText does not occur in the current file \(after the edits before it\)/
    );
  });
});

describe('runEditWebArtifact', () => {
  it('updates the newest version of the file under the same name', async () => {
    const first = await create();
    const res = await runEditWebArtifact({
      filename: 'roi.html',
      edits: [{ oldText: 'const rate = 0.05;', newText: 'const rate = 0.07;' }],
      user,
      chatId
    });
    assert.equal(res.success, true, res.error);
    assert.equal(res.edited, 1);
    assert.equal(res.file.name, 'roi.html');
    assert.notEqual(res.file.id, first.file.id);
    assert.match(textOf(res), /const rate = 0\.07;/);
    assert.match(textOf(res), /<h1>ROI calculator<\/h1>/);
    // Brand tokens are not injected twice.
    assert.equal(textOf(res).match(/id="ihub-brand-tokens"/g).length, 1);
    // The earlier version is untouched.
    assert.match(textOf(first), /const rate = 0\.05;/);
    assert.match(res.message, /^Updated the interactive HTML artifact "roi\.html"/);

    // A second edit builds on the first, not on the original.
    const again = await runEditWebArtifact({
      filename: 'roi.html',
      edits: JSON.stringify([{ oldText: 'rate * 100', newText: 'rate * 1000' }]),
      user,
      chatId
    });
    assert.equal(again.success, true, again.error);
    assert.match(textOf(again), /const rate = 0\.07;[\s\S]*rate \* 1000/);
  });

  it('fixes a problem create_web_artifact reported, and the check runs again', async () => {
    const broken = await create(PAGE.replace('const rate = 0.05;', 'const rate = ;'));
    assert.equal(broken.warnings.length, 1);
    assert.match(broken.message, /edit_web_artifact/);
    const fixed = await runEditWebArtifact({
      filename: 'roi.html',
      edits: [{ oldText: 'const rate = ;', newText: 'const rate = 0.05;' }],
      user,
      chatId
    });
    assert.equal(fixed.success, true, fixed.error);
    assert.equal(fixed.warnings, undefined);

    // An edit that breaks the script is reported like a broken new file.
    const rebroken = await runEditWebArtifact({
      filename: 'roi.html',
      edits: [{ oldText: 'alert(rate * 100);', newText: 'alert(rate * 100;' }],
      user,
      chatId
    });
    assert.equal(rebroken.success, true);
    assert.equal(rebroken.warnings.length, 1);
    assert.match(rebroken.message, /Do NOT answer yet/);
  });

  it('applies all edits or none', async () => {
    await create();
    const res = await runEditWebArtifact({
      filename: 'roi.html',
      edits: [
        { oldText: 'Compute', newText: 'Berechnen' },
        { oldText: 'not in the file', newText: 'x' }
      ],
      user,
      chatId
    });
    assert.equal(res.success, false);
    assert.match(res.error, /edits\[1\]/);
    assert.match(res.error, /No edit was applied/);
  });

  it('finds the file by id as well as by name', async () => {
    const first = await create();
    const res = await runEditWebArtifact({
      filename: first.file.id,
      edits: [{ oldText: 'Compute', newText: 'Run' }],
      user,
      chatId
    });
    assert.equal(res.success, true, res.error);
    assert.match(textOf(res), />Run</);
  });

  it('says which files the chat has when the name is unknown', async () => {
    await create();
    const res = await runEditWebArtifact({
      filename: 'other.html',
      edits: [{ oldText: 'a', newText: 'b' }],
      user,
      chatId
    });
    assert.equal(res.success, false);
    assert.match(res.error, /Not found in this chat: "other\.html".*"roi\.html"/);
  });

  it('does not reach another user’s files of the same chat', async () => {
    await create();
    const res = await runEditWebArtifact({
      filename: 'roi.html',
      edits: [{ oldText: 'Compute', newText: 'Run' }],
      user: { id: 'someone-else' },
      chatId
    });
    assert.equal(res.success, false);
    assert.match(res.error, /Not found in this chat/);
  });

  it('refuses malformed edits, edits that change nothing and files that are not web artifacts', async () => {
    await create();
    const call = edits => runEditWebArtifact({ filename: 'roi.html', edits, user, chatId });
    assert.match((await call([])).error, /non-empty list/);
    assert.match((await call([{ oldText: '', newText: 'x' }])).error, /edits\[0\] needs "oldText"/);
    assert.match((await call('not json')).error, /"edits" must be/);
    assert.match(
      (await call([{ oldText: 'Compute', newText: 'Compute' }])).error,
      /change nothing/
    );
    const missingName = await runEditWebArtifact({
      edits: [{ oldText: 'a', newText: 'b' }],
      user,
      chatId
    });
    assert.match(missingName.error, /Name the file to change/);

    holdGeneratedFile({
      user,
      chatId,
      data: Buffer.from('# Notes\n'),
      mimeType: 'text/markdown',
      name: 'notes.md'
    });
    const notWeb = await runEditWebArtifact({
      filename: 'notes.md',
      edits: [{ oldText: 'Notes', newText: 'Todo' }],
      user,
      chatId
    });
    assert.match(notWeb.error, /"notes\.md" is not a web artifact/);
  });

  it('edits an SVG and keeps it an SVG', async () => {
    await create(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect fill="red" width="10" height="10"/></svg>',
      'box.svg'
    );
    const res = await runEditWebArtifact({
      filename: 'box.svg',
      edits: [{ oldText: 'fill="red"', newText: 'fill="blue"' }],
      user,
      chatId
    });
    assert.equal(res.success, true, res.error);
    assert.equal(res.file.name, 'box.svg');
    assert.match(textOf(res), /fill="blue"/);
    assert.doesNotMatch(textOf(res), /ihub-brand-tokens/);
  });
});
