import crypto from 'node:crypto';

export const version = '122';
export const description = 'prompt_context_blocks';

// Every client now sends what the user typed, the host item (email, meeting,
// page) and uploads separately, and the server renders all material as
// <content type="…" origin="…"> blocks into {{content}} — uploads included,
// instead of a "[File: …]" section above the app template
// (shared/promptContext.js). A message that is only typed text is sent as is.
// The tags the add-in used before (<current_email>, <pinned_emails>,
// <current_meeting>, <current_page>) are gone.
//
// The shipped apps that name the old tags, or quoted {{content}} as "the text
// to translate", get the new default text — but only a prompt that is still
// exactly the one we shipped, recognised by its hash. A prompt an admin
// rewrote is left alone. Translator and Summarizer also get the document
// upload section, unless they already have one.

/** sha256 of each language's previously shipped text, per app and field. */
export const SHIPPED = {
  'apps/translator.json': {
    prompt: {
      en: 'ce86bd5f8db8fdddbb138930cf6df32122779fbef125d64dd752199d53500f91',
      de: '91f512c051a30d51c26e224c45b49641a27dea87be3c0955c94a043d11f9ab61'
    }
  },
  'apps/summarizer.json': {
    prompt: {
      en: 'fc3882ce8f6cb3c04cd0d891b9ef89f4608abc2f068a23a02813e6ded223dda4',
      de: 'cdbbb60675d32c92fb8c0f78dffa8c122768897689008a5aa6420870d63db80e'
    }
  },
  'apps/outlook-reply.json': {
    system: {
      en: 'c77f1b3060e93696e99c17e3e3c2d1218592a46a80708cb68b6bf394ca030597',
      de: '69c7bfd9d67d6155250e6fe231b972fc8f7d60b29ac3a7c6ccc08ccd3a1361bf'
    },
    prompt: {
      en: '233f2792dc9fc069a1bfd4fccc762f80f64212f78a25f5b76ff79dbed9e30788',
      de: 'cf6c94e4d1d56dbdbe54476b0a5a9c1cb81ae6f5848711e345eabb04fcaf38f8'
    },
    'starterPrompts.0.message': {
      en: 'f2ff3ac294d7f2a33a306cec4bd45f63d960b6ecd9316caf322111a18de7fd88',
      de: 'a217330dec845216fbb9fed22a09644ebc6c9c72b9c09424907173190c3afceb'
    }
  },
  'apps/meeting-briefing.json': {
    system: {
      en: '07d2af182acbd1a4e71bc00d69ee519d3b47f0f6589f9e718b0d91e5b619fe41',
      de: 'd085fa3ed85219b87b38a7b6e7c412515929206d05aa63e200456947f8c97306'
    }
  },
  'apps/meeting-agenda-generator.json': {
    system: {
      en: 'c568534f986529005c23596a0efd5f54f6cb8041b1027c165659ddf523e2f73b',
      de: '9704c52aed21f9eb36c97414b7f15a44b9922f514e79e9290ffa1a2733dc10c5'
    }
  }
};

const UPLOAD_APPS = ['apps/translator.json', 'apps/summarizer.json'];

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function getPath(obj, dotPath) {
  return dotPath.split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

export async function precondition(ctx) {
  for (const file of Object.keys(SHIPPED)) {
    if (await ctx.fileExists(file)) return true;
  }
  return false;
}

export async function up(ctx) {
  for (const [file, fields] of Object.entries(SHIPPED)) {
    if (!(await ctx.fileExists(file))) continue;
    const app = await ctx.readJson(file);
    const defaults = await ctx.readDefaultJson(file);
    const updated = [];

    for (const [field, hashes] of Object.entries(fields)) {
      const current = getPath(app, field);
      const next = getPath(defaults, field);
      if (!current || typeof current !== 'object' || !next || typeof next !== 'object') continue;
      for (const [lang, hash] of Object.entries(hashes)) {
        if (typeof current[lang] !== 'string' || typeof next[lang] !== 'string') continue;
        if (sha256(current[lang]) !== hash) continue;
        current[lang] = next[lang];
        updated.push(`${field}.${lang}`);
      }
    }

    if (UPLOAD_APPS.includes(file) && app.upload === undefined && defaults?.upload) {
      app.upload = defaults.upload;
      updated.push('upload');
    }

    if (updated.length > 0) {
      await ctx.writeJson(file, app);
      ctx.log(`Moved ${file} to the <content> blocks: ${updated.join(', ')}`);
    }
  }
}
