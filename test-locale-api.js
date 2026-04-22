#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Testing locale override via API endpoint...\n');

// Create test override file
const contentsDir = path.join(__dirname, 'contents');
const localesDir = path.join(contentsDir, 'locales');
const testOverrideFile = path.join(localesDir, 'en.json');

const overrideContent = {
  app: {
    title: 'Test Override Title'
  }
};

try {
  await fs.mkdir(localesDir, { recursive: true });
  await fs.writeFile(testOverrideFile, JSON.stringify(overrideContent, null, 2));
  console.log('✓ Created test override file');
  console.log('  Path:', testOverrideFile);
  console.log('  Content:', JSON.stringify(overrideContent, null, 2));
  console.log('\nNext steps:');
  console.log('1. Start the server: npm run dev');
  console.log('2. Access: http://localhost:3000/api/translations/en');
  console.log('3. Look for "title": "Test Override Title" in the response');
  console.log('4. The overridden title should appear in the app.title field');
  console.log('\nCleanup:');
  console.log('  rm', testOverrideFile);
} catch (error) {
  console.error('Failed to create test override:', error.message);
  process.exit(1);
}
