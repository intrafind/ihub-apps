// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import WebSocket from 'ws';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { getWebSocketTlsOptions } from '../../utils/httpConfig.js';

const SUBPROTOCOL = 'mcp';
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30000;

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
   * @param {number} [options.handshakeTimeoutMs] - Absolute upper bound for the opening
   *   handshake, so `start()` cannot stay pending when a server accepts the TCP connection but
   *   never upgrades, or keeps the connection busy without upgrading
   */
  constructor(
    url,
    {
      WebSocketImpl = WebSocket,
      sslConfig = null,
      handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS
    } = {}
  ) {
    this._url = typeof url === 'string' ? url : url.href;
    this._WebSocket = WebSocketImpl;
    this._sslConfig = sslConfig;
    this._handshakeTimeoutMs = handshakeTimeoutMs;
    this._socket = null;
  }

  /** Options handed to the `ws` constructor; exposed for tests. */
  socketOptions() {
    return {
      handshakeTimeout: this._handshakeTimeoutMs,
      ...getWebSocketTlsOptions(this._url, this._sslConfig)
    };
  }

  start() {
    if (this._socket) {
      throw new Error(
        'McpWebSocketTransport already started. Client.connect() calls start() itself.'
      );
    }
    return new Promise((resolve, reject) => {
      let opened = false;
      let settled = false;
      const socket = new this._WebSocket(this._url, SUBPROTOCOL, this.socketOptions());
      this._socket = socket;

      // `ws`'s handshakeTimeout is an inactivity timer: a server that keeps
      // sending something (1xx informational responses, a trickle of bytes)
      // resets it forever. This deadline is absolute.
      const deadline = setTimeout(() => {
        if (opened || settled) return;
        settled = true;
        reject(new Error(`WebSocket handshake timed out after ${this._handshakeTimeoutMs} ms`));
        socket.terminate?.();
      }, this._handshakeTimeoutMs);
      deadline.unref?.();

      socket.on('open', () => {
        clearTimeout(deadline);
        if (settled) return;
        opened = true;
        settled = true;
        resolve();
      });
      socket.on('error', error => {
        clearTimeout(deadline);
        const err = error instanceof Error ? error : new Error(`WebSocket error: ${error}`);
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.onerror?.(err);
      });
      socket.on('close', () => {
        clearTimeout(deadline);
        this._socket = null;
        if (!settled) {
          settled = true;
          reject(new Error('WebSocket closed before the handshake completed'));
        }
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
