#!/usr/bin/env node

/**
 * Manual Test Runner
 *
 * Runs every file listed in manual-test-files.js (plain-script checks and
 * node:test suites that Jest can't run — see jest.config.js
 * testPathIgnorePatterns) directly with `node`, one child process per file,
 * and reports a pass/fail summary.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { manualTestFiles } from './manual-test-files.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function runFile(file) {
  return new Promise(resolve => {
    const child = spawn('node', [file], {
      cwd: __dirname,
      stdio: 'inherit'
    });
    child.on('close', code => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

async function main() {
  const results = [];
  for (const file of manualTestFiles) {
    const passed = await runFile(file);
    results.push({ file, passed });
  }

  const failed = results.filter(r => !r.passed);
  console.log('\n' + '='.repeat(60));
  console.log('MANUAL TEST SUMMARY');
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(`${r.passed ? '✅' : '❌'} ${r.file}`);
  }
  console.log('-'.repeat(60));
  console.log(`${results.length - failed.length}/${results.length} passed`);

  process.exit(failed.length === 0 ? 0 : 1);
}

main();
