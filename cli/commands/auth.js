/**
 * ihub auth — Authenticate with remote iHub instances using OAuth 2.0
 * Usage: ihub auth <subcommand> [options]
 * Subcommands: login, logout, whoami, refresh
 */
import { spawn } from 'child_process';
import { createServer } from 'http';
import { c, symbols } from '../utils/colors.js';
import {
  loadRemoteConfig,
  saveRemoteConfig,
  remoteRequest,
  setTokenCache,
  clearTokenCache,
  getDisplayUrl
} from '../utils/remote-api.js';
import crypto from 'crypto';

const HELP = `
  ${c.bold('ihub auth')} — Authenticate with remote iHub instances

  ${c.bold('Usage:')}
    ihub auth <subcommand> [options]

  ${c.bold('Subcommands:')}
    login [instance]     Start OAuth 2.0 authentication flow
    logout [instance]    Clear authentication token
    whoami [instance]    Show current authenticated user
    refresh [instance]   Refresh authentication token

  ${c.bold('Options:')}
    --url <url>          Remote instance URL
    --port <port>        Local callback port (default: 8765)
    --no-browser         Don't open browser automatically

  ${c.bold('Examples:')}
    ihub auth login prod
    ihub auth login --url https://ihub.example.com
    ihub auth whoami
    ihub auth logout
`;

/**
 * Generate a random state parameter for OAuth flow
 */
function generateState() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  return { verifier, challenge };
}

/**
 * Open browser to OAuth authorization URL
 */
function openBrowser(url) {
  const platform = process.platform;
  let command, args;

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, {
    stdio: 'ignore',
    detached: true,
    shell: false
  });

  child.on('error', () => {
    // Silently ignore browser launch errors
  });

  child.unref();
}

/**
 * Start OAuth 2.0 authorization flow with PKCE
 */
