#!/usr/bin/env node

/**
 * Windows Service Management Script for iHub Apps
 *
 * This script allows you to install, uninstall, start, stop, and manage
 * the iHub Apps Node.js application as a Windows Service.
 *
 * Usage:
 *   node scripts/windows-service.js install   - Install the service
 *   node scripts/windows-service.js uninstall - Uninstall the service
 *   node scripts/windows-service.js start     - Start the service
 *   node scripts/windows-service.js stop      - Stop the service
 *   node scripts/windows-service.js restart   - Restart the service
 *   node scripts/windows-service.js status    - Check service status
 */

import { Service } from 'node-windows';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import dotenv from 'dotenv';

// Get the current directory and project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname);

// Detect if we're running in a binary distribution or source
const isBinaryDistribution = existsSync(join(projectRoot, 'launcher.cjs'));

let serviceScript, nodeExecutable, configPath;

if (isBinaryDistribution) {
  console.log('Detected binary distribution, using launcher.cjs');
  // In binary distribution, use the launcher script and bundled node.exe
  serviceScript = join(projectRoot, 'launcher.cjs');
  nodeExecutable = join(projectRoot, 'node.exe');
  configPath = join(projectRoot, 'config.env');
} else {
  console.log('Detected source installation, using server/server.js');
  // In source installation, use the server script directly
  serviceScript = join(projectRoot, 'server', 'server.js');
  nodeExecutable = process.execPath; // Use the current Node.js executable
  configPath = join(projectRoot, '.env');
}

// Load environment variables
if (existsSync(configPath)) {
  dotenv.config({ path: configPath });
}

// Service configuration
const SERVICE_CONFIG = {
  name: 'iHub Apps',
  description: 'iHub Apps - AI-powered applications platform',
  script: serviceScript,
  nodeOptions: isBinaryDistribution ? [] : ['-r', 'dotenv/config'], // No need for dotenv in binary as launcher handles config
  execPath: nodeExecutable, // Use the correct Node.js executable
  env: [
    {
      name: 'NODE_ENV',
      value: process.env.NODE_ENV || 'production'
    },
    {
      name: 'APP_ROOT_DIR',
      value: projectRoot
    }
  ].concat(
    isBinaryDistribution
      ? []
      : [
          {
            name: 'dotenv_config_path',
            value: configPath
          }
        ]
  ),
  // Service will auto-restart on failure
  wait: 2,
  grow: 0.5,
  // Service account (defaults to LocalSystem)
  account: {
    // Uncomment and configure if you need to run under a specific account
    // domain: 'your-domain',
    // account: 'your-service-account',
    // password: 'your-password'
  }
};

// Create the service object
const svc = new Service(SERVICE_CONFIG);

// Service event handlers
svc.on('install', () => {
  console.log('✅ iHub Apps service installed successfully!');
  console.log('   Service Name:', SERVICE_CONFIG.name);
  console.log('   Description:', SERVICE_CONFIG.description);
  console.log('   Script:', SERVICE_CONFIG.script);
  console.log('');
  console.log('To start the service, run:');
  console.log('   npm run service:start');
  console.log('   or');
  console.log('   sc start "iHub Apps"');
});

svc.on('uninstall', () => {
  console.log('✅ iHub Apps service uninstalled successfully!');
});

svc.on('start', () => {
  console.log('✅ iHub Apps service started successfully!');
});

svc.on('stop', () => {
  console.log('✅ iHub Apps service stopped successfully!');
});

svc.on('error', err => {
  console.error('❌ Service error:', err);
  process.exit(1);
});

svc.on('invalidinstallation', () => {
  console.error('❌ Invalid installation detected');
  process.exit(1);
});

svc.on('alreadyinstalled', () => {
  console.log('⚠️  Service is already installed');
  console.log('To reinstall, first run: npm run service:uninstall');
});

svc.on('doesnotexist', () => {
  console.log('⚠️  Service does not exist');
  console.log('To install, run: npm run service:install');
});

// Helper functions
function validateEnvironment() {
  // Check if server script exists
  if (!existsSync(SERVICE_CONFIG.script)) {
    console.error('❌ Server script not found:', SERVICE_CONFIG.script);
    if (isBinaryDistribution) {
      console.error('Please make sure you are running this from the binary distribution directory');
      console.error('Expected files: launcher.cjs, node.exe');
    } else {
      console.error('Please make sure you are running this from the project root directory');
    }
    process.exit(1);
  }

  // Check if Node.js executable exists
  if (!existsSync(SERVICE_CONFIG.execPath)) {
    console.error('❌ Node.js executable not found:', SERVICE_CONFIG.execPath);
    process.exit(1);
  }

  // Check if config file exists (warn but don't fail)
  if (!existsSync(configPath)) {
    console.warn(`⚠️  Configuration file not found at: ${configPath}`);
    console.warn('The service may not have access to environment variables');
  }

  // Verify we're on Windows
  if (process.platform !== 'win32') {
    console.error('❌ This script can only be used on Windows systems');
    process.exit(1);
  }
}

function showStatus() {
  // For status, we need to check if the service exists and its state
  // This is a simplified check - in a real implementation you might want to query the service manager
  console.log('Service Configuration:');
  console.log('  Name:', SERVICE_CONFIG.name);
  console.log('  Description:', SERVICE_CONFIG.description);
  console.log('  Script:', SERVICE_CONFIG.script);
  console.log('  Environment:', SERVICE_CONFIG.env.map(e => `${e.name}=${e.value}`).join(', '));
  console.log('');
  console.log('To check actual service status, use:');
  console.log('  sc query "iHub Apps"');
}

function showHelp() {
  console.log('iHub Apps Windows Service Manager');
  console.log('');
  console.log('Usage:');
  console.log('  node scripts/windows-service.js <command>');
  console.log('');
  console.log('Commands:');
  console.log('  install    Install the service');
  console.log('  uninstall  Uninstall the service');
  console.log('  start      Start the service');
  console.log('  stop       Stop the service');
  console.log('  restart    Restart the service');
  console.log('  status     Show service configuration');
  console.log('  help       Show this help message');
  console.log('');
  console.log('NPM Scripts:');
  console.log('  npm run service:install');
  console.log('  npm run service:uninstall');
  console.log('  npm run service:start');
  console.log('  npm run service:stop');
  console.log('  npm run service:restart');
  console.log('  npm run service:status');
  console.log('');
  console.log('Note: Administrator privileges are required for service operations');
}

// Main execution
function main() {
  const command = process.argv[2];

  if (!command || command === 'help') {
    showHelp();
    return;
  }

  // Validate environment for most commands
  if (command !== 'help' && command !== 'status') {
    validateEnvironment();
  }

  switch (command.toLowerCase()) {
    case 'install':
      console.log('Installing iHub Apps as Windows Service...');
      console.log('⚠️  Administrator privileges required');
      svc.install();
      break;

    case 'uninstall':
      console.log('Uninstalling iHub Apps Windows Service...');
      console.log('⚠️  Administrator privileges required');
      svc.uninstall();
      break;

    case 'start':
      console.log('Starting iHub Apps service...');
      svc.start();
      break;

    case 'stop':
      console.log('Stopping iHub Apps service...');
      svc.stop();
      break;

    case 'restart':
      console.log('Restarting iHub Apps service...');
      svc.restart();
      break;

    case 'status':
      showStatus();
      break;

    default:
      console.error('❌ Unknown command:', command);
      console.log('');
      showHelp();
      process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', error => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// Run the main function
main();
