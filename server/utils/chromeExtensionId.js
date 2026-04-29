import crypto from 'crypto';

/**
 * Chromium extension ID + CRX3 packaging helpers.
 *
 * The Chromium extension ID is a deterministic function of the extension's
 * public key. The same SPKI-DER public key produces the same ID across all
 * users — which is what lets us pre-register a single redirect URI on the
 * iHub OAuth client and ship one customised extension build to everyone.
 *
 * Algorithm (matches Chrome's components/crx_file/id_util.cc):
 *   1. Take SubjectPublicKeyInfo DER bytes (same bytes that go into manifest.key).
 *   2. SHA-256 those bytes.
 *   3. Take the first 16 bytes of the digest.
 *   4. Hex-encode to 32 lowercase chars.
 *   5. Map each hex digit '0'..'9' -> 'a'..'j' and 'a'..'f' -> 'k'..'p'.
 */

/**
 * Generate an RSA-2048 keypair suitable for signing a Chromium extension.
 *
 * @returns {{
 *   privateKeyPem: string,
 *   publicKeyDer: Buffer,
 *   publicKeySpkiBase64: string,
 *   extensionId: string
 * }}
 */
export function generateExtensionSigningKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048
  });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKeyPem,
    publicKeyDer,
    publicKeySpkiBase64: publicKeyDer.toString('base64'),
    extensionId: deriveExtensionId(publicKeyDer)
  };
}

/**
 * Derive the Chromium extension ID from SPKI-DER public-key bytes.
 *
 * @param {Buffer} spkiDerBuffer
 * @returns {string} 32-char [a-p] extension ID
 */
export function deriveExtensionId(spkiDerBuffer) {
  const digest = crypto.createHash('sha256').update(spkiDerBuffer).digest();
  const hex = digest.subarray(0, 16).toString('hex');
  let out = '';
  for (let i = 0; i < hex.length; i++) {
    const code = hex.charCodeAt(i);
    if (code >= 0x30 && code <= 0x39) {
      out += String.fromCharCode(code - 0x30 + 0x61); // '0'..'9' -> 'a'..'j'
    } else {
      out += String.fromCharCode(code - 0x61 + 0x6b); // 'a'..'f' -> 'k'..'p'
    }
  }
  return out;
}

/**
 * Re-derive the extension ID from a previously-stored base64 SPKI key.
 * Useful for the status endpoint, which stores only the public key.
 *
 * @param {string} b64
 * @returns {string}
 */
export function extensionIdFromPublicKeyBase64(b64) {
  return deriveExtensionId(Buffer.from(b64, 'base64'));
}

// ---------------------------------------------------------------------------
// CRX3 packaging
// ---------------------------------------------------------------------------
//
// CRX3 layout (https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/):
//
//   [4 bytes] "Cr24"               magic
//   [4 bytes] uint32 LE = 3        version
//   [4 bytes] uint32 LE = N        header size in bytes
//   [N bytes] CrxFileHeader        protobuf — proofs + signed_header_data
//   [...]     ZIP archive bytes    body (the unsigned ZIP we already produce)
//
// CrxFileHeader (proto2):
//   message CrxFileHeader {
//     repeated AsymmetricKeyProof sha256_with_rsa = 2;
//     optional bytes signed_header_data = 10000;
//   }
//   message AsymmetricKeyProof { optional bytes public_key = 1; optional bytes signature = 2; }
//   message SignedData { optional bytes crx_id = 1; }
//
// Signature input (RSA-PKCS1v15 SHA-256):
//   "CRX3 SignedData\x00" + uint32_LE(len(signed_header_data)) + signed_header_data + zip_body

/**
 * Encode a non-negative integer as a protobuf varint.
 * @param {number} n
 * @returns {Buffer}
 */
function encodeVarint(n) {
  const out = [];
  let value = n;
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  out.push(value & 0x7f);
  return Buffer.from(out);
}

/**
 * Encode a single LEN-typed (wire type 2) protobuf field: tag varint, length
 * varint, raw bytes.
 *
 * @param {number} fieldNumber
 * @param {Buffer} bytes
 * @returns {Buffer}
 */
function encodeLengthDelimited(fieldNumber, bytes) {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(bytes.length);
  return Buffer.concat([tag, len, bytes]);
}

/**
 * Build a `.crx` file from a ZIP body and an extension signing keypair.
 *
 * @param {Object} args
 * @param {Buffer} args.zipBuffer        - The full ZIP body (the same bytes we'd send for the .zip download)
 * @param {Buffer} args.publicKeyDer     - SPKI DER public key (must match privateKeyPem)
 * @param {string} args.privateKeyPem    - PKCS#8 PEM private key
 * @returns {Buffer} The full .crx file
 */
export function packCrx3({ zipBuffer, publicKeyDer, privateKeyPem }) {
  // SignedData { crx_id = first 16 bytes of SHA256(SPKI DER) }.
  // (No letter-mapping here — that's only for the human-readable extension ID.)
  const crxIdBytes = crypto.createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);

  const signedData = encodeLengthDelimited(1, crxIdBytes); // SignedData.crx_id = 1
  // CrxFileHeader.signed_header_data has field number 10000 — its tag varint is
  // multi-byte and our encoder handles that.

  // Signature input per spec.
  const sigPrefix = Buffer.concat([
    Buffer.from('CRX3 SignedData\x00', 'binary'),
    // uint32 LE length of signed_header_data
    Buffer.from(new Uint32Array([signedData.length]).buffer)
  ]);
  const toSign = Buffer.concat([sigPrefix, signedData, zipBuffer]);
  const signature = crypto.sign('sha256', toSign, privateKeyPem);

  // AsymmetricKeyProof { public_key = 1, signature = 2 }
  const proof = Buffer.concat([
    encodeLengthDelimited(1, publicKeyDer),
    encodeLengthDelimited(2, signature)
  ]);

  // CrxFileHeader { sha256_with_rsa = 2 (repeated), signed_header_data = 10000 }
  const header = Buffer.concat([
    encodeLengthDelimited(2, proof),
    encodeLengthDelimited(10000, signedData)
  ]);

  const magic = Buffer.from('Cr24', 'binary');
  const version = Buffer.alloc(4);
  version.writeUInt32LE(3, 0);
  const headerSize = Buffer.alloc(4);
  headerSize.writeUInt32LE(header.length, 0);

  return Buffer.concat([magic, version, headerSize, header, zipBuffer]);
}
