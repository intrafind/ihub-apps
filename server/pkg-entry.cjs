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

// Output platform information to help with debugging
console.log('PLATFORM DEBUG INFO:');
console.log('process.platform:', process.platform);
console.log('Architecture:', process.arch);
console.log('WSL check:', fs.existsSync('/proc/version') ? 
  fs.readFileSync('/proc/version', 'utf8').substr(0, 100) + '...' : 'File not accessible');

// Check if we're running in WSL
const isWSL = process.platform === 'linux' && 
              fs.existsSync('/proc/version') && 
              fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');

if (isWSL) {
  console.log('Detected WSL environment');
}

// Create a simple wrapper script to execute the server.mjs file
// This avoids issues with command-line flags
try {
  // Create a temporary directory
  const tempDir = path.join(binDir, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  // Path to the server.mjs file
  const serverPath = path.resolve(binDir, 'server/server.mjs');
  console.log(`Server path: ${serverPath}`);
  
  // Create a minimal wrapper script
  const wrapperPath = path.join(tempDir, 'server-wrapper.mjs');
  
  // Write a very simple ESM wrapper that can be executed with minimal flags
  const wrapperContent = `
// Simple ESM wrapper to load the server.mjs file
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Log the import
console.log('Wrapper starting import of server.mjs');
console.log('Server path:', '${serverPath.replace(/\\/g, '\\\\')}');

// Dynamically import the server module
import('${serverPath.replace(/\\/g, '\\\\')}')
  .catch(err => {
    console.error('Error importing server.mjs:', err);
    process.exit(1);
  });
`;
  
  fs.writeFileSync(wrapperPath, wrapperContent);
  console.log(`Created wrapper script at: ${wrapperPath}`);
  
  // Determine the Node.js executable to use
  const nodePath = process.execPath;
  console.log(`Using Node.js executable: ${nodePath}`);
  
  console.log('Running with packaged Node.js binary, using direct execution approach');
    
    // Create a temporary shell script to execute node with proper flags
    const shellScript = process.platform === 'win32' 
      ? path.join(tempDir, 'run-server.cmd')  // Windows batch file  
      : path.join(tempDir, 'run-server.sh');  // Unix shell script
    
    if (process.platform === 'win32') {
      // Windows batch file
      fs.writeFileSync(shellScript, `
@echo off
echo Running server with system Node.js...
node --experimental-modules "${wrapperPath}"
exit %ERRORLEVEL%
      `);
    } else {
      // Unix shell script
      fs.writeFileSync(shellScript, `
#!/bin/sh
echo "Running server with system Node.js..."
node --experimental-modules --experimental-json-modules "${wrapperPath}"
exit $?
      `);
      
      // Make the script executable
      try {
        fs.chmodSync(shellScript, '755');
      } catch (err) {
        console.warn('Could not make shell script executable:', err);
      }
    }
    
    console.log(`Created shell script at: ${shellScript}`);
    
    // Execute the shell script
    const spawnOptions = {
      cwd: binDir,
      env: process.env,
      stdio: 'inherit',
      shell: true  // This is key - we need to use the shell to execute the script
    };
    
    if (process.platform === 'win32') {
      console.log('Executing batch file...');
      const shellProcess = spawnSync(shellScript, [], spawnOptions);
      
      if (shellProcess.error) {
        console.error('Error executing batch file:', shellProcess.error);
        process.exit(1);
      }
      
      process.exit(shellProcess.status || 0);
    } else {
      console.log('Executing shell script...');
      const shellProcess = spawnSync('/bin/sh', [shellScript], spawnOptions);
      
      if (shellProcess.error) {
        console.error('Error executing shell script:', shellProcess.error);
        process.exit(1);
      }
      
      process.exit(shellProcess.status || 0);
    }
  
} catch (err) {
  console.error('Error starting server:', err);
  process.exit(1);
}
