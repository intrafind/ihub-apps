// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Reads the C2PA (Content Credentials) manifest of an image or audio file
 * (#3328), to record what the provider embedded and to answer an upload.
 *
 * The reader is `@contentauth/c2pa-wasm` (c2pa-rs compiled to WebAssembly): no
 * native binary, no install script. It is loaded lazily, once.
 *
 * **No network, by construction.** The reader is configured with remote
 * manifest fetch, OCSP and trust-list verification switched off, so it makes no
 * outbound request and nothing can bypass `ssl.ignoreInvalidCertificates` /
 * `ssl.domainWhitelist` (CLAUDE.md, "Outbound Connections"). A manifest that
 * only exists remotely is not fetched; the file is reported by what it carries.
 *
 * **Trust is not evaluated.** `valid` means the signature and the binding to
 * the file's bytes check out, not that the signer is trusted. Results always
 * carry `trust: "not-evaluated"`, and the wording built on them must never say
 * "authentic".
 *
 * When the WebAssembly reader cannot load, or throws on a file, the
 * dependency-free presence check ({@link detectC2paPresence}) answers
 * `present` only (`status: "present"`, `valid: null`, `reader: "presence"`).
 *
 * @module services/provenance/c2paReader
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import logger from '../../utils/logger.js';
import { detectC2paPresence } from './c2paPresence.js';
import { sniffMedia } from './mediaSniff.js';

const COMPONENT = 'C2paReader';

/** Reader settings: nothing may leave the process (see the module comment). */
export const C2PA_READER_CONTEXT = Object.freeze({
  verify: Object.freeze({
    remote_manifest_fetch: false,
    ocsp_fetch: false,
    verify_trust: false
  })
});

/** Trust is never evaluated by this reader. */
export const TRUST_NOT_EVALUATED = 'not-evaluated';

/** Media types the reader is given (c2pa-rs format names). */
const READER_FORMATS = Object.freeze({
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
  'image/tiff': 'image/tiff',
  'image/heic': 'image/heic',
  'image/avif': 'image/avif',
  'audio/wav': 'audio/wav',
  'audio/mpeg': 'audio/mpeg',
  'audio/mp4': 'audio/mp4'
});

let wasmPromise = null;

/** Load the wasm module once; resolves null when it cannot be loaded. */
function loadWasm() {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      try {
        const require = createRequire(import.meta.url);
        const wasmPath = require.resolve('@contentauth/c2pa-wasm/c2pa.wasm');
        const mod = await import('@contentauth/c2pa-wasm');
        mod.initSync({ module: fs.readFileSync(wasmPath) });
        return mod;
      } catch (error) {
        logger.warn('The C2PA reader could not be loaded; falling back to presence detection', {
          component: COMPONENT,
          error: error.message
        });
        return null;
      }
    })();
  }
  return wasmPromise;
}

/** Test hook: forget the loaded module. */
export function resetC2paReaderForTests() {
  wasmPromise = null;
}

/** The result for a file without any manifest. */
function absent(extra = {}) {
  return {
    present: false,
    status: 'absent',
    valid: null,
    issuer: null,
    digitalSourceType: null,
    claimGenerator: null,
    signedAt: null,
    trust: TRUST_NOT_EVALUATED,
    ...extra
  };
}

/** `c2pa.created` / `c2pa.placed` ... action's digital source type, first found. */
function sourceTypeOf(manifest) {
  for (const assertion of manifest?.assertions || []) {
    if (!String(assertion?.label || '').startsWith('c2pa.actions')) continue;
    for (const action of assertion?.data?.actions || []) {
      if (typeof action?.digitalSourceType === 'string') return action.digitalSourceType;
    }
  }
  return null;
}

function claimGeneratorOf(manifest) {
  const info = manifest?.claim_generator_info;
  if (Array.isArray(info) && info[0]?.name) {
    return [info[0].name, info[0].version].filter(Boolean).join(' ');
  }
  return typeof manifest?.claim_generator === 'string' ? manifest.claim_generator : null;
}

/** Summarise a wasm reader into the record/response shape. */
function summarise(reader) {
  const store = reader.manifestStore();
  const manifest = reader.activeManifest();
  if (!manifest) return absent();
  const state = String(store?.validation_state || '');
  // "Valid" and "Trusted" both mean signature and binding hold; "Invalid" does not.
  const valid =
    state === 'Invalid' ? false : state === 'Valid' || state === 'Trusted' ? true : null;
  return {
    present: true,
    status: 'present',
    valid,
    issuer: manifest.signature_info?.issuer ?? manifest.signature_info?.common_name ?? null,
    digitalSourceType: sourceTypeOf(manifest),
    claimGenerator: claimGeneratorOf(manifest),
    signedAt: manifest.signature_info?.time ?? null,
    trust: TRUST_NOT_EVALUATED
  };
}

/**
 * Read the C2PA manifest of a file.
 *
 * `status` is `present` | `absent` | `unsupported_format` | `unreadable`;
 * `valid` is true / false / null (null: no manifest, or presence-only fallback).
 * Never throws and never touches the network.
 *
 * @param {Buffer} buffer - The file bytes.
 * @param {Object} [options]
 * @param {string} [options.mimeType] - Known type; sniffed from the bytes otherwise.
 * @returns {Promise<{present: boolean, status: string, valid: boolean|null, issuer: string|null, digitalSourceType: string|null, claimGenerator: string|null, signedAt: string|null, trust: string, xmpDigitalSourceType?: string|null, reader?: string}>}
 */
export async function readC2pa(buffer, { mimeType } = {}) {
  const sniffed = sniffMedia(buffer);
  const type = sniffed?.mimeType || mimeType;
  const format = READER_FORMATS[type];
  if (!format) return absent({ status: 'unsupported_format' });

  // The container walk is cheap; it also yields the XMP digital source type.
  const presence = detectC2paPresence(buffer, sniffed?.container);
  const xmpDigitalSourceType = presence.digitalSourceType;

  const wasm = await loadWasm();
  if (wasm) {
    try {
      const reader = await wasm.WasmReader.fromBytes(
        format,
        new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length),
        JSON.stringify(C2PA_READER_CONTEXT)
      );
      try {
        return { ...summarise(reader), xmpDigitalSourceType, reader: 'c2pa-wasm' };
      } finally {
        reader.free?.();
      }
    } catch (error) {
      // c2pa-rs reports "no manifest" as an error. Whether the file carries one
      // anyway (damaged or unsupported manifest) is told by the container walk.
      logger.debug('The C2PA reader returned no manifest', {
        component: COMPONENT,
        error: String(error?.message || error)
      });
      return {
        ...absent({
          present: presence.present,
          status: presence.present ? 'unreadable' : 'absent'
        }),
        xmpDigitalSourceType,
        reader: 'c2pa-wasm'
      };
    }
  }

  if (!presence.supported) return absent({ status: 'unsupported_format' });
  return {
    ...absent({ present: presence.present, status: presence.present ? 'present' : 'absent' }),
    xmpDigitalSourceType,
    reader: 'presence'
  };
}
