#!/usr/bin/env node

/**
 * Unit test for Office 365 conditional scope building.
 *
 * Verifies _buildScopes() picks the minimum Microsoft Graph scopes needed
 * for the provider's enabled sources, so personal-OneDrive-only setups
 * avoid admin-consent scopes (Files.Read.All, Sites.Read.All, etc.).
 */

import office365Service from '../services/integrations/Office365Service.js';

const ADMIN_CONSENT_SCOPES = [
  'Files.Read.All',
  'Sites.Read.All',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All'
];

let failures = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
  } else {
    console.log(`  ❌ ${message}`);
    failures += 1;
  }
}

function scopeList(provider) {
  return office365Service._buildScopes(provider).split(' ');
}

function hasAdminConsentScope(scopes) {
  return scopes.some(s => ADMIN_CONSENT_SCOPES.includes(s));
}

console.log('\nTest 1: personalDrive only — no admin consent scopes');
{
  const scopes = scopeList({
    sources: { personalDrive: true, followedSites: false, teams: false }
  });
  assert(scopes.includes('User.Read'), 'includes User.Read');
  assert(scopes.includes('offline_access'), 'includes offline_access');
  assert(scopes.includes('Files.Read'), 'includes Files.Read (user-consent)');
  assert(!scopes.includes('Files.Read.All'), 'does NOT include Files.Read.All');
  assert(!hasAdminConsentScope(scopes), 'does NOT include any admin-consent scope');
}

console.log('\nTest 2: personalDrive + followedSites — Sites.Read.All required');
{
  const scopes = scopeList({
    sources: { personalDrive: true, followedSites: true, teams: false }
  });
  assert(scopes.includes('Sites.Read.All'), 'includes Sites.Read.All');
  assert(scopes.includes('Files.Read.All'), 'upgrades to Files.Read.All');
  assert(!scopes.includes('Files.Read'), 'does not also include Files.Read');
  assert(!scopes.includes('Team.ReadBasic.All'), 'does not include Team scope');
}

console.log('\nTest 3: teams enabled — Team and Channel scopes added');
{
  const scopes = scopeList({
    sources: { personalDrive: true, followedSites: false, teams: true }
  });
  assert(scopes.includes('Team.ReadBasic.All'), 'includes Team.ReadBasic.All');
  assert(scopes.includes('Channel.ReadBasic.All'), 'includes Channel.ReadBasic.All');
  assert(scopes.includes('Files.Read.All'), 'upgrades to Files.Read.All');
  assert(!scopes.includes('Sites.Read.All'), 'does not include Sites.Read.All');
}

console.log('\nTest 4: all sources enabled — full scope set');
{
  const scopes = scopeList({
    sources: { personalDrive: true, followedSites: true, teams: true }
  });
  assert(scopes.includes('Files.Read.All'), 'includes Files.Read.All');
  assert(scopes.includes('Sites.Read.All'), 'includes Sites.Read.All');
  assert(scopes.includes('Team.ReadBasic.All'), 'includes Team.ReadBasic.All');
  assert(scopes.includes('Channel.ReadBasic.All'), 'includes Channel.ReadBasic.All');
}

console.log('\nTest 5: sources undefined — backward compatible default (all enabled)');
{
  const scopes = scopeList({});
  assert(scopes.includes('Files.Read.All'), 'includes Files.Read.All by default');
  assert(scopes.includes('Sites.Read.All'), 'includes Sites.Read.All by default');
  assert(scopes.includes('Team.ReadBasic.All'), 'includes Team scope by default');
}

console.log('\nTest 6: all sources disabled — minimal scopes only');
{
  const scopes = scopeList({
    sources: { personalDrive: false, followedSites: false, teams: false }
  });
  assert(scopes.includes('User.Read'), 'still includes User.Read');
  assert(scopes.includes('offline_access'), 'still includes offline_access');
  assert(!scopes.includes('Files.Read'), 'does not include Files.Read');
  assert(!hasAdminConsentScope(scopes), 'does NOT include any admin-consent scope');
}

console.log(`\n${failures === 0 ? '✨ All tests passed!' : `❌ ${failures} assertion(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
