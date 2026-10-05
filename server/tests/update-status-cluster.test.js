/**
 * Which worker's update state a status poll shows (updateService.pickUpdateState).
 *
 * An update runs on the worker that received the admin's request, and each
 * worker keeps its own state; the poll can land on any of them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickUpdateState } from '../services/updateService.js';

const neverRan = { status: 'idle', progress: 0, message: '' };

describe('pickUpdateState', () => {
  it('shows a download running on another worker over this worker’s old failure', () => {
    const oldFailure = { status: 'error', error: 'checksum mismatch', updatedAt: 1_000 };
    const running = { status: 'downloading', progress: 40, updatedAt: 900 };
    assert.equal(pickUpdateState([oldFailure, neverRan, running]), running);
  });

  it('shows a later success elsewhere over an earlier failure', () => {
    const failed = { status: 'error', error: 'network', updatedAt: 1_000 };
    const staged = { status: 'idle', progress: 100, stagedVersion: '5.1.0', updatedAt: 2_000 };
    assert.equal(pickUpdateState([neverRan, failed, staged]), staged);
  });

  it('shows a failure newer than every other outcome', () => {
    const staged = { status: 'idle', progress: 100, updatedAt: 1_000 };
    const failed = { status: 'error', error: 'apply failed', updatedAt: 2_000 };
    assert.equal(pickUpdateState([staged, failed]), failed);
  });

  it('keeps the first (local) state when no worker has run anything', () => {
    const local = { ...neverRan };
    assert.equal(pickUpdateState([local, { ...neverRan }, undefined]), local);
  });

  it('answers undefined when there is nothing to choose from', () => {
    assert.equal(pickUpdateState([undefined, null]), undefined);
  });
});
