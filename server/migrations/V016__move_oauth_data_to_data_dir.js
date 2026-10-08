import fs from 'fs/promises';
import path from 'path';

export const version = '016';
export const description = 'move_oauth_data_to_data_dir';

export async function up(ctx) {
  const dataDir = path.join(ctx.contentsDir, 'data');
  await fs.mkdir(dataDir, { recursive: true });

  for (const filename of ['oauth-refresh-tokens.json', 'oauth-consent.json']) {
    const src = `config/${filename}`;
    const dest = `data/${filename}`;

    if (await ctx.fileExists(src)) {
      await ctx.moveFile(src, dest);
      ctx.log(`Moved ${src} → ${dest}`);
    }
  }
}
