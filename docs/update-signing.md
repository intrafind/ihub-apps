# Update Signing

Binary installations install an update only if the archive is signed by a key
they trust. This page is for the people who publish releases (and for
installations that build their own binaries): how the signature is made, where
the key lives, and how to rotate it.

## What is signed

The release workflow (`.github/workflows/build-binaries.yml`) signs two files
with Ed25519, using `scripts/update-signing.js`:

| File | Where | Covers | Used by |
| --- | --- | --- | --- |
| `update-manifest.json` + `update-manifest.json.sig` | inside every archive | the version, platform, CPU architecture, bundled Node.js version, highest config migration, and the SHA-256 of **every file** in the archive | every update, online and "Install from file" — the archive alone is enough |
| `checksums.sha256` + `checksums.sha256.sig` | release assets | the SHA-256 of every archive of the release | the online update, and offline when the admin provides both files |

The updater verifies the signature against the public keys built into iHub
(`server/update/trustedKeys.js`) and any in `platform.json` →
`update.trustedPublicKeys`, then checks every extracted file against the
manifest. A file that was changed, added or removed after signing makes the
archive fail. Signature files are JSON:

```json
{ "algorithm": "ed25519", "signatures": [{ "keyId": "0b91615f688170a8", "signature": "<base64>" }] }
```

`keyId` is the first 16 hex digits of the SHA-256 of the public key (SPKI DER).

## Key custody

- The private keys are the secrets `UPDATE_SIGNING_PRIVATE_KEY` and (during a
  rotation) `UPDATE_SIGNING_PRIVATE_KEY_NEXT` of the GitHub **environment**
  `release-signing`, not repository secrets. Configure the environment with a
  required reviewer (*Settings → Environments → release-signing*), so a
  release build waits for a person before the key is handed to it, and restrict
  it to tags (`v*`).
- Only the two workflow steps that sign see the secret in their environment.
- Keep an offline copy of each private key (password manager or HSM-backed
  vault) with at least two custodians. A lost key cannot be recovered; see
  "Rotation" for how to replace it without stranding installations.
- Without the secret, the workflow still builds and publishes the release but
  warns that it is **not signed**. Installations refuse such archives unless
  `update.allowUnsigned` is set.

## First-time setup

```bash
node scripts/update-signing.js keygen > key.txt   # private key, public key, keyId
```

1. Store the private key (the `-----BEGIN PRIVATE KEY-----` block) as
   `UPDATE_SIGNING_PRIVATE_KEY` in the `release-signing` environment and in the
   offline vault. Delete `key.txt`.
2. Put the public key into `EMBEDDED_UPDATE_KEYS` in
   `server/update/trustedKeys.js` with the label `ihub-release-current`, and
   generate a second pair the same way for the `ihub-release-next` slot (its
   private key goes only into the vault for now).
3. Release. From this release on, installations verify every update.

The update **into** the first release that ships the keys is performed by the
previous updater, which does not verify signatures. Verify that download on a
connected machine with the build-provenance attestation:

```bash
gh attestation verify ihub-apps-v<version>-linux.tar.gz --repo intrafind/ihub-apps
```

## Rotation

Installations trust every key in `EMBEDDED_UPDATE_KEYS`, and new releases
can be signed with several keys at once, so a rotation never needs a flag day:

1. Release N already ships `current` (A) and `next` (B) public keys and is
   signed with A.
2. Move B's private key into `UPDATE_SIGNING_PRIVATE_KEY_NEXT`. Releases are now
   signed with A **and** B.
3. In release N+1, make B `current`, add a freshly generated key C as `next`,
   and drop A. Move B to `UPDATE_SIGNING_PRIVATE_KEY`, C to the vault, and
   remove A.
4. An installation on release N verifies N+1 with B. Installations older than
   N must update through N (or have B added to `update.trustedPublicKeys`).

**Compromised key:** remove its public key in the next release, sign that
release with the `next` key only, and tell administrators to add the new key to
`update.trustedPublicKeys` or to verify the release by its attestation before
installing it.

`server/tests/update-staging.test.js` covers signing with a second key and
verifying a release signed with a key that is not (or no longer) trusted.

## Verifying a file by hand

```bash
node scripts/update-signing.js verify checksums.sha256 --key=release-public.pem
sha256sum -c checksums.sha256 --ignore-missing
```

## Installations that build their own binaries

Generate a key pair, sign with `UPDATE_SIGNING_PRIVATE_KEY=… node
scripts/update-signing.js sign dist-bin/update-manifest.json` after building
(`build-sea.cjs` writes the manifest), and add the public key to
`update.trustedPublicKeys` in `platform.json` on your installations:

```json
"update": {
  "trustedPublicKeys": [{ "label": "acme-builds", "publicKey": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n" }]
}
```
