// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The MCP `websocket` transport honors ssl.ignoreInvalidCertificates +
 * ssl.domainWhitelist: a `wss://` server with a self-signed certificate is
 * reachable when its host is whitelisted and refused when it is not.
 */

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { McpWebSocketTransport } from '../../services/mcp/McpWebSocketTransport.js';

let httpsServer;
let wss;
let port;
let certDir;
let lastProtocol;

beforeAll(async () => {
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ws-tls-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-keyout',
      path.join(certDir, 'key.pem'),
      '-out',
      path.join(certDir, 'cert.pem')
    ],
    { stdio: 'ignore' }
  );
  httpsServer = https.createServer({
    key: fs.readFileSync(path.join(certDir, 'key.pem')),
    cert: fs.readFileSync(path.join(certDir, 'cert.pem'))
  });
  wss = new WebSocketServer({ server: httpsServer });
  wss.on('connection', (socket, req) => {
    lastProtocol = req.headers['sec-websocket-protocol'];
    socket.on('message', data => {
      const msg = JSON.parse(data.toString());
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.method } }));
    });
  });
  await new Promise(resolve => httpsServer.listen(0, '127.0.0.1', resolve));
  port = httpsServer.address().port;
});

afterAll(async () => {
  wss.close();
  await new Promise(resolve => httpsServer.close(resolve));
  fs.rmSync(certDir, { recursive: true, force: true });
});

const ssl = domainWhitelist => ({ ignoreInvalidCertificates: true, domainWhitelist });

describe('McpWebSocketTransport and the SSL whitelist', () => {
  test('reaches a whitelisted wss host with a self-signed certificate', async () => {
    const transport = new McpWebSocketTransport(`wss://localhost:${port}/mcp`, {
      sslConfig: ssl(['localhost'])
    });
    const received = new Promise(resolve => {
      transport.onmessage = resolve;
    });
    await transport.start();
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await expect(received).resolves.toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { echoed: 'tools/list' }
    });
    expect(lastProtocol).toBe('mcp');
    await transport.close();
  });

  test('refuses a wss host that is not whitelisted', async () => {
    const transport = new McpWebSocketTransport(`wss://localhost:${port}/mcp`, {
      sslConfig: ssl(['other.example'])
    });
    const errors = [];
    transport.onerror = err => errors.push(err);
    await expect(transport.start()).rejects.toThrow(/self[- ]signed|certificate/i);
    expect(errors).toHaveLength(1);
  });

  test('passes no TLS bypass for plain ws:// or with the switch off', () => {
    expect(
      new McpWebSocketTransport('ws://localhost:1/mcp', {
        sslConfig: ssl(['localhost'])
      }).socketOptions()
    ).toEqual({});
    expect(
      new McpWebSocketTransport('wss://localhost:1/mcp', {
        sslConfig: { ignoreInvalidCertificates: false, domainWhitelist: ['localhost'] }
      }).socketOptions()
    ).toEqual({});
  });

  test('send before start is refused', async () => {
    const transport = new McpWebSocketTransport('wss://localhost:1/mcp');
    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow(
      'Not connected'
    );
  });
});
