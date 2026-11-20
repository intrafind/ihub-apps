// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A forward proxy on 127.0.0.1 that records what passes through it, for tests
 * of outbound connections that must honour the platform's proxy settings.
 *
 * It forwards plain http requests (`GET http://host/path`, as a client sends
 * them to a proxy) and tunnels https with `CONNECT host:port`. It does not
 * look into a tunnel.
 *
 * @module tests/support/recordingProxy
 */
import http from 'node:http';
import net from 'node:net';

/**
 * Start the proxy.
 *
 * @returns {Promise<{url: string, port: number,
 *   requests: Array<{kind: 'forward'|'connect', method: string, target: string, headers: Object}>,
 *   close: () => Promise<void>}>} `requests` holds one entry per forwarded
 *   request or opened tunnel, oldest first; `target` is the absolute URL, or
 *   `host:port` for a tunnel.
 *
 * @example
 * const proxy = await startRecordingProxy();
 * // platformConfig: { proxy: { http: proxy.url } }
 * assert.equal(proxy.requests[0].target, 'http://127.0.0.1:9000/bucket/key');
 * await proxy.close();
 */
export async function startRecordingProxy() {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    requests.push({
      kind: 'forward',
      method: req.method,
      target: req.url,
      headers: { ...req.headers }
    });
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      return void res.end('not a proxy request');
    }
    const headers = { ...req.headers };
    // Hop-by-hop: meant for the proxy, not for the origin.
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers
      },
      answer => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      }
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on('connect', (req, clientSocket, head) => {
    requests.push({
      kind: 'connect',
      method: 'CONNECT',
      target: req.url,
      headers: { ...req.headers }
    });
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    sockets.add(upstream);
    const end = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on('error', end);
    clientSocket.on('error', end);
    upstream.on('close', () => sockets.delete(upstream));
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise(resolve => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  };
}
