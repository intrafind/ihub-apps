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

    const binDir = config.APP_ROOT_DIR || path.dirname(process.execPath);
    console.log(`Running server from directory: ${binDir}`);
    console.log('Initializing iHub Apps server...');

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

async function runVerify(args) {
  require('dotenv').config();
  const { runVerifyCLI } = await import(
    url.pathToFileURL(path.join(__dirname, 'cli', 'verify.js')).href
  );
  process.exit(await runVerifyCLI(args));
}

if (process.argv[2] === 'verify') {
  // `ihub-apps verify <file>`: the offline EU AI Act detector, no server.
  runVerify(process.argv.slice(3)).catch(err => {
    console.error('verify failed:', err);
    process.exit(3);
  });
} else {
  // Start the server
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
