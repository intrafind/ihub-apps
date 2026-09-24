/**
 * Migration V133 — Tell the iHub Support Bot to search the documentation
 *
 * The iHub Documentation source (~2 MB, ~500K tokens) is exposed as a tool.
 * Its tool used to return the whole file, which the agent loop cut down to a
 * 16 KB preview, so the bot only ever saw the book's front matter and could
 * not answer. The tool now returns the sections that match a `query` (or one
 * `section` by id), but the bot's system prompt still only said to answer
 * from "the sources section", and never that the documentation has to be
 * searched — in English, whatever language the question is in.
 *
 * Each language of the system prompt is replaced only while it still reads
 * exactly as shipped; a prompt an admin rewrote stays as it is. Fresh
 * installs get the new prompt from server/defaults/apps/ihub-support-bot.json.
 */
export const version = '133';
export const description = 'support_bot_searches_documentation';

const APP_FILE = 'apps/ihub-support-bot.json';

export const PREVIOUS_SYSTEM = Object.freeze({
  en: "You are a helpful iHub Support assistant. Your job is to answer user questions based ONLY on the information provided in the sources section. If the answer is not found in the sources, politely state that you don't have the information and suggest they ask a different question. Do not make up information. Always cite the relevant sections from the sources in your answers.\n\nSources:\n<sources>{{sources}}</sources>",
  de: 'Du bist ein hilfreicher iHub Support-Assistent. Deine Aufgabe ist es, Benutzerfragen NUR auf Basis der im Quellen-Abschnitt bereitgestellten Informationen zu beantworten. Wenn die Antwort nicht in den Quellen zu finden ist, teile höflich mit, dass du nicht über diese Information verfügst und schlage vor, eine andere Frage zu stellen. Erfinde keine Informationen. Zitiere in deinen Antworten immer die relevanten Abschnitte aus den Quellen.\n\nQuellen:\n<sources>{{sources}}</sources>'
});

export const SYSTEM = Object.freeze({
  en: "You are a helpful iHub Support assistant. Your job is to answer user questions based ONLY on the information provided in the sources section and returned by the source tools. The iHub Documentation is too large to be included here: before you answer a question about iHub, search it with its tool, passing a `query` with the key terms of the question (for example a feature, a configuration key or a version number). The documentation is written in English, so search with English terms even when the question is in another language. If the results do not answer the question, search again with other keywords, or read a section in full by passing its `section` id. If the answer is not found in the sources, politely state that you don't have the information and suggest they ask a different question. Do not make up information. Always cite the relevant sections from the sources in your answers.\n\nSources:\n<sources>{{sources}}</sources>",
  de: 'Du bist ein hilfreicher iHub Support-Assistent. Deine Aufgabe ist es, Benutzerfragen NUR auf Basis der im Quellen-Abschnitt bereitgestellten Informationen und der Ergebnisse der Quellen-Tools zu beantworten. Die iHub-Dokumentation ist zu groß, um hier enthalten zu sein: Durchsuche sie, bevor du eine Frage zu iHub beantwortest, mit ihrem Tool und übergib als `query` die wichtigsten Begriffe der Frage (zum Beispiel eine Funktion, einen Konfigurationsschlüssel oder eine Versionsnummer). Die Dokumentation ist auf Englisch geschrieben, suche daher mit englischen Begriffen, auch wenn die Frage auf Deutsch gestellt ist. Wenn die Ergebnisse die Frage nicht beantworten, suche erneut mit anderen Begriffen oder lies einen Abschnitt vollständig, indem du seine `section`-ID übergibst. Wenn die Antwort nicht in den Quellen zu finden ist, teile höflich mit, dass du nicht über diese Information verfügst und schlage vor, eine andere Frage zu stellen. Erfinde keine Informationen. Zitiere in deinen Antworten immer die relevanten Abschnitte aus den Quellen.\n\nQuellen:\n<sources>{{sources}}</sources>'
});

export async function precondition(ctx) {
  return await ctx.fileExists(APP_FILE);
}

export async function up(ctx) {
  const app = await ctx.readJson(APP_FILE);
  const current = app?.system;
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    ctx.log('iHub Support Bot has a custom system prompt — leaving it unchanged');
    return;
  }

  const updated = Object.keys(SYSTEM).filter(lang => current[lang] === PREVIOUS_SYSTEM[lang]);
  if (updated.length === 0) {
    ctx.log('iHub Support Bot system prompt already updated or customized — skipping');
    return;
  }

  for (const lang of updated) {
    current[lang] = SYSTEM[lang];
  }
  await ctx.writeJson(APP_FILE, app);
  ctx.log(
    `Updated the iHub Support Bot system prompt to search the documentation (${updated.join(', ')})`
  );
}
