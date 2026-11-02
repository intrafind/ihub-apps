// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import WebSocket from 'ws';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { getWebSocketTlsOptions } from '../../utils/httpConfig.js';

const SUBPROTOCOL = 'mcp';

/**
 * MCP client transport over a WebSocket, dialed with `ws`.
 *
 * The SDK's `WebSocketClientTransport` uses the global `WebSocket`, which takes
 * no TLS options, so a `wss://` MCP server behind a private CA failed with
 * "unable to verify the first certificate" even when its host was on
 * `ssl.domainWhitelist`. This transport speaks the same protocol (subprotocol
 * `mcp`, one JSON-RPC message per text frame) and merges
 * `getWebSocketTlsOptions(url)` into the socket options, so the whitelist
 * applies exactly as it does for HTTP(S) and the realtime transcription socket.
 *
 * Implements the SDK `Transport` interface: `start`, `send`, `close`, and the
 * `onmessage` / `onerror` / `onclose` callbacks.
 */
export class McpWebSocketTransport {
  /**
   * @param {URL|string} url - The `ws://` or `wss://` endpoint
   * @param {Object} [options]
   * @param {Function} [options.WebSocketImpl] - Constructor to dial with (tests)
   * @param {Object} [options.sslConfig] - SSL config override (tests); defaults to the platform's
   */
  constructor(url, { WebSocketImpl = WebSocket, sslConfig = null } = {}) {
    this._url = typeof url === 'string' ? url : url.href;
    this._WebSocket = WebSocketImpl;
    this._sslConfig = sslConfig;
    this._socket = null;
  }

  /** Options handed to the `ws` constructor; exposed for tests. */
  socketOptions() {
    return { ...getWebSocketTlsOptions(this._url, this._sslConfig) };
  }

  start() {
    if (this._socket) {
      throw new Error(
        'McpWebSocketTransport already started. Client.connect() calls start() itself.'
      );
    }
    return new Promise((resolve, reject) => {
      let opened = false;
      const socket = new this._WebSocket(this._url, SUBPROTOCOL, this.socketOptions());
      this._socket = socket;

      socket.on('open', () => {
        opened = true;
        resolve();
      });
      socket.on('error', error => {
        const err = error instanceof Error ? error : new Error(`WebSocket error: ${error}`);
        if (!opened) reject(err);
        this.onerror?.(err);
      });
      socket.on('close', () => {
        this._socket = null;
        this.onclose?.();
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) return;
        let message;
        try {
          message = JSONRPCMessageSchema.parse(JSON.parse(data.toString()));
        } catch (error) {
          this.onerror?.(error);
          return;
        }
        this.onmessage?.(message);
      });
    });
  }

  async close() {
    this._socket?.close();
  }

  send(message) {
    return new Promise((resolve, reject) => {
      if (!this._socket) {
        reject(new Error('Not connected'));
        return;
      }
      this._socket.send(JSON.stringify(message), error => (error ? reject(error) : resolve()));
    });
  }
}

export default McpWebSocketTransport;
