#!/usr/bin/env node

/**
 * The Outlook manifest's <Id> and <Version>. The Id used to be a constant, so
 * every iHub instance was the same add-in to Outlook (dev could not be
 * installed next to prod), and the constant version made Outlook keep an old
 * manifest after a re-deploy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_OFFICE_ADDIN_ID,
  officeManifestVersion,
  resolveOfficeAddinId
} from '../utils/officeAddinManifest.js';

test('no configured Id keeps the Id already deployed add-ins carry', () => {
  assert.equal(resolveOfficeAddinId(undefined), LEGACY_OFFICE_ADDIN_ID);
  assert.equal(resolveOfficeAddinId({}), LEGACY_OFFICE_ADDIN_ID);
  assert.equal(LEGACY_OFFICE_ADDIN_ID, '4fe644da-8036-47f8-ac9f-e478bcbe5274');
});

test('a configured GUID is used, normalized to lower case', () => {
  assert.equal(
    resolveOfficeAddinId({ addinId: 'A1B2C3D4-0000-4000-8000-00000000000F' }),
    'a1b2c3d4-0000-4000-8000-00000000000f'
  );
});

test('a hand-edited non-GUID never reaches the manifest', () => {
  for (const addinId of ['', 'dev', '4fe644da', '<Id>x</Id>', 42, null]) {
    assert.equal(resolveOfficeAddinId({ addinId }), LEGACY_OFFICE_ADDIN_ID);
  }
});

test('the manifest version follows the iHub release', () => {
  assert.equal(officeManifestVersion('5.5.21'), '5.5.21.0');
  assert.equal(officeManifestVersion('v5.6.0-rc.1'), '5.6.0.0');
  assert.equal(officeManifestVersion('unknown'), '1.1.0.0');
});
