// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `requestState` of the MCP gateway's multi-round-trip calls.
 *
 * A tool call that asks the client for input (an approval through elicitation)
 * returns `input_required` with an opaque `requestState`, which the client
 * echoes byte for byte when it retries the call with the answers. The state
 * round-trips through the client, so it is signed: HMAC-SHA256 under a key
 * derived from the server's encryption key, which every worker and every pod
 * of one installation shares, with an expiry. A state that fails the check is
 * refused by the SDK (`-32602`) before the tool handler runs.
 *
 * What the state proves is that the gateway itself asked: an approval counts
 * only when it answers a request the gateway issued for this caller, this tool
 * and these arguments. Without it, a client could put an "approved" answer
 * into its very first call and skip the person entirely.
 *
 * @module services/mcp/gatewayRequestState
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createRequestStateCodec } from '@modelcontextprotocol/server';
import { compareCodeUnits } from '../../../shared/toolApproval.js';
import tokenStorageService from '../TokenStorageService.js';

const KEY_LABEL = 'ihub:mcp-gateway:request-state:v1';

/** How long a person has to answer before the round has to start over. */
export const REQUEST_STATE_TTL_SECONDS = 15 * 60;

/** Used only until the encryption key is initialized (tests, early boot). */
const PROCESS_FALLBACK_KEY = randomBytes(32);

/** The codec per encryption key (one entry in practice). */
const codecs = new Map();

function stateKey(encryptionKey) {
  if (typeof encryptionKey !== 'string' || !encryptionKey) return PROCESS_FALLBACK_KEY;
  return createHmac('sha256', Buffer.from(encryptionKey, 'hex')).update(KEY_LABEL).digest();
}

/**
 * The codec that mints and verifies the gateway's request state.
 *
 * @returns {{mint: (payload: Object) => Promise<string>, verify: Function}}
 */
export function gatewayRequestStateCodec() {
  const encryptionKey = tokenStorageService?.encryptionKey || '';
  let codec = codecs.get(encryptionKey);
  if (!codec) {
    codec = createRequestStateCodec({
      key: stateKey(encryptionKey),
      ttlSeconds: REQUEST_STATE_TTL_SECONDS
    });
    // A rotated encryption key replaces the old entry.
    codecs.clear();
    codecs.set(encryptionKey, codec);
  }
  return codec;
}

/**
 * A digest of a tool call's arguments, key order ignored, so a state minted
 * for one set of arguments does not approve another.
 *
 * @param {unknown} args
 * @returns {string}
 */
export function argumentsDigest(args) {
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          // Code-unit order, not the locale's: every worker must produce the
          // same digest for the same arguments.
          .sort(compareCodeUnits)
          .map(key => [key, canonical(value[key])])
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(args ?? {})))
    .digest('base64url');
}
