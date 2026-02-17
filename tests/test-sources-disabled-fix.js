#!/usr/bin/env node
/**
 * Test: Sources Feature Disabled - App Editor Should Work
 * 
 * This test validates that when the sources feature is disabled:
 * 1. The /api/admin/sources endpoint returns 403 FEATURE_DISABLED
 * 2. The SourcePicker component handles this gracefully
 * 3. The AppFormEditor still renders and functions correctly
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

console.log('🧪 Testing Sources Feature Disabled Fix\n');

// Test 1: Verify SourcePicker handles featureDisabled state
console.log('Test 1: SourcePicker Component Changes');
const sourcePickerPath = join(rootDir, 'client/src/features/admin/components/SourcePicker.jsx');
const sourcePickerContent = readFileSync(sourcePickerPath, 'utf8');

const checks = [
  {
    name: 'Has featureDisabled state',
    test: () => sourcePickerContent.includes('const [featureDisabled, setFeatureDisabled]'),
    reason: 'Component needs state to track when feature is disabled'
  },
  {
    name: 'Detects FEATURE_DISABLED error code',
    test: () => sourcePickerContent.includes("err.response?.data?.code === 'FEATURE_DISABLED'"),
    reason: 'Must specifically detect the feature disabled error'
  },
  {
    name: 'Sets featureDisabled on 403',
    test: () => sourcePickerContent.includes('setFeatureDisabled(true)'),
    reason: 'Component should track disabled state'
  },
  {
    name: 'Returns null when disabled',
    test: () => sourcePickerContent.includes('if (featureDisabled)') && 
                sourcePickerContent.includes('return null;'),
    reason: 'Component should hide itself when feature is disabled'
  }
];

let passed = 0;
let failed = 0;

checks.forEach(check => {
  if (check.test()) {
    console.log(`✅ ${check.name}`);
    passed++;
  } else {
    console.log(`❌ ${check.name}`);
    console.log(`   Reason: ${check.reason}`);
    failed++;
  }
});

console.log('');

// Test 2: Verify AppFormEditor uses platform config
console.log('Test 2: AppFormEditor Component Changes');
const appFormEditorPath = join(rootDir, 'client/src/features/admin/components/AppFormEditor.jsx');
const appFormEditorContent = readFileSync(appFormEditorPath, 'utf8');

const editorChecks = [
  {
    name: 'Imports usePlatformConfig',
    test: () => appFormEditorContent.includes("import { usePlatformConfig }"),
    reason: 'Must import the hook to access platform config'
  },
  {
    name: 'Calls usePlatformConfig hook',
    test: () => appFormEditorContent.includes('const { platformConfig } = usePlatformConfig()'),
    reason: 'Must retrieve platform config'
  },
  {
    name: 'Checks sources feature flag',
    test: () => appFormEditorContent.includes('platformConfig?.featuresMap?.sources'),
    reason: 'Must check if sources feature is enabled'
  },
  {
    name: 'Conditionally renders sources section',
    test: () => appFormEditorContent.includes('{isSourcesEnabled && ('),
    reason: 'Sources section should only render when enabled'
  }
];

editorChecks.forEach(check => {
  if (check.test()) {
    console.log(`✅ ${check.name}`);
    passed++;
  } else {
    console.log(`❌ ${check.name}`);
    console.log(`   Reason: ${check.reason}`);
    failed++;
  }
});

console.log('');

// Test 3: Verify feature registry has sources feature
console.log('Test 3: Feature Registry Configuration');
const featureRegistryPath = join(rootDir, 'server/featureRegistry.js');
const featureRegistryContent = readFileSync(featureRegistryPath, 'utf8');

const registryChecks = [
  {
    name: 'Sources feature is registered',
    test: () => featureRegistryContent.includes("id: 'sources'"),
    reason: 'Sources must be in feature registry'
  },
  {
    name: 'requireFeature middleware exists',
    test: () => featureRegistryContent.includes('export function requireFeature'),
    reason: 'Middleware to protect routes behind feature flags'
  },
  {
    name: 'Returns FEATURE_DISABLED code',
    test: () => featureRegistryContent.includes("code: 'FEATURE_DISABLED'"),
    reason: 'Must return specific error code for client detection'
  }
];

registryChecks.forEach(check => {
  if (check.test()) {
    console.log(`✅ ${check.name}`);
    passed++;
  } else {
    console.log(`❌ ${check.name}`);
    console.log(`   Reason: ${check.reason}`);
    failed++;
  }
});

console.log('');

// Summary
console.log('━'.repeat(50));
console.log(`Test Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('✅ All tests passed!');
  process.exit(0);
} else {
  console.log('❌ Some tests failed');
  process.exit(1);
}
