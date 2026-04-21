export const version = '029';
export const description = 'fix_empty_office_description';

export async function precondition(ctx) {
  return await ctx.fileExists('config/platform.json');
}

export async function up(ctx) {
  const platform = await ctx.readJson('config/platform.json');
  const office = platform.officeIntegration;
  if (!office) return;

  let changed = false;

  if (office.displayName) {
    if (!office.displayName.en) {
      office.displayName.en = 'iHub Apps';
      changed = true;
    }
    if (!office.displayName.de) {
      office.displayName.de = 'iHub Apps';
      changed = true;
    }
  }

  if (office.description) {
    if (!office.description.en) {
      office.description.en = 'AI-powered assistant for Outlook';
      changed = true;
    }
    if (!office.description.de) {
      office.description.de = 'KI-gestützter Assistent für Outlook';
      changed = true;
    }
  }

  if (changed) {
    await ctx.writeJson('config/platform.json', platform);
    ctx.log('Repaired empty officeIntegration display values');
  }
}
