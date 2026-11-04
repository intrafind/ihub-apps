// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

export const version = '217';
export const description = 'Delete integration token files in the AES-CBC format';

export async function precondition(ctx) {
  return (await ctx.listFiles('integrations')).length > 0;
}

/**
 * Per-user integration token files (`integrations/<service>/<userId>[__<providerId>].json`) are
 * encrypted with authenticated AES-256-GCM. Files from before 5.4.16 may still be in the
 * unauthenticated AES-256-CBC format (no `authTag`). The server no longer reads that format, since
 * reading it needs a decrypt path without a MAC, so those files are deleted without being
 * decrypted and the affected users connect the service again. GCM files are never touched.
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
      if (isTokenFile && !data.authTag) {
        await ctx.deleteFile(`${dir}/${file}`);
        removed += 1;
      }
    }
  }
  ctx.log(`Deleted ${removed} AES-CBC integration token file(s); affected users reconnect`);
}
