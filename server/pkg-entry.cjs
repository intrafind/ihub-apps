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

// Provide default values for host and port
if (!process.env.HOST) {
  process.env.HOST = '0.0.0.0'; // Default to all interfaces
}
if (!process.env.PORT) {
  process.env.PORT = '3000'; // Default port
}

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

// Log the final configuration
console.log(`Server will run with HOST=${process.env.HOST} and PORT=${process.env.PORT}`);

// Create a simple bootstrap script using a much simpler approach
try {
  const tempDir = path.join(binDir, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  // Create a shell script (for Unix-based systems)
  const isWindows = process.platform === 'win32';
  const scriptExt = isWindows ? '.cmd' : '.sh';
  const scriptPath = path.join(tempDir, `start-server${scriptExt}`);
  
  // Create the script content based on the platform
  let scriptContent;
  if (isWindows) {
    scriptContent = `@echo off
rem Bootstrap script for AI Hub Apps on Windows
set NODE_ENV=production
set PORT=${process.env.PORT || 3000}
set HOST=${process.env.HOST || '0.0.0.0'}
set APP_ROOT_DIR=${binDir}
${Object.entries(process.env)
  .filter(([key]) => 
    key.includes('API_KEY') || 
    key.includes('SSL_') || 
    key === 'REQUEST_TIMEOUT'
  )
  .map(([key, value]) => `set ${key}=${value || ''}`)
  .join('\r\n')}

echo Starting server...
node --experimental-modules --experimental-json-modules "%~dp0/../server/server.js"
`;
  } else {
    scriptContent = `#!/bin/sh
# Bootstrap script for AI Hub Apps
export NODE_ENV=production
export PORT=${process.env.PORT || 3000}
export HOST=${process.env.HOST || '0.0.0.0'}
export APP_ROOT_DIR="${binDir}"
${Object.entries(process.env)
  .filter(([key]) => 
    key.includes('API_KEY') || 
    key.includes('SSL_') || 
    key === 'REQUEST_TIMEOUT'
  )
  .map(([key, value]) => `export ${key}='${value || ''}'`)
  .join('\n')}

echo "Starting server..."
exec node --experimental-modules --experimental-json-modules "../server/server.js"
`;
  }
  
  console.log(`Creating bootstrap script at: ${scriptPath}`);
  fs.writeFileSync(scriptPath, scriptContent);
  
  // Make the shell script executable on Unix systems
  if (!isWindows) {
    fs.chmodSync(scriptPath, '755');
  }
  
  // Launch the script
  console.log('Launching server via bootstrap script...');
  let result;
  
  if (isWindows) {
    result = spawnSync(scriptPath, [], {
      cwd: binDir,
      stdio: 'inherit',
      shell: true
    });
  } else {
    result = spawnSync('/bin/sh', [scriptPath], {
      cwd: binDir,
      stdio: 'inherit'
    });
  }
  
  // Check the result
  if (result.error) {
    console.error(`Error launching server: ${result.error.message}`);
    process.exit(1);
  }
  
  console.log(`Server process exited with code ${result.status || 0}`);
  process.exit(result.status || 0);
  
} catch (err) {
  console.error('Error launching server:', err);
  process.exit(1);
}