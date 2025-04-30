#!/usr/bin/env node

/**
 * Binary entry point for AI Hub Apps
 * Simpler approach - just modify ENV variables and pass control to real server
 */

// Set production environment
process.env.NODE_ENV = 'production';

// Basic error handling
process.on('uncaughtException', (err) => {
  console.error('FATAL UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED PROMISE REJECTION:', reason);
});

// Essential dependencies
const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');

// Display startup message
console.log('Starting AI Hub Apps...');

// Get the directory where the binary is located
const binDir = path.dirname(process.execPath);
console.log(`Binary directory: ${binDir}`);

// Load config.env if available
const configPath = path.join(binDir, 'config.env');
if (fs.existsSync(configPath)) {
  console.log('Found config.env, loading configuration...');
  try {
    const configContent = fs.readFileSync(configPath, 'utf8');
    const configLines = configContent.split('\n');
    
    configLines.forEach(line => {
      if (line.trim().startsWith('#') || !line.trim()) return;
      
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        value = value.replace(/^['"]|['"]$/g, '');
        process.env[key] = value;
      }
    });
    console.log('Configuration loaded successfully');
  } catch (err) {
    console.error('Error parsing config.env:', err);
  }
}

// Set default values
process.env.HOST = process.env.HOST || '0.0.0.0';
process.env.PORT = process.env.PORT || '3000';
process.env.APP_ROOT_DIR = binDir;

console.log(`Server will run with HOST=${process.env.HOST} and PORT=${process.env.PORT}`);

// SOLUTION: Use Node.js from the system to execute the server.mjs file
// This is much simpler than other approaches, but requires Node.js to be installed

try {
  console.log('Finding Node.js executable...');
  
  // Find Node.js in the system
  let nodePath;
  
  // Try to find Node.js executable using the PATH
  try {
    const command = process.platform === 'win32' ? 'where node' : 'which node';
    nodePath = childProcess.execSync(command, { encoding: 'utf8' }).trim();
    console.log(`Found Node.js at: ${nodePath}`);
  } catch (e) {
    // If we can't find Node.js, use the embedded Node
    console.log('Could not find system Node.js, using binary to run server...');
    
    // Look for the server.mjs path
    const serverPath = path.join(binDir, 'server', 'server.mjs');
    console.log(`Server path: ${serverPath}`);
    
    if (!fs.existsSync(serverPath)) {
      console.error(`Error: Server file not found at ${serverPath}`);
      process.exit(1);
    }
    
    console.log('Creating child Node.js process to run server...');
    console.log(`Current executable: ${process.execPath}`);
    
    const nodeArgs = process.platform === 'win32' 
      ? [serverPath]  // Windows doesn't need the flags
      : ['--experimental-modules', serverPath];  // Unix needs the flags
      
    console.log(`Executing: node ${nodeArgs.join(' ')}`);
    
    // Since we can't directly import the ESM file, we need to use a workaround
    // Create a subprocess to run the server with the necessary flags
    const nodeProcess = childProcess.spawn(process.execPath, nodeArgs, {
      stdio: 'inherit',
      env: process.env,
      shell: true  // Use shell to help resolve path issues
    });
    
    nodeProcess.on('close', (code) => {
      console.log(`Child process exited with code ${code}`);
      process.exit(code);
    });
    
    // Keep parent process alive
    return;
  }
  
  // If we found system Node.js, use it to run the server
  const serverPath = path.join(binDir, 'server', 'server.mjs');
  console.log(`Server path: ${serverPath}`);
  
  if (!fs.existsSync(serverPath)) {
    console.error(`Error: Server file not found at ${serverPath}`);
    process.exit(1);
  }
  
  console.log('Executing server with system Node.js...');
  
  // Execute the server using the system Node.js, which has proper ESM support
  const nodeProcess = childProcess.spawn(nodePath, ['--experimental-modules', serverPath], {
    stdio: 'inherit',
    env: process.env
  });
  
  nodeProcess.on('close', (code) => {
    console.log(`Server process exited with code ${code}`);
    process.exit(code);
  });
  
} catch (err) {
  console.error('Error starting server:', err);
  process.exit(1);
}
