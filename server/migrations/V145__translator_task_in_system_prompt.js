// server/migrations/V145__translator_task_in_system_prompt.js
import crypto from 'node:crypto';

export const version = '145';
export const description = 'translator_task_in_system_prompt';

const FILE = 'apps/translator.json';

// The Translator's task — the target language, how to treat <content> blocks
// and <user_instruction> — moves from its `prompt` template into its `system`
// prompt, where app variables are filled in as well. The user's message is
// then only the material to translate, and the template goes away.
//
// The move happens only while both texts are still exactly the ones we
// shipped, in every language they have, recognised by their hash: a rewritten
// system prompt may not name {{language}}, so dropping the template under it
// would lose the target language; a rewritten template is the admin's own; and
// a language the admin added would be left with a template that a user of
// another language could fall back to.

/** sha256 of each language's previously shipped `system` text. */
export const SHIPPED_SYSTEM = {
  en: ['634972b0fdfe00f40d6f85b8053edc4904a234df72be7b62d275aeb26e082580'],
  de: ['9e838fcb3ff8d777afdb9b33afec5c376f671de41d09dfe6eac822671dba64ad']
};

/**
 * sha256 of each language's previously shipped `prompt` text: the <task>
 * template V122 introduced, and the quoted template before it — V122 reads
 * the defaults of the version being installed, which no longer have a
 * template, so an installation upgrading from before V122 still has that one.
 */
export const SHIPPED_PROMPT = {
  en: [
    '4a2edc99d15902be6f4a953cef145ff585c154b49329c58e99d7f1e04cb87042',
    'ce86bd5f8db8fdddbb138930cf6df32122779fbef125d64dd752199d53500f91'
  ],
  de: [
    '4e5f6c4f8b992ce595be8b4b22e0e84859ef398c3c1319173866f3da092be684',
    '91f512c051a30d51c26e224c45b49641a27dea87be3c0955c94a043d11f9ab61'
  ]
};

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

const isShipped = (hashes, text) => typeof text === 'string' && hashes.includes(sha256(text));

export async function precondition(ctx) {
  return await ctx.fileExists(FILE);
}

export async function up(ctx) {
  const app = await ctx.readJson(FILE);
  const defaults = await ctx.readDefaultJson(FILE);
  const { system, prompt } = app;
  if (!system || typeof system !== 'object' || !prompt || typeof prompt !== 'object') {
    ctx.log(`${FILE} has no prompt template (already up to date, or customized); left as is`);
    return;
  }

  const shipped = (field, hashes) => {
    const langs = Object.keys(field);
    return (
      langs.length > 0 && langs.every(lang => hashes[lang] && isShipped(hashes[lang], field[lang]))
    );
  };
  const nextSystem = defaults?.system;
  const langs = Object.keys(system);
  if (
    !shipped(system, SHIPPED_SYSTEM) ||
    !shipped(prompt, SHIPPED_PROMPT) ||
    !langs.every(lang => typeof nextSystem?.[lang] === 'string')
  ) {
    ctx.log(`${FILE} was customized; its task stays where the admin put it`);
    return;
  }

  for (const lang of langs) system[lang] = nextSystem[lang];
  delete app.prompt;
  await ctx.writeJson(FILE, app);
  ctx.log(`Moved the Translator's task into its system prompt (${langs.join(', ')})`);
}
