// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Provenance on the MCP channel (#3327): `_meta.provenance` on app and workflow
 * tool results, none on errors; and the run contracts keep `provenance` on
 * `run/ended`, so a replay of the ledger carries what the live stream did.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appToolResult, workflowToolResult } from '../services/mcp/McpServerService.js';
import { buildProvenance, newOutputId } from '../services/provenance/records.js';
import { runEndedData } from '../services/loop/contracts/sseV2.js';
import { runEndData } from '../services/loop/contracts/runLogEvents.js';
import { projectLedgerEvent } from '../services/loop/RunStream.js';

const provenance = buildProvenance({
  outputId: newOutputId(),
  text: 'answer',
  model: { id: 'm' },
  installationId: 'inst_t',
  version: '1.0.0'
});

describe('MCP results', () => {
  it('put the provenance object in _meta.provenance for an app run', () => {
    const result = appToolResult('answer', { generatedFiles: [], images: [], provenance });
    assert.deepEqual(result._meta, { provenance });
    assert.equal(result.content[0].text, 'answer');
  });

  it('leave _meta out when there is no provenance', () => {
    assert.equal('_meta' in appToolResult('answer', { generatedFiles: [], images: [] }), false);
    assert.equal('_meta' in appToolResult('answer'), false);
  });

  it('put it on a workflow result, and none on an error result', () => {
    const ok = workflowToolResult({ status: 'completed', output: 'done' }, provenance);
    assert.deepEqual(ok._meta, { provenance });
    const failed = workflowToolResult({ status: 'failed' }, provenance);
    assert.equal(failed.isError, true);
    assert.equal('_meta' in failed, false);
  });
});

describe('run contracts', () => {
  it('keep provenance on run/ended and in the ledger run/end event', () => {
    assert.deepEqual(
      runEndedData.parse({ status: 'completed', finishReason: 'stop', provenance }).provenance,
      provenance
    );
    assert.deepEqual(
      runEndData.parse({ status: 'completed', finishReason: 'stop', provenance }).provenance,
      provenance
    );
  });

  it('projects the ledger run/end event back onto run/ended with the provenance', () => {
    const envelopes = projectLedgerEvent({
      seq: 7,
      ts: Date.now(),
      runId: 'run-1',
      type: 'run/end',
      data: { status: 'completed', finishReason: 'stop', provenance }
    });
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].type, 'run/ended');
    assert.deepEqual(envelopes[0].data.provenance, provenance);
  });
});
