#!/usr/bin/env node
/**
 * ihub CLI — CJS entry point wrapper
 * Loads the ESM CLI module via dynamic import in a CommonJS context
 */
'use strict';

process.on('uncaughtException', err => {
  console.error('\x1b[31m✗\x1b[0m Fatal error:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', reason => {
  const msg = reason?.message || String(reason);
  console.error('\x1b[31m✗\x1b[0m Unhandled rejection:', msg);
  process.exit(1);
});

const path = require('path');
const url = require('url');

(async () => {
  try {
    const cliPath = path.join(__dirname, 'index.js');
    const cliUrl = url.pathToFileURL(cliPath).href;
    await import(cliUrl);
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' && err.message.includes('@clack/prompts')) {
      console.error('\x1b[31m✗\x1b[0m Missing dependency: @clack/prompts');
      console.error('  Run: npm install  to install all dependencies');
    } else {
      console.error('\x1b[31m✗\x1b[0m CLI startup error:', err.message);
    }
    process.exit(1);
  }
})();
