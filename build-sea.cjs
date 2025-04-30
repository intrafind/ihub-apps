/**
 * Build script for Node.js Single Executable Application (SEA)
 * This uses a simpler approach to avoid postject issues
 * 
 * Requires Node.js 20.0.0 or later
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// Configuration
const version = require('./package.json').version;
console.log(`Building for version: ${version}`);
const appName = 'ai-hub-apps';
const outputDir = path.join(__dirname, 'dist-bin');
const contentsDir = path.join(__dirname, 'contents');
const clientPublicDir = path.join(__dirname, 'client/dist');
const serverDir = path.join(__dirname, 'server');
const examplesDir = path.join(__dirname, 'examples');
const configEnvPath = path.join(__dirname, 'config.env');

// Platform specific details
const platformMap = {
  win32: { suffix: 'win.exe', platform: 'windows' },
  darwin: { suffix: 'macos', platform: 'macos' },
  linux: { suffix: 'linux', platform: 'linux' }
};

// Check for platform override via command line argument
const platformArg = process.argv.find(arg => arg.startsWith('--platform='));
const forcedPlatform = platformArg ? platformArg.split('=')[1] : null;

let currentPlatform;
if (forcedPlatform && platformMap[forcedPlatform]) {
  console.log(`Using forced platform: ${forcedPlatform}`);
  currentPlatform = platformMap[forcedPlatform];
} else {
  currentPlatform = platformMap[os.platform()];
}

if (!currentPlatform) {
  console.error(`Unsupported platform: ${forcedPlatform || os.platform()}`);
  process.exit(1);
}

const outputName = `${appName}-v${version}-${currentPlatform.suffix}`;
const outputPath = path.join(outputDir, outputName);

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Build client first
console.log('Building client...');
try {
  execSync('cd client && npm run build', { stdio: 'inherit' });
  console.log('Client build complete.');
} catch (err) {
  console.error('Error building client:', err);
  process.exit(1);
}

// Create a simplified launcher script
console.log('Creating launcher script...');
const launcherScript = `#!/usr/bin/env node

// Set production environment
process.env.NODE_ENV = 'production';

// Essential dependencies
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const http = require('http');
const net = require('net');

// Get the directory of this script
const binDir = path.dirname(process.execPath);
console.log(\`Binary directory: \${binDir}\`);

// Set APP_ROOT_DIR environment variable for server.js
process.env.APP_ROOT_DIR = binDir;

// Load config.env if available
const configPath = path.join(binDir, 'config.env');
if (fs.existsSync(configPath)) {
  console.log('Found config.env, loading configuration...');
  try {
    const configContent = fs.readFileSync(configPath, 'utf8');
    const configLines = configContent.split('\\n');
    
    configLines.forEach(line => {
      if (line.trim().startsWith('#') || !line.trim()) return;
      
      const match = line.match(/^\\s*([\\w.-]+)\\s*=\\s*([^#]*)?\s*(?:#.*)?$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        value = value.trim().replace(/^['"]|['"]$/g, '');
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
process.env.PORT = process.env.PORT || '3001'; // Changed default to 3001 to avoid common port conflicts

const PORT = parseInt(process.env.PORT, 10);
const HOST = process.env.HOST;

console.log(\`Starting server with NODE_ENV=\${process.env.NODE_ENV}\`);
console.log(\`Server will run with HOST=\${HOST} and PORT=\${PORT}\`);

// Function to check if a port is in use
function isPortInUse(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer()
      .once('error', err => {
        if (err.code === 'EADDRINUSE') {
          console.log(\`Port \${port} is already in use.\`);
          resolve(true);
        } else {
          resolve(false);
        }
      })
      .once('listening', () => {
        server.close();
        resolve(false);
      })
      .listen(port, host);
  });
}

// Function to kill processes using a specific port (macOS only)
async function killProcessOnPort(port) {
  if (process.platform !== 'darwin') return false;
  
  try {
    console.log(\`Attempting to kill process using port \${port}...\`);
    const { exec } = require('child_process');
    
    return new Promise((resolve) => {
      // First, find the process ID using the port
      exec(\`lsof -i :\${port} -t\`, (error, stdout) => {
        if (error) {
          console.log(\`No process found using port \${port}\`);
          resolve(false);
          return;
        }
        
        const pid = stdout.trim();
        if (pid) {
          console.log(\`Found process \${pid} using port \${port}, attempting to terminate it...\`);
          // Kill the process
          exec(\`kill -9 \${pid}\`, (killError) => {
            if (killError) {
              console.error(\`Failed to kill process \${pid}: \${killError.message}\`);
              resolve(false);
            } else {
              console.log(\`Successfully terminated process \${pid}\`);
              resolve(true);
            }
          });
        } else {
          resolve(false);
        }
      });
    });
  } catch (err) {
    console.error(\`Error trying to kill process on port \${port}:\`, err);
    return false;
  }
}

// Create a temporary HTTP server to help free the port
function createTemporaryServer(port, host) {
  return new Promise((resolve) => {
    const tempServer = http.createServer();
    
    // Enable socket reuse options to handle TIME_WAIT state on macOS
    if (process.platform === 'darwin') {
      tempServer.on('listening', () => {
        const serverSocket = tempServer._handle;
        if (serverSocket && typeof serverSocket.setSimultaneousAccepts === 'function') {
          // Set SO_REUSEADDR on the socket to help with TIME_WAIT issues
          serverSocket.setSimultaneousAccepts(true);
        }
      });
    }
    
    tempServer.on('error', (err) => {
      console.log(\`Error creating temporary server: \${err.message}\`);
      resolve(false);
    });
    
    tempServer.listen(port, host, () => {
      console.log(\`Created temporary server on port \${port} to free it up\`);
      tempServer.close(() => {
        console.log(\`Temporary server closed, port \${port} should now be free\`);
        resolve(true);
      });
    });
  });
}

// Start the server
async function startServer() {
  try {
    // Check if port is in use before starting
    const portInUse = await isPortInUse(PORT, HOST);
    
    if (portInUse) {
      console.log(\`Port \${PORT} is already in use. Attempting to resolve...\`);
      
      // Try to kill the process using the port (macOS only)
      if (process.platform === 'darwin') {
        await killProcessOnPort(PORT);
        
        // Wait a moment for the port to be released
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Try to "refresh" the port by quickly binding and unbinding
        await createTemporaryServer(PORT, HOST);
        
        // Check again after our best efforts
        const stillInUse = await isPortInUse(PORT, HOST);
        if (stillInUse) {
          console.error(\`Port \${PORT} is still in use after attempting to free it. Please close the application using this port or specify a different port in config.env.\`);
          process.exit(1);
        }
      } else {
        console.error(\`Port \${PORT} is already in use. Please close the application using this port or specify a different port in config.env.\`);
        process.exit(1);
      }
    }
    
    const serverPath = path.join(binDir, 'server', 'server.js');
    
    if (!fs.existsSync(serverPath)) {
      console.error(\`Error: Server file not found at \${serverPath}\`);
      process.exit(1);
    }
    
    console.log(\`Server path: \${serverPath}\`);
    
    // Start the server as a child process
    const nodeProcess = spawn(process.execPath, [serverPath], {
      stdio: 'inherit',
      env: process.env,
      detached: false // Ensure the child process is terminated when parent exits
    });
    
    // Keep track of whether we're in shutdown mode
    let shuttingDown = false;
    
    // Handle server process events
    nodeProcess.on('error', (err) => {
      console.error(\`Failed to start server process: \${err}\`);
      process.exit(1);
    });
    
    nodeProcess.on('close', (code) => {
      console.log(\`Server process exited with code \${code}\`);
      if (!shuttingDown) {
        process.exit(code);
      }
    });
    
    // Enhanced graceful shutdown handling
    function gracefulShutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      
      console.log(\`Received \${signal}. Shutting down server gracefully...\`);
      
      // Set a timeout for forced shutdown
      const forceExitTimer = setTimeout(() => {
        console.log('Forcing exit after timeout...');
        process.exit(1);
      }, 5000); // Force exit after 5 seconds
      
      // Try to kill the child process gracefully
      nodeProcess.kill(signal);
      
      // Register handler for when the process actually exits
      nodeProcess.on('exit', () => {
        clearTimeout(forceExitTimer);
        
        // Create a quick temporary server to ensure the port is released
        if (process.platform === 'darwin') {
          console.log('Running on macOS: Making extra effort to free port before exiting...');
          killProcessOnPort(PORT).then(() => {
            createTemporaryServer(PORT, HOST).then(() => {
              console.log('Server process terminated successfully and port freed.');
              process.exit(0);
            });
          });
        } else {
          console.log('Server process terminated successfully.');
          process.exit(0);
        }
      });
    }
    
    // Set up signal handlers
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (err) => {
      console.error('Uncaught exception:', err);
      gracefulShutdown('SIGTERM');
    });
    
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
}

// Start the server
startServer();`;

// Build our application manually instead of using Node.js SEA
console.log(`Building standalone executable for ${currentPlatform.platform}...`);
try {
  // Create the output directory structure
  console.log('Creating output directory structure...');
  
  // Copy server files
  fs.mkdirSync(path.join(outputDir, 'server'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'server', 'adapters'), { recursive: true });
  
  // Copy all server JS files
  fs.readdirSync(serverDir).forEach(file => {
    if (file.endsWith('.js') || file.endsWith('.cjs')) {
      fs.copyFileSync(
        path.join(serverDir, file),
        path.join(outputDir, 'server', file)
      );
    }
  });
  
  // Copy adapter files
  fs.readdirSync(path.join(serverDir, 'adapters')).forEach(file => {
    if (file.endsWith('.js')) {
      fs.copyFileSync(
        path.join(serverDir, 'adapters', file),
        path.join(outputDir, 'server', 'adapters', file)
      );
    }
  });
  
  // Create a package.json for the server
  const serverPackageJson = {
    name: 'ai-hub-apps-server',
    version,
    private: true,
    type: 'module',
    dependencies: require('./server/package.json').dependencies
  };
  
  fs.writeFileSync(
    path.join(outputDir, 'server', 'package.json'),
    JSON.stringify(serverPackageJson, null, 2)
  );
  
  // Install server dependencies
  console.log('Installing server dependencies...');
  execSync('npm install --omit=dev', {
    cwd: path.join(outputDir, 'server'),
    stdio: 'inherit'
  });
  
  // Copy supporting files
  console.log('Copying supporting files...');
  
  // Copy config.env if it exists
  if (fs.existsSync(configEnvPath)) {
    fs.copyFileSync(configEnvPath, path.join(outputDir, 'config.env'));
  }
  
  // Copy contents
  fs.cpSync(contentsDir, path.join(outputDir, 'contents'), { recursive: true });
  
  // Copy examples
  fs.cpSync(examplesDir, path.join(outputDir, 'examples'), { recursive: true });
  
  // Copy client public files
  fs.cpSync(clientPublicDir, path.join(outputDir, 'public'), { recursive: true });
  
  // Create a simple launcher shell script on Unix platforms
  if (os.platform() !== 'win32') {
    const shellLauncher = `#!/bin/bash
# AI Hub Apps Launcher

# Get the directory where this script is located
DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

# Use the bundled Node.js to run the server
"\${DIR}/node" "\${DIR}/launcher.cjs" "\$@"
`;
    
    fs.writeFileSync(path.join(outputDir, outputName), shellLauncher);
    fs.chmodSync(path.join(outputDir, outputName), 0o755);
  } else {
    // On Windows, create a batch file
    const batchLauncher = `@echo off
REM AI Hub Apps Launcher
set DIR=%~dp0
"%DIR%node.exe" "%DIR%launcher.cjs" %*
`;
    
    fs.writeFileSync(path.join(outputDir, outputName), batchLauncher);
  }
  
  // Write the launcher script
  fs.writeFileSync(path.join(outputDir, 'launcher.cjs'), launcherScript);
  
  // Copy Node.js binary
  console.log('Copying Node.js executable...');
  fs.copyFileSync(process.execPath, path.join(outputDir, 'node'));
  fs.chmodSync(path.join(outputDir, 'node'), 0o755);
  
  console.log('Standalone application build completed successfully.');
} catch (err) {
  console.error('Error building standalone application:', err);
  console.error(err.stack);
  process.exit(1);
}

// Success message
console.log(`
Build completed successfully!
  
Executable: ${outputPath}
  
To run the application:
1. Navigate to the dist-bin directory: cd ${outputDir}
2. Run the executable: ./${outputName}
`);

console.log('Done!');