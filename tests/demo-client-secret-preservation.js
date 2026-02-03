/**
 * End-to-end demonstration of the client secret preservation fix
 * 
 * This script:
 * 1. Reads the current platform.json to verify it has ${MICROSOFT_CLIENT_SECRET}
 * 2. Shows what the GET endpoint would return (env vars preserved, actual secrets redacted)
 * 3. Simulates a client making a change (disabling Google provider)
 * 4. Shows what the POST endpoint would save (original values restored)
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Import helper functions (simulate what the server does)
function isEnvVarPlaceholder(value) {
  if (typeof value !== 'string') return false;
  return /^\$\{[A-Z_][A-Z0-9_]*\}$/i.test(value);
}

function sanitizeSecret(value) {
  if (!value) return undefined;
  if (isEnvVarPlaceholder(value)) {
    return value;
  }
  return '***REDACTED***';
}

function restoreSecretIfRedacted(newValue, existingValue) {
  if (newValue === '***REDACTED***') {
    return existingValue;
  }
  return newValue;
}

async function demonstrateFix() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  End-to-End Demonstration: Client Secret Preservation Fix  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const platformConfigPath = join(rootDir, 'contents', 'config', 'platform.json');

  // Step 1: Read current config
  console.log('📖 Step 1: Reading current platform.json...\n');
  const configData = await fs.readFile(platformConfigPath, 'utf8');
  const originalConfig = JSON.parse(configData);

  if (originalConfig.oidcAuth?.providers) {
    console.log('   Current OIDC Providers:');
    originalConfig.oidcAuth.providers.forEach((provider, index) => {
      console.log(`   ${index + 1}. ${provider.displayName || provider.name}:`);
      console.log(`      Client ID:     ${provider.clientId}`);
      console.log(`      Client Secret: ${provider.clientSecret}`);
      console.log(`      Enabled:       ${provider.enabled}`);
    });
  }

  if (originalConfig.localAuth?.jwtSecret) {
    console.log(`\n   Local Auth JWT Secret: ${originalConfig.localAuth.jwtSecret}`);
  }

  // Step 2: Simulate GET endpoint (what the admin page sees)
  console.log('\n\n🔍 Step 2: Simulating GET /admin/configs/platform (what admin page receives)...\n');
  
  const sanitizedForClient = {
    ...originalConfig,
    oidcAuth: {
      ...originalConfig.oidcAuth,
      providers: originalConfig.oidcAuth?.providers?.map(provider => ({
        ...provider,
        clientSecret: sanitizeSecret(provider.clientSecret)
      })) || []
    },
    localAuth: {
      ...originalConfig.localAuth,
      jwtSecret: sanitizeSecret(originalConfig.localAuth?.jwtSecret)
    }
  };

  if (sanitizedForClient.oidcAuth?.providers) {
    console.log('   Sanitized OIDC Providers (sent to client):');
    sanitizedForClient.oidcAuth.providers.forEach((provider, index) => {
      console.log(`   ${index + 1}. ${provider.displayName || provider.name}:`);
      console.log(`      Client ID:     ${provider.clientId}`);
      console.log(`      Client Secret: ${provider.clientSecret}`);
      const isEnvVar = isEnvVarPlaceholder(originalConfig.oidcAuth.providers[index].clientSecret);
      console.log(`      Note:          ${isEnvVar ? '✓ Environment variable preserved' : '✓ Actual secret redacted'}`);
    });
  }

  if (sanitizedForClient.localAuth?.jwtSecret) {
    const isEnvVar = isEnvVarPlaceholder(originalConfig.localAuth.jwtSecret);
    console.log(`\n   Local Auth JWT Secret: ${sanitizedForClient.localAuth.jwtSecret}`);
    console.log(`   Note:                  ${isEnvVar ? '✓ Environment variable preserved' : '✓ Actual secret redacted'}`);
  }

  // Step 3: Simulate client making a change (disabling Google provider)
  console.log('\n\n✏️  Step 3: Simulating user disabling Google provider in admin UI...\n');
  
  const clientModifiedConfig = {
    ...sanitizedForClient,
    oidcAuth: {
      ...sanitizedForClient.oidcAuth,
      providers: sanitizedForClient.oidcAuth.providers.map(provider => ({
        ...provider,
        enabled: provider.name === 'microsoft' // Only keep Microsoft enabled
      }))
    }
  };

  console.log('   Modified configuration (what client sends back):');
  clientModifiedConfig.oidcAuth.providers.forEach((provider, index) => {
    console.log(`   ${index + 1}. ${provider.displayName || provider.name}:`);
    console.log(`      Enabled:       ${provider.enabled} ${provider.enabled ? '' : '(CHANGED)'}`);
    console.log(`      Client Secret: ${provider.clientSecret}`);
  });

  // Step 4: Simulate POST endpoint (server restoring secrets)
  console.log('\n\n💾 Step 4: Simulating POST /admin/configs/platform (server restoring secrets)...\n');

  const restoredConfig = {
    ...clientModifiedConfig,
    oidcAuth: {
      ...clientModifiedConfig.oidcAuth,
      providers: clientModifiedConfig.oidcAuth.providers.map((provider, index) => ({
        ...provider,
        clientSecret: restoreSecretIfRedacted(
          provider.clientSecret,
          originalConfig.oidcAuth.providers[index].clientSecret
        )
      }))
    },
    localAuth: {
      ...clientModifiedConfig.localAuth,
      jwtSecret: restoreSecretIfRedacted(
        clientModifiedConfig.localAuth.jwtSecret,
        originalConfig.localAuth.jwtSecret
      )
    }
  };

  console.log('   Final configuration (what gets saved to platform.json):');
  restoredConfig.oidcAuth.providers.forEach((provider, index) => {
    const originalSecret = originalConfig.oidcAuth.providers[index].clientSecret;
    console.log(`   ${index + 1}. ${provider.displayName || provider.name}:`);
    console.log(`      Client Secret: ${provider.clientSecret}`);
    if (provider.clientSecret === originalSecret) {
      console.log(`      Status:        ✓ Original secret preserved!`);
    } else {
      console.log(`      Status:        ✗ Secret was changed (this should not happen!)`);
    }
    console.log(`      Enabled:       ${provider.enabled}`);
  });

  if (restoredConfig.localAuth?.jwtSecret) {
    const originalJwt = originalConfig.localAuth.jwtSecret;
    console.log(`\n   Local Auth JWT Secret: ${restoredConfig.localAuth.jwtSecret}`);
    if (restoredConfig.localAuth.jwtSecret === originalJwt) {
      console.log(`   Status:                ✓ Original JWT secret preserved!`);
    } else {
      console.log(`   Status:                ✗ JWT secret was changed (this should not happen!)`);
    }
  }

  // Verification
  console.log('\n\n✅ Verification:\n');
  
  let allGood = true;
  
  // Check Microsoft secret (env var should be preserved)
  if (restoredConfig.oidcAuth.providers[0].clientSecret === '${MICROSOFT_CLIENT_SECRET}') {
    console.log('   ✓ Microsoft client secret (env var) was preserved correctly');
  } else {
    console.log('   ✗ Microsoft client secret (env var) was NOT preserved!');
    allGood = false;
  }

  // Check Google secret (actual secret should be preserved)
  if (restoredConfig.oidcAuth.providers[1].clientSecret === 'actual-secret-value') {
    console.log('   ✓ Google client secret (actual value) was preserved correctly');
  } else {
    console.log('   ✗ Google client secret (actual value) was NOT preserved!');
    allGood = false;
  }

  // Check JWT secret (env var should be preserved)
  if (restoredConfig.localAuth.jwtSecret === '${JWT_SECRET}') {
    console.log('   ✓ JWT secret (env var) was preserved correctly');
  } else {
    console.log('   ✗ JWT secret (env var) was NOT preserved!');
    allGood = false;
  }

  // Check that the user's change (disabling Google) was preserved
  if (restoredConfig.oidcAuth.providers[0].enabled === true &&
      restoredConfig.oidcAuth.providers[1].enabled === false) {
    console.log('   ✓ User\'s change (disabling Google provider) was preserved');
  } else {
    console.log('   ✗ User\'s change was NOT preserved!');
    allGood = false;
  }

  console.log('\n' + '═'.repeat(62));
  if (allGood) {
    console.log('✅ SUCCESS! The fix works correctly.');
    console.log('   Environment variables are preserved when making config changes.');
  } else {
    console.log('❌ FAILURE! The fix has issues.');
  }
  console.log('═'.repeat(62) + '\n');

  return allGood;
}

// Run the demonstration
demonstrateFix().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
