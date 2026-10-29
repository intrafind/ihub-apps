// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Public keys whose signatures the updater accepts on release archives.
 *
 * Two slots — the key releases are signed with now, and the one that will
 * replace it — so a key rotation never strands installations: a release
 * signed with the "next" key verifies on every installation that already
 * shipped it. The rotation procedure is in docs/update-signing.md.
 *
 * Installations that build their own binaries add keys through
 * `platform.json` → `update.trustedPublicKeys` instead of editing this file.
 *
 * Each entry: `{ label, publicKey }`, `publicKey` an Ed25519 SPKI PEM
 * (`node scripts/update-signing.js keygen` prints one).
 *
 * @module update/trustedKeys
 */
export const EMBEDDED_UPDATE_KEYS = Object.freeze([
  // { label: 'ihub-release-current', publicKey: '-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n' },
  // { label: 'ihub-release-next', publicKey: '-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n' }
]);
