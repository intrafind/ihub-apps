/**
 * Text signpost (CoP Measure 3.4(c), concept §5.1 and §8.7; issue #2575).
 *
 * Free-form text cannot carry metadata, so iHub appends an invisible
 * **C2PA text manifest wrapper** as specified in C2PA 2.4 Appendix A.8
 * "Embedding Manifests into Unstructured Text": a ZERO WIDTH NO-BREAK SPACE
 * (U+FEFF) followed by Unicode variation selectors that encode, byte by byte,
 * the magic `C2PATXT\0`, a version byte (1), a big-endian 32-bit length and
 * the payload (bytes 0–15 → U+FE00–U+FE0F, 16–255 → U+E0100–U+E01EF). The
 * wrapper round-trips through independent implementations (encypherai/c2pa-text).
 *
 * The payload is a compact JWS signed with the installation's C2PA signing
 * certificate: content hash, content id and the signpost URL of the
 * installation's `/.well-known/ai-provenance`, so a verifier knows which
 * detector to ask. (c2pa-rs does not yet sign manifests for unstructured
 * text; when it does, the payload becomes a C2PA JUMBF manifest store in the
 * same wrapper.)
 *
 * It is a **signpost, not a watermark**: trivially strippable, so never the
 * only layer. Admins switch it at platform and app level (on for text file
 * exports, off for the clipboard by default). It is never added to the live
 * chat stream: invisible characters there break markdown, search and diffs.
 *
 * @module services/provenance/text/signpost
 */
import signingService from '../signing/SigningService.js';
import { getInstallationUrl } from '../installation.js';
import { hashContent } from '../ProvenanceStore.js';

const MAGIC = Buffer.from('C2PATXT\0', 'latin1');
const VERSION = 1;
const HEADER_SIZE = 13;
const ZWNBSP = '﻿';
export const SIGNPOST_TYP = 'ihub-text-signpost+jws';

function byteToVs(byte) {
  return byte < 16
    ? String.fromCodePoint(0xfe00 + byte)
    : String.fromCodePoint(0xe0100 + byte - 16);
}

function vsToByte(cp) {
  if (cp >= 0xfe00 && cp <= 0xfe0f) return cp - 0xfe00;
  if (cp >= 0xe0100 && cp <= 0xe01ef) return cp - 0xe0100 + 16;
  return null;
}

/**
 * The wrapper for a payload.
 * @param {Uint8Array|Buffer} payload
 * @returns {string}
 */
export function encodeWrapper(payload) {
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header[8] = VERSION;
  header.writeUInt32BE(payload.length, 9);
  let out = ZWNBSP;
  for (const b of header) out += byteToVs(b);
  for (const b of payload) out += byteToVs(b);
  return out;
}

/**
 * Find and decode a wrapper.
 * @param {string} text
 * @returns {{payload: Buffer, cleanText: string, offset: number, length: number}|null}
 */
export function extractWrapper(text) {
  if (typeof text !== 'string') return null;
  let from = 0;
  for (;;) {
    const start = text.indexOf(ZWNBSP, from);
    if (start === -1) return null;
    const bytes = [];
    let i = start + 1;
    while (i < text.length) {
      const cp = text.codePointAt(i);
      const b = vsToByte(cp);
      if (b === null) break;
      bytes.push(b);
      i += cp > 0xffff ? 2 : 1;
    }
    const buf = Buffer.from(bytes);
    if (buf.length >= HEADER_SIZE && buf.subarray(0, 8).equals(MAGIC) && buf[8] === VERSION) {
      const len = buf.readUInt32BE(9);
      if (buf.length >= HEADER_SIZE + len) {
        return {
          payload: buf.subarray(HEADER_SIZE, HEADER_SIZE + len),
          cleanText: text.slice(0, start) + text.slice(i),
          offset: start,
          length: i - start
        };
      }
    }
    from = start + 1;
  }
}

/**
 * Whether the signpost applies for this target.
 * @param {'exports'|'clipboard'} target
 * @param {Object} cfg - resolved platform.aiTransparency
 * @param {Object} [app] - app config (app-level override `aiTransparency.signpost`)
 */
export function signpostEnabled(target, cfg, app) {
  const appValue = app?.aiTransparency?.signpost?.[target];
  if (typeof appValue === 'boolean') return appValue;
  return cfg?.text?.signpost?.[target] === true;
}

/**
 * Append a signed signpost to text.
 *
 * @param {string} text
 * @param {{contentId?: string, verification?: string}} [meta]
 * @returns {Promise<string>} the text with the wrapper, or the text unchanged when signing is unavailable
 */
export async function applyTextSignpost(text, { contentId, verification } = {}) {
  const clean = String(text ?? '');
  const installationUrl = getInstallationUrl();
  const payload = {
    v: 1,
    ai: true,
    generator: 'iHub Apps',
    hash: hashContent(clean),
    ...(contentId ? { cid: contentId } : {}),
    ...(verification ? { verification } : {}),
    ...(installationUrl
      ? { iss: installationUrl, signpost: `${installationUrl}/.well-known/ai-provenance` }
      : {}),
    iat: new Date().toISOString()
  };
  const jws = await signingService.signPayload(payload, { typ: SIGNPOST_TYP, leafOnly: true });
  if (!jws) return text;
  return `${clean}${encodeWrapper(Buffer.from(jws, 'utf8'))}`;
}

/**
 * Check a text for a signpost: extract, verify the signature, compare the
 * content hash.
 * @param {string} text
 * @param {{trustAnchors?: string[]}} [opts] - extra anchors
 * @returns {Promise<{found: boolean, valid?: boolean, trusted?: boolean, intact?: boolean, payload?: Object, signer?: Object, errors?: string[], cleanText?: string}>}
 */
export async function verifyTextSignpost(text, { trustAnchors = [] } = {}) {
  const wrapper = extractWrapper(text);
  if (!wrapper) return { found: false };
  const token = wrapper.payload.toString('utf8');
  const verified = await signingService.verifyPayload(token, { extraAnchors: trustAnchors });
  const intact = verified.payload?.hash === hashContent(wrapper.cleanText);
  return {
    found: true,
    valid: verified.valid,
    trusted: verified.trusted,
    intact,
    payload: verified.payload,
    signer: verified.signer,
    errors: [...verified.errors, ...(intact ? [] : ['The text was changed after it was signed'])],
    cleanText: wrapper.cleanText
  };
}
