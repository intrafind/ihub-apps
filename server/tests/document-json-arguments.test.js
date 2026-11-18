// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Structured document-tool arguments sent as JSON text (intrafind/ihub-apps#3831):
 * closing brackets the model left out are closed, any other broken JSON is
 * refused with where it breaks and what was expected there.
 *
 * Run: node --test server/tests/document-json-arguments.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  closeMissingBrackets,
  describeJsonError,
  parseJsonArgument,
  JsonArgumentError
} from '../services/documents/jsonArgument.js';
import { parseStructured } from '../services/documents/documentToolHelpers.js';
import { runCreateXlsx, xlsxSpecFromToolArgs } from '../services/documents/xlsx/xlsxTools.js';
import { pptxSpecFromToolArgs } from '../services/documents/pptx/pptxTools.js';
import { specFromToolArgs as pdfSpecFromToolArgs } from '../services/documents/pdf/pdfTools.js';
import { prepareDashboard } from '../services/documents/webArtifacts/dashboardPreset.js';
import { sourceViewOf } from '../services/documents/editableSource.js';
import { clearHeldGeneratedFiles } from '../services/documents/generatedFiles.js';

const SHEETS = [
  {
    name: 'Shares',
    columns: ['Model', { header: 'Share', format: 'percent' }],
    rows: [
      ['Model A', 0.31],
      ['Model B', 0.45],
      ['Model C', 0.6]
    ]
  }
];
const VALID = JSON.stringify(SHEETS);
// The outer sheets array not closed: `…0.6]]}`.
const OUTER_OPEN = VALID.slice(0, -1);
// The rows array not closed: `…0.6]}]`.
const ROWS_OPEN = VALID.replace(']]}]', ']}]');

describe('closeMissingBrackets', () => {
  it('closes brackets left open at the end, in nesting order', () => {
    assert.deepEqual(closeMissingBrackets('[{"a":[1,2'), { text: '[{"a":[1,2]}]', closed: 3 });
    assert.deepEqual(closeMissingBrackets('[[1],[2]  \n'), { text: '[[1],[2]]', closed: 1 });
  });

  it('closes a container before the bracket of the one around it', () => {
    assert.equal(closeMissingBrackets(ROWS_OPEN).text, VALID);
    assert.equal(closeMissingBrackets('[{"a":{"b":1}]').text, '[{"a":{"b":1}}]');
  });

  it('leaves alone what closing brackets cannot fix', () => {
    assert.equal(closeMissingBrackets(VALID), null, 'nothing to close');
    assert.equal(closeMissingBrackets('[{"a":1}}]'), null, 'one bracket too many');
    assert.equal(closeMissingBrackets('[{"a":"x'), null, 'open string');
    // An array directly in an array could have ended after any element.
    assert.equal(closeMissingBrackets('{"r":[[1],[2],[3]}').text, '{"r":[[1],[2],[3]]}');
    assert.equal(closeMissingBrackets('[[[1],[2],[3]]}'), null);
    assert.equal(closeMissingBrackets('[[1,2],[3,4]}'), null);
  });

  it('ignores brackets inside strings', () => {
    assert.deepEqual(closeMissingBrackets('[{"a":"]}"'), { text: '[{"a":"]}"}]', closed: 2 });
  });
});