async function startOAuthFlow(instanceUrl, callbackPort = 8765, noBrowser = false) {
  const { verifier, challenge } = generatePKCE();
  const state = generateState();
  const redirectUri = `http://localhost:${callbackPort}/callback`;

  // Build authorization URL
  const authUrl = new URL('/oauth/authorize', instanceUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', 'ihub-cli');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'read write');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  console.log(`${symbols.info} Starting OAuth 2.0 authentication flow...`);
  console.log(`  ${c.gray('Callback port:')} ${callbackPort}`);
  console.log('');

  if (!noBrowser) {
    console.log(`${symbols.info} Opening browser for authorization...`);
    openBrowser(authUrl.toString());
  } else {
    console.log(`${symbols.info} Please open this URL in your browser:`);
    console.log('');
    console.log(`  ${c.cyan(authUrl.toString())}`);
  }

  console.log('');
  console.log(`  Waiting for authorization...`);

  // Start local callback server
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${callbackPort}`);

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        // Check for errors
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                <h1 style="color: #dc2626;">❌ Authorization Failed</h1>
                <p>Error: ${error}</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        // Validate state to prevent CSRF
        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                <h1 style="color: #dc2626;">❌ Invalid State</h1>
                <p>Security validation failed. Please try again.</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          server.close();
          reject(new Error('Invalid OAuth state parameter'));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                <h1 style="color: #dc2626;">❌ Missing Authorization Code</h1>
                <p>No authorization code received.</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        // Exchange authorization code for access token
        try {
          const tokenResponse = await remoteRequest(
            instanceUrl,
            '/oauth/token',
            {
              method: 'POST',
              body: JSON.stringify({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                client_id: 'ihub-cli',
                code_verifier: verifier
              })
            },
            { token: null, sslVerify: true, timeout: 10000 }
          );

          const tokenData = await tokenResponse.json();

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                <h1 style="color: #10b981;">✓ Authentication Successful</h1>
                <p>You are now logged in to iHub.</p>
                <p>You can close this window and return to the CLI.</p>
              </body>
            </html>
          `);

          server.close();
          resolve(tokenData);
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: sans-serif; padding: 40px; text-align: center;">
                <h1 style="color: #dc2626;">❌ Token Exchange Failed</h1>
                <p>Error: ${error.message}</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          server.close();
          reject(error);
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    server.listen(callbackPort, '127.0.0.1', () => {
      // Server started successfully
    });

    server.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${callbackPort} is already in use. Try a different port with --port`));
      } else {
        reject(err);
      }
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Authentication timeout after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

/**
 * Login command - start OAuth flow
 */
async function login(args) {
  let instanceName = null;
  let url = null;
  let callbackPort = 8765;
  let noBrowser = false;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (args[i].startsWith('--url=')) {
      url = args[i].split('=')[1];
    } else if (args[i] === '--port' && args[i + 1]) {
      callbackPort = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i].startsWith('--port=')) {
      callbackPort = parseInt(args[i].split('=')[1], 10);
    } else if (args[i] === '--no-browser') {
      noBrowser = true;
    } else if (!args[i].startsWith('--')) {
      instanceName = args[i];
    }
  }

  // Load instance from config if name provided
  if (instanceName && !url) {
    const config = loadRemoteConfig();
    const instance = config.instances[instanceName];

    if (!instance) {
      console.error(`${symbols.error} Remote instance not found: ${instanceName}`);
      console.error(`  Available instances: ${Object.keys(config.instances).join(', ') || '(none)'}`);
      process.exit(1);
    }

    url = instance.url;
  }

  // Use default instance if no URL or name provided
  if (!url) {
    const config = loadRemoteConfig();
    if (config.defaultInstance && config.instances[config.defaultInstance]) {
      instanceName = config.defaultInstance;
      url = config.instances[config.defaultInstance].url;
    } else {
      console.error(`${symbols.error} No remote instance specified`);
      console.error(`  Use: ihub auth login <instance> or --url <url>`);
      console.error(`  Or add a remote instance with: ${c.cyan('ihub remote add')}`);
      process.exit(1);
    }
  }

  console.log(`${symbols.info} Authenticating with ${c.cyan(getDisplayUrl(url))}`);
  console.log('');

  try {
    const tokenData = await startOAuthFlow(url, callbackPort, noBrowser);

    console.log('');
    console.log(`${symbols.success} Authentication successful`);

    // Save token to instance config
    if (instanceName) {
      const config = loadRemoteConfig();
      if (config.instances[instanceName]) {
        config.instances[instanceName].token = tokenData.access_token;
        if (tokenData.refresh_token) {
          config.instances[instanceName].refresh_token = tokenData.refresh_token;
        }
        config.instances[instanceName].token_expires_at = tokenData.expires_in
          ? Date.now() + tokenData.expires_in * 1000
          : null;

        saveRemoteConfig(config);
        console.log(`  ${c.gray('Saved token to instance:')} ${instanceName}`);
      }
    }

    // Set token in cache for current session
    setTokenCache(tokenData.access_token);

    console.log(`  ${c.gray('Token expires:')} ${tokenData.expires_in ? `${Math.floor(tokenData.expires_in / 3600)}h ${Math.floor((tokenData.expires_in % 3600) / 60)}m` : 'never'}`);
  } catch (error) {
    console.error('');
    console.error(`${symbols.error} Authentication failed: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Logout command - clear authentication token
 */
async function logout(args) {
  const instanceName = args[0];

  if (instanceName) {
    const config = loadRemoteConfig();

    if (!config.instances[instanceName]) {
      console.error(`${symbols.error} Remote instance not found: ${instanceName}`);
      process.exit(1);
    }

    delete config.instances[instanceName].token;
    delete config.instances[instanceName].refresh_token;
    delete config.instances[instanceName].token_expires_at;

    saveRemoteConfig(config);
    console.log(`${symbols.success} Logged out from ${c.cyan(instanceName)}`);
  } else {
    // Clear session cache
    clearTokenCache();
    console.log(`${symbols.success} Cleared session token`);
  }
}

/**
 * Whoami command - show current authenticated user
 */
async function whoami(args) {
  let instanceName = null;
  let url = null;
  let token = null;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (!args[i].startsWith('--')) {
      instanceName = args[i];
    }
  }

  // Load instance from config
  if (instanceName) {
    const config = loadRemoteConfig();
    const instance = config.instances[instanceName];

    if (!instance) {
      console.error(`${symbols.error} Remote instance not found: ${instanceName}`);
      process.exit(1);
    }

    url = instance.url;
    token = instance.token;
  } else if (!url) {
    const config = loadRemoteConfig();
    if (config.defaultInstance && config.instances[config.defaultInstance]) {
      instanceName = config.defaultInstance;
      url = config.instances[config.defaultInstance].url;
      token = config.instances[config.defaultInstance].token;
    }
  }

  if (!url) {
    console.error(`${symbols.error} No remote instance specified`);
    process.exit(1);
  }

  if (!token) {
    console.error(`${symbols.error} Not authenticated. Run: ${c.cyan('ihub auth login')}`);
    process.exit(1);
  }

  try {
    const response = await remoteRequest(url, '/api/auth/me', { method: 'GET' }, { token, sslVerify: true });
    const user = await response.json();

    console.log('');
    console.log(`  ${c.bold('Authenticated User')}`);
    console.log(`  ${c.gray('─'.repeat(40))}`);
    console.log(`  ${c.gray('Instance:')} ${instanceName || getDisplayUrl(url)}`);
    console.log(`  ${c.gray('Username:')} ${user.username || user.email || user.id}`);

    if (user.name) {
      console.log(`  ${c.gray('Name:')}     ${user.name}`);
    }

    if (user.groups && user.groups.length > 0) {
      console.log(`  ${c.gray('Groups:')}   ${user.groups.join(', ')}`);
    }

    console.log('');
  } catch (error) {
    console.error(`${symbols.error} Failed to get user info: ${error.message}`);
    process.exit(1);
  }
}

export default async function auth(args) {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP);
    return;
  }

  switch (subcommand) {
    case 'login':
      await login(rest);
      break;
    case 'logout':
      await logout(rest);
      break;
    case 'whoami':
    case 'who':
      await whoami(rest);
      break;
    default:
      console.error(`${symbols.error} Unknown subcommand: ${subcommand}`);
      console.error(`  Run ${c.cyan('ihub auth --help')} for usage`);
      process.exit(1);
  }
}
