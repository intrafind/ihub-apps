#!/usr/bin/env node

import office365Router from '../routes/integrations/office365.js';

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`✅ ${label}`);
    return;
  }

  failures += 1;
  console.log(`❌ ${label}`);
}

const getRoutes = office365Router.stack
  .filter(layer => layer.route?.methods?.get)
  .map(layer => layer.route.path);

console.log('🧪 Office 365 callback route registration\n');

check(
  'provider-specific callback route is registered',
  getRoutes.includes('/:providerId/callback')
);
check('legacy callback route is removed', !getRoutes.includes('/callback'));

if (failures > 0) {
  console.error(`\n❌ ${failures} Office 365 callback route check(s) failed`);
  process.exit(1);
}

console.log('\n🎉 All Office 365 callback route checks passed');
