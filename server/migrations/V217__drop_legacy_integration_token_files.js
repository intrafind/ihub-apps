// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

export const version = '217';
export const description = 'Delete legacy integration token files (AES-CBC, single-slot)';

export async function precondition(ctx) {
  return (await ctx.listFiles('integrations')).length > 0;
}

/**
 * Per-user integration token files live in `integrations/<service>/<userId>__<providerId>.json`
 * and are encrypted with authenticated AES-256-GCM. Two older shapes can still be on disk:
 *
 *   - unauthenticated AES-256-CBC files (no `authTag`), and
 *   - single-slot files (`<userId>.json`, no `providerId`).
 *
 * The server no longer reads either. Reading CBC needs a decrypt path without a MAC, and the
 * single-slot files can only be assigned to a provider by decrypting them, so they are deleted
 * without being decrypted: the affected users connect the service again. Nothing else is touched.
 */
export async function up(ctx) {
  let removed = 0;
  for (const service of await ctx.listFiles('integrations')) {
    const dir = `integrations/${service}`;
    for (const file of await ctx.listFiles(dir, '*.json')) {
      let data;
      try {
        data = await ctx.readJson(`${dir}/${file}`);
      } catch {
        continue; // a directory or not a token file
      }
      const isTokenFile =
        data && typeof data === 'object' && data.encrypted && data.iv && data.contextHash;
      if (!isTokenFile) continue;
      if (!data.authTag || !data.providerId) {
        await ctx.deleteFile(`${dir}/${file}`);
        removed += 1;
      }
    }
  }
  ctx.log(`Deleted ${removed} legacy integration token file(s); affected users reconnect`);
}
