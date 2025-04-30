/**
 * Node.js SEA (Single Executable Application) wrapper for AI Hub Apps server
 * This file loads and runs the ESM server module using dynamic import in a CommonJS context
 */

// Basic error handling
process.on('uncaughtException', (err) => {
  console.error('FATAL UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED PROMISE REJECTION:', reason);
});

// Essential dependencies that should be available in the Node.js runtime
const path = require('path');
const url = require('url');
const fs = require('fs');

// Get the directory where the executable is located
const binDir = process.env.APP_ROOT_DIR || path.dirname(process.execPath);
console.log(`Running server from directory: ${binDir}`);

// Function to dynamically import the ESM server module
async function startServer() {
  try {
    console.log('Initializing AI Hub Apps server...');
    
    // For SEA, we need to use fileURLToPath equivalent for CommonJS
    const serverPath = path.join(binDir, 'server', 'server.js');
    const serverUrl = url.pathToFileURL(serverPath).href;
    
    console.log(`Importing server module from: ${serverUrl}`);
    
    // Dynamically import the ESM server module
    const serverModule = await import(serverUrl);
    
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