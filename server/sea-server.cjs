/**
 * Node.js SEA (Single Executable Application) wrapper for iHub Apps server
 * This file loads and runs the ESM server module using dynamic import in a CommonJS context
 */

// Basic error handling
process.on('uncaughtException', err => {
  console.error('FATAL UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', reason => {
  console.error('UNHANDLED PROMISE REJECTION:', reason);
});

// Essential dependencies that should be available in the Node.js runtime
const path = require('path');
const url = require('url');
require('fs');

async function startServer() {
  try {
    require('dotenv').config();
    const { default: config } = await import('./config.js');

    // In SEA mode, APP_ROOT_DIR is set by the shell wrapper (build-sea.cjs).
    // In npx / regular npm mode it is not set, so fall back to the package root
    // derived from __dirname (which is the server/ subdirectory).
    const binDir = config.APP_ROOT_DIR || path.resolve(__dirname, '..');
    console.log(`Running server from directory: ${binDir}`);
    console.log('Initializing iHub Apps server...');

    // Auto-open the browser when running via npx / binary (no APP_ROOT_DIR means
    // the user is doing a zero-install trial rather than a managed deployment).
    // Explicit IHUB_OPEN_BROWSER env var always takes precedence.
    if (process.env.IHUB_OPEN_BROWSER === undefined) {
      process.env.IHUB_OPEN_BROWSER = config.APP_ROOT_DIR ? '0' : '1';
    }

    const serverPath = path.join(binDir, 'server', 'server.js');
    const serverUrl = url.pathToFileURL(serverPath).href;

    console.log(`Importing server module from: ${serverUrl}`);

    await import(serverUrl);

    console.log('Server module loaded successfully');
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
}

// Start the server
startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
