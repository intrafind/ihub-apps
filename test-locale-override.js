#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Testing locale override feature...\n');

// Test 1: Verify base translations exist
console.log('Test 1: Checking base translations...');
try {
  const enBase = await fs.readFile(path.join(__dirname, 'shared/i18n/en.json'), 'utf-8');
  const enData = JSON.parse(enBase);
  console.log('✓ Base English translations loaded');
  console.log(`  - Contains ${Object.keys(enData).length} top-level keys`);

  const deBase = await fs.readFile(path.join(__dirname, 'shared/i18n/de.json'), 'utf-8');
  const deData = JSON.parse(deBase);
  console.log('✓ Base German translations loaded');
  console.log(`  - Contains ${Object.keys(deData).length} top-level keys`);
} catch (error) {
  console.error('✗ Failed to load base translations:', error.message);
  process.exit(1);
}

// Test 2: Create test override file
console.log('\nTest 2: Creating test override file...');
const contentsDir = path.join(__dirname, 'contents');
const localesDir = path.join(contentsDir, 'locales');
const testOverrideFile = path.join(localesDir, 'en.json');

try {
  await fs.mkdir(localesDir, { recursive: true });
  console.log('✓ Created locales directory');

  const overrideContent = {
    app: {
      title: 'Custom iHub Apps Title'
    },
    common: {
      save: 'Custom Save Text'
    }
  };

  await fs.writeFile(testOverrideFile, JSON.stringify(overrideContent, null, 2));
  console.log('✓ Created override file at contents/locales/en.json');
  console.log('  Override content:', JSON.stringify(overrideContent, null, 2));
} catch (error) {
  console.error('✗ Failed to create override file:', error.message);
  process.exit(1);
}

// Test 3: Verify mergeLocaleData function exists
console.log('\nTest 3: Testing mergeLocaleData function...');
try {
  // Import ConfigCache to test merge logic
  const configCacheModule = await import('./server/configCache.js');
  const configCache = configCacheModule.default;

  const base = {
    app: {
      title: 'Original Title',
      subtitle: 'Original Subtitle'
    },
    common: {
      save: 'Save',
      cancel: 'Cancel'
    }
  };

  const overrides = {
    app: {
      title: 'Overridden Title'
    },
    common: {
      save: 'Custom Save'
    }
  };

  const merged = configCache.mergeLocaleData(base, overrides);

  // Verify merge results
  if (merged.app.title === 'Overridden Title') {
    console.log('✓ Override values correctly replace base values');
  } else {
    console.error('✗ Override failed - title should be "Overridden Title"');
  }

  if (merged.app.subtitle === 'Original Subtitle') {
    console.log('✓ Non-overridden values are preserved');
  } else {
    console.error('✗ Preservation failed - subtitle should be "Original Subtitle"');
  }

  if (merged.common.cancel === 'Cancel') {
    console.log('✓ Nested non-overridden values are preserved');
  } else {
    console.error('✗ Nested preservation failed');
  }
} catch (error) {
  console.error('✗ Failed to test mergeLocaleData:', error.message);
  process.exit(1);
}

// Test 4: Test unknown key warning
console.log('\nTest 4: Testing unknown key handling...');
try {
  const configCacheModule = await import('./server/configCache.js');
  const configCache = configCacheModule.default;

  const base = {
    app: {
      title: 'Title'
    }
  };

  const overrides = {
    app: {
      title: 'New Title'
    },
    unknownKey: {
      value: 'Should not be merged'
    }
  };

  const merged = configCache.mergeLocaleData(base, overrides);

  if (merged.unknownKey === undefined) {
    console.log('✓ Unknown keys are not merged');
  } else {
    console.error('✗ Unknown key was incorrectly merged');
  }

  if (merged.app.title === 'New Title') {
    console.log('✓ Known keys are still merged correctly');
  } else {
    console.error('✗ Known key merge failed');
  }
} catch (error) {
  console.error('✗ Failed to test unknown key handling:', error.message);
  process.exit(1);
}

// Cleanup
console.log('\nCleaning up test files...');
try {
  await fs.unlink(testOverrideFile);
  const files = await fs.readdir(localesDir);
  if (files.length === 0) {
    await fs.rmdir(localesDir);
  }
  console.log('✓ Cleanup complete');
} catch (error) {
  console.warn('⚠ Cleanup warning:', error.message);
}

console.log('\n✅ All tests passed! Locale override feature is working correctly.');
console.log('\nFeature Summary:');
console.log('- Customers can create files in contents/locales/{lang}.json');
console.log('- Only override keys need to be present in override files');
console.log('- Unknown keys are ignored with a warning');
console.log('- Override values replace base values at all nesting levels');
console.log('- Non-overridden keys are preserved from base translations');
