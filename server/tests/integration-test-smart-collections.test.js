// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The "iFinder smart collections" step of the iFinder integration test: what
 * it says about the tier policy, an iFinder without the Smart Collections API,
 * a user without the role, and a subject that differs from the owner in case.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/ifinderTierHarness.js';

const ADA = { id: 'user-ada', name: 'Ada', email: 'ada@example.com', groups: ['authenticated'] };
const MIXED = {
  id: 'user-mixed',
  name: 'Mixed',
  email: 'Mixed.Case@Example.com',
  groups: ['authenticated']
};

let harness;
let DiagnosticsReport;
let STATUS;
let runSmartCollectionsStep;

async function run(user, { exchange = false } = {}) {
  const report = new DiagnosticsReport();
  await runSmartCollectionsStep(report, {
    user,
    exchange,
    subject: user.email,
    platformConfig: harness.platform
  });
  return report.steps.find(step => step.id === 'smartCollections');
}

before(async () => {
  harness = await createHarness({ users: [ADA, MIXED] });
  ({ runSmartCollectionsStep } = await import('../routes/admin/integrationTest.js'));
  ({ DiagnosticsReport, STATUS } =
    await import('../services/integrations/integrationDiagnostics.js'));
});

beforeEach(() => harness.reset());

after(async () => {
  await harness.close();
});

describe('iFinder integration test: smart collections step', () => {
  it('is ok when the policy offers the tier and the user owns a collection', async () => {
    harness.collection(1, 'ada@example.com', { name: 'Handbook', documents: ['d1', 'd2'] });
    const step = await run(ADA);
    assert.equal(step.status, STATUS.OK, JSON.stringify(step));
    assert.equal(step.details.collectionCount, 1);
    assert.deepEqual(step.details.collections[0].name, 'Handbook');
    assert.equal(step.details.collections[0].documentCount, 2);
    assert.equal(step.details.scope, 'fi_smartcollections');
  });

  it('warns that the tier policy hides the collections although the API works', async () => {
    harness.setPlatform({ tierPolicy: 'ihub' });
    harness.collection(1, 'ada@example.com');
    const step = await run(ADA);
    assert.equal(step.status, STATUS.WARN);
    assert.match(step.hints.join('\n'), /tier policy is "ihub"/);
  });

  it('warns about an empty list and a subject with capital letters', async () => {
    harness.collection(1, 'mixed.case@example.com');
    const step = await run(MIXED);
    assert.equal(step.status, STATUS.WARN);
    assert.equal(step.details.collectionCount, 0);
    const hints = step.hints.join('\n');
    assert.match(hints, /case-sensitively/);
    assert.match(hints, /owns no smart collection/);
  });

  it('fails with the role hint when the user lacks fi_smartcollections', async () => {
    harness.ifinder.state.collectionsStatus = 403;
    const step = await run(ADA);
    assert.equal(step.status, STATUS.FAIL);
    assert.equal(step.details.error, 'FORBIDDEN');
    assert.match(step.hints.join('\n'), /lacks the "fi_smartcollections" role/);
  });

  it('fails for an iFinder without the API, but only warns while the policy hides the tier', async () => {
    harness.ifinder.state.collectionsStatus = 404;
    const offered = await run(ADA);
    assert.equal(offered.status, STATUS.FAIL);
    assert.equal(offered.details.error, 'UNSUPPORTED');
    assert.match(offered.hints.join('\n'), /6\.8 or later/);

    harness.setPlatform({ tierPolicy: 'ihub' });
    const hidden = await run(ADA);
    assert.equal(hidden.status, STATUS.WARN);
  });

  it('points at the scope map in token exchange mode', async () => {
    harness.ifinder.state.collectionsStatus = 403;
    const step = await run(ADA, { exchange: true });
    assert.match(step.hints.join('\n'), /scope map/);
  });
});
