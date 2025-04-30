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
  const serverScriptPath = path.join(tempDir, 'start-server.js');
  
  // Write the server script content - this is a simple script that imports server.js
  fs.writeFileSync(serverScriptPath, `
// External server starter script
import * as path from 'path';
import { fileURLToPath } from 'url';

// Set up environment variables
process.env.NODE_ENV = 'production';
process.env.HOST = '${process.env.HOST}';
process.env.PORT = '${process.env.PORT}';
process.env.APP_ROOT_DIR = '${binDir.replace(/\\/g, '\\\\')}'; // Fix Windows paths

// Import and run the server
try {
  // We need to resolve the server.js path directly
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const serverPath = path.resolve(__dirname, '../server/server.js');
  console.log('Importing server from:', serverPath);
  
  // Dynamically import the server
  import(serverPath)
    .catch(err => {
      console.error('Error importing server module:', err);
      process.exit(1);
    });
} catch (err) {
  console.error('Error in server bootstrap:', err);
  process.exit(1);
}
`);
  
  console.log('Created external server script at:', serverScriptPath);
  
  // Create the server directory if it doesn't exist (for packaged binary)
  const serverDir = path.join(binDir, 'server');
  if (!fs.existsSync(serverDir)) {
    fs.mkdirSync(serverDir, { recursive: true });
    console.log(`Created server directory at ${serverDir}`);
  }
  
  // Now run the external script with node using the --experimental-modules flag
  console.log('Starting server via external Node.js process...');
  
  // We need to use the system Node.js, not the binary's Node.js
  // First, try to find the Node.js executable in PATH
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
  
  // Run Node with the script file as a separate parameter
  // For Linux and Windows, we need to ensure flags are correctly interpreted
  // by putting them after the script path with a double dash
  const nodeProcess = spawnSync(nodePath, [
    serverScriptPath,
    // Place flags after the script as a workaround for Linux/Windows
    // Windows and Linux will now see these as arguments to the script, not as paths
    '--', 
    '--experimental-modules',
    '--experimental-json-modules'
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