#!/usr/bin/env node

/**
 * Binary entry point for AI Hub Apps
 * This file is specifically designed to be the entry point for the pkg-created binary
 * Using .cjs extension to ensure it's treated as CommonJS
 */

// Set production environment
process.env.NODE_ENV = 'production';

// Add better error handling
process.on('uncaughtException', (err) => {
  console.error('FATAL UNCAUGHT EXCEPTION:');
  console.error(err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED PROMISE REJECTION:');
  console.error(reason);
});

// Display startup message
console.log('Starting AI Hub Apps...');
console.log(`NODE_ENV: ${process.env.NODE_ENV}`);

// Load dependencies
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
let dotenv;

try {
  // Try to load dotenv using require
  dotenv = require('dotenv');
} catch (err) {
  console.warn('Could not load dotenv module, continuing without it');
}

// Get the directory where the binary is located
const binDir = path.dirname(process.execPath);
console.log(`Binary directory: ${binDir}`);

// Try to load config.env from the binary directory
const configPath = path.join(binDir, 'config.env');
console.log(`Looking for configuration at: ${configPath}`);

if (fs.existsSync(configPath)) {
  console.log('Found config.env, loading configuration...');
  
  // If dotenv module failed to load, manually parse the config file
  if (dotenv) {
    dotenv.config({ path: configPath });
  } else {
    try {
      const configContent = fs.readFileSync(configPath, 'utf8');
      const configLines = configContent.split('\n');
      
      configLines.forEach(line => {
        // Skip comments and empty lines
        if (line.trim().startsWith('#') || !line.trim()) return;
        
        // Parse KEY=VALUE format
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
        if (match) {
          const key = match[1];
          // Remove quotes if present
          let value = match[2] || '';
          value = value.replace(/^['"]|['"]$/g, '');
          
          // Set environment variable
          process.env[key] = value;
        }
      });
      
      console.log('Manually parsed configuration file');
    } catch (err) {
      console.error('Error parsing config.env:', err);
    }
  }
  
  console.log('Configuration loaded successfully');
} else {
  console.log('No config.env found, using default/environment settings');
}

// Provide default values for host and port
if (!process.env.HOST) {
  process.env.HOST = '0.0.0.0'; // Default to all interfaces
}
if (!process.env.PORT) {
  process.env.PORT = '3000'; // Default port
}

// Set APP_ROOT_DIR environment variable to the binary directory
// This is critical as server.js uses this to find the correct paths
process.env.APP_ROOT_DIR = binDir;

// Log the final configuration
console.log(`Server will run with HOST=${process.env.HOST} and PORT=${process.env.PORT}`);

// Instead of trying to import server.js (which is an ES module), let's create an external Node.js process
// to run it, which avoids module compatibility issues
try {
  // Create a temporary directory for the server script
  const tempDir = path.join(binDir, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  // Create an external server script that will be run by Node.js
  // Use .cjs extension to force CommonJS mode regardless of package.json type setting
  const serverScriptPath = path.join(tempDir, 'start-server.cjs');
  
  // Write the server script content using CommonJS syntax for better compatibility
  fs.writeFileSync(serverScriptPath, `
// External server starter script using CommonJS
const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');

// Set up environment variables
process.env.NODE_ENV = 'production';
process.env.HOST = '${process.env.HOST}';
process.env.PORT = '${process.env.PORT}';
process.env.APP_ROOT_DIR = '${binDir.replace(/\\/g, '\\\\')}'; // Fix Windows paths

// Find server.js path
const serverPath = path.resolve(process.env.APP_ROOT_DIR, 'server/server.mjs');
console.log('Server path:', serverPath);

// Use current Node.js executable
const nodePath = process.execPath;
console.log('Using Node.js from:', nodePath);

// Platform-specific handling for passing flags to Node.js
// This is the critical part that fixes the cross-platform issues
let nodeArgs;
if (process.platform === 'win32') {
  // On Windows, put the script first, followed by '--' and then the flags
  nodeArgs = [
    serverPath,
    '--', 
    '--experimental-modules',
    '--experimental-json-modules'
  ];
} else if (process.platform === 'linux') {
  // On Linux, include the input-type=module flag
  nodeArgs = [
    '--experimental-modules',
    '--experimental-json-modules',
    serverPath
  ];
} else {
  // On macOS, exclude the input-type=module flag
  nodeArgs = [
    '--experimental-modules',
    '--experimental-json-modules',
    serverPath
  ];
}

// Run the server as a child process with the platform-appropriate arguments
const nodeProcess = spawnSync(nodePath, nodeArgs, {
  cwd: process.env.APP_ROOT_DIR,
  env: process.env,
  stdio: 'inherit'
});

if (nodeProcess.error) {
  console.error('Error launching server:', nodeProcess.error);
  process.exit(1);
}

process.exit(nodeProcess.status || 0);
`);
  
  console.log('Created external server script at:', serverScriptPath);
  
  // Starting server via Node.js process
  console.log('Starting server via external Node.js process...');
  
  // Find the Node.js executable
  let nodePath;
  
  // On macOS/Linux, use the 'which' command to locate node
  if (process.platform !== 'win32') {
    try {
      // Use the 'which' command to find node in PATH
      const { stdout } = spawnSync('which', ['node'], { encoding: 'utf8' });
      nodePath = stdout.trim();
      
      if (!nodePath) {
        // Fallback to common locations
        if (fs.existsSync('/usr/local/bin/node')) {
          nodePath = '/usr/local/bin/node';
        } else if (fs.existsSync('/usr/bin/node')) {
          nodePath = '/usr/bin/node';
        } else {
          // Last resort, try the current process executable
          nodePath = process.execPath;
        }
      }
    } catch (err) {
      // If 'which' fails, use the current process executable
      nodePath = process.execPath;
    }
  } else {
    // On Windows, we can use 'where' command
    try {
      const { stdout } = spawnSync('where', ['node'], { encoding: 'utf8' });
      nodePath = stdout.split('\n')[0].trim();
      
      if (!nodePath) {
        nodePath = process.execPath;
      }
    } catch (err) {
      nodePath = process.execPath;
    }
  }
  
  console.log(`Using Node.js executable at: ${nodePath}`);
  
  // Run the script with Node.js directly (NOT passing flags like --experimental-modules here)
  const nodeProcess = spawnSync(nodePath, [
    serverScriptPath
  ], {
    cwd: binDir,
    env: process.env,
    stdio: 'inherit' // This passes stdio to the parent process
  });
  
  if (nodeProcess.error) {
    console.error('Error launching Node.js process:', nodeProcess.error);
    process.exit(1);
  }
  
  const exitCode = nodeProcess.status || 0;
  console.log(`Server process exited with code ${exitCode}`);
  process.exit(exitCode);
  
} catch (err) {
  console.error('Error starting server:', err);
  process.exit(1);
}