describe('parseJsonArgument', () => {
  it('parses valid JSON as it is', () => {
    assert.deepEqual(parseJsonArgument(VALID), { value: SHEETS, closed: 0 });
  });

  it('repairs the two cases from the live run', () => {
    assert.deepEqual(parseJsonArgument(OUTER_OPEN), { value: SHEETS, closed: 1 });
    assert.deepEqual(parseJsonArgument(ROWS_OPEN), { value: SHEETS, closed: 1 });
  });

  it('refuses other damage with the position, what was expected and what was found', () => {
    const text = VALID.replace('["Model B",0.45]', '["Model B",,0.45]');
    let error;
    try {
      parseJsonArgument(text, 'sheets');
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof JsonArgumentError);
    const position = text.indexOf(',,') + 2;
    assert.equal(error.position, position);
    assert.equal(error.expected, 'a value');
    assert.equal(error.found, '","');
    assert.equal(error.path, 'sheets[0].rows[1][1]');
    assert.match(
      error.message,
      new RegExp(`^expected a value at character ${position} of ${text.length}, but found ","`)
    );
    assert.match(error.message, /after: …?.*\["Model B",$/);
  });

  it('names the container whose bracket is missing when it cannot be closed', () => {
    const { message } = describeJsonError('{"rows":[[1],[2],[3]', 'sheets');
    assert.match(message, /expected "," or "]" at the end \(character 21\)/);
    assert.match(message, /The array sheets\.rows \(opened at character 9\) is not closed/);
    assert.throws(
      () => parseJsonArgument('[[[1],[2],[3]]}', 'x'),
      /"}" matches no bracket open here/
    );
  });

  it('formats long positions for reading', () => {
    const long = `[${'1,'.repeat(3000)}x]`;
    assert.throws(() => parseJsonArgument(long), /at character 6,002 of 6,003/);
  });
});

describe('document tools', () => {
  it('create_xlsx: sheets with missing closing brackets build the workbook', async () => {
    assert.deepEqual(xlsxSpecFromToolArgs({ sheets: OUTER_OPEN }).sheets, SHEETS);
    assert.deepEqual(xlsxSpecFromToolArgs({ sheets: ROWS_OPEN }).sheets, SHEETS);

    clearHeldGeneratedFiles();
    const res = await runCreateXlsx({
      filename: 'shares',
      sheets: OUTER_OPEN,
      user: { id: 'u-json' },
      chatId: 'chat-json'
    });
    assert.equal(res.success, true, res.error);
    assert.equal(res.file.name, 'shares.xlsx');
    assert.equal(res.file.sheets, 1);
  });

  it('create_xlsx: other broken JSON says where and what, and nothing is made', async () => {
    const broken = VALID.replace('"Model C",0.6', '"Model C" 0.6');
    const res = await runCreateXlsx({
      filename: 'shares',
      sheets: broken,
      user: { id: 'u-json' },
      chatId: 'chat-json'
    });
    assert.equal(res.success, false);
    assert.equal(res.code, 'invalid');
    assert.match(
      res.error,
      /^"sheets" must be a JSON array of worksheets \(or its JSON\), and this JSON is not valid: expected "," or "]" at character \d+ of \d+, but found "0"/
    );
    assert.match(res.error, /Nothing was created; send the call again with that spot fixed\.$/);
  });

  it('create_pptx: slides with a missing closing bracket are read, other damage is located', () => {
    const slides = [{ title: 'One', bullets: ['a', 'b'] }];
    const text = JSON.stringify(slides);
    assert.deepEqual(pptxSpecFromToolArgs({ slides: text.slice(0, -2) }).slides, slides);
    assert.throws(
      () => pptxSpecFromToolArgs({ slides: text.replace('"a"', "'a'") }),
      /"slides" must be a JSON array of slides \(or its JSON\), and this JSON is not valid: expected a value at character \d+/
    );
  });

  it('create_pdf: blocks with a missing closing bracket are read', () => {
    const blocks = [{ type: 'heading', text: 'Title' }];
    assert.deepEqual(
      pdfSpecFromToolArgs({ blocks: JSON.stringify(blocks).slice(0, -1) }).blocks,
      blocks
    );
  });

  it('parseStructured passes values through and leaves empty arguments out', () => {
    assert.deepEqual(parseStructured(SHEETS, 'sheets', 'x'), SHEETS);
    assert.equal(parseStructured('', 'sheets', 'x'), undefined);
  });

  it('create_dashboard: broken data is located', () => {
    assert.throws(
      () => prepareDashboard('{"title": "T" "asOf": "2026-01-01"}'),
      /Invalid dashboard "data": it is not valid JSON: expected "," or "}" at character 15/
    );
  });

  it('the source view of a file made from repaired JSON reads it the same way', () => {
    const view = sourceViewOf({ tool: 'create_xlsx', args: { sheets: OUTER_OPEN } });
    assert.deepEqual(JSON.parse(view.text), SHEETS);
  });
});
