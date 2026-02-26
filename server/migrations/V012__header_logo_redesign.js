/**
 * Migration V012 — Header logo redesign
 *
 * Migrates existing ui.json configs to the new integrated header layout:
 * - Updates logo.url from the old company wordmark to the app icon
 * - Removes containerStyle and imageStyle (badge is gone)
 * - Adds header.tagline with default localized values
 */

export const version = '012';
export const description = 'Header logo redesign: app icon + tagline, remove badge styles';

export async function precondition(ctx) {
  return await ctx.fileExists('config/ui.json');
}

export async function up(ctx) {
  const ui = await ctx.readJson('config/ui.json');

  // Only migrate logo URL if still using the default company wordmark
  if (ui.header?.logo?.url === '/header_company_logo.svg') {
    ui.header.logo.url = '/icons/apps-svg-logo.svg';
    ctx.log('Updated logo URL to app icon');
  }

  // Remove badge styling (no longer used by the component)
  if (ui.header?.logo) {
    delete ui.header.logo.containerStyle;
    delete ui.header.logo.imageStyle;
    ctx.log('Removed containerStyle and imageStyle from logo config');
  }

  // Migrate flat header.title to titleLight + titleBold (config-driven split styling)
  if (!ui.header?.titleLight && !ui.header?.titleBold) {
    ctx.setDefault(ui, 'header.titleLight', { en: 'iHub', de: 'iHub' });
    ctx.setDefault(ui, 'header.titleBold', { en: ' Apps', de: ' Apps' });
    // Remove the old flat title if it was the default value
    if (
      ui.header?.title?.en === 'iHub Apps' &&
      ui.header?.title?.de === 'iHub Apps'
    ) {
      delete ui.header.title;
    }
    ctx.log('Migrated header.title to titleLight + titleBold');
  }

  // Add tagline (only if not already set)
  ctx.setDefault(ui, 'header.tagline', { en: 'by IntraFind', de: 'von IntraFind' });

  await ctx.writeJson('config/ui.json', ui);
  ctx.log('Header logo redesign migration complete');
}
