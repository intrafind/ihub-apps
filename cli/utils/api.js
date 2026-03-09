/**
 * Utilities for communicating with a running iHub server instance
 */

export function getServerUrl(port = 3000, host = 'localhost') {
  return `http://${host}:${port}`;
}

/**
 * Check if the server is running by calling its health endpoint.
 * Returns health data or null if server is unreachable.
 */
export async function checkHealth(port = 3000, host = 'localhost', timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${getServerUrl(port, host)}/api/health`, {
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Check if a TCP port is available (not in use).
 */
export async function isPortAvailable(port, host = '127.0.0.1') {
  const { createConnection } = await import('net');
  return new Promise(resolve => {
    const socket = createConnection({ port, host });
    socket.on('connect', () => {
      socket.destroy();
      resolve(false); // Port is in use
    });
    socket.on('error', () => {
      resolve(true); // Port is available
    });
  });
}

/**
 * Parse port/host flags from CLI args.
 */
export function parseServerArgs(args) {
  let port = parseInt(process.env.PORT || '3000', 10);
  let host = process.env.HOST || 'localhost';

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--host' && args[i + 1]) {
      host = args[i + 1];
      i++;
    } else if (args[i].startsWith('--port=')) {
      port = parseInt(args[i].split('=')[1], 10);
    } else if (args[i].startsWith('--host=')) {
      host = args[i].split('=')[1];
    }
  }

  return { port, host };
}
