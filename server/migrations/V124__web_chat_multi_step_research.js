/**
 * Migration V124 — web-chat: research in several steps
 *
 * Chat turns allow several tool rounds, but the shipped `web-chat` system
 * prompt described a single pass ("use the web search tool to find and analyze
 * relevant content"), so the model ran one search and answered (issue #2484).
 * The server now appends multi-step research guidance whenever web search is
 * on for a turn, and the default prompt was reworded to match it.
 *
 * Existing installs have their own copy of the app in `contents/apps/`. Only a
 * locale whose prompt is still exactly the old shipped default is rewritten;
 * a prompt an admin edited is left alone, since the appended guidance applies
 * to it anyway and their wording wins.
 */

export const version = '124';
export const description = 'web_chat_multi_step_research_prompt';

const APP_FILE = 'apps/web-chat.json';

/** Previously shipped default prompt → new default prompt, per locale. */
export const PROMPT_UPDATES = {
  en: {
    from: 'You are a helpful AI assistant with access to web search. You can search the web and automatically extract full content from relevant pages to provide comprehensive, up-to-date information. When the user asks a question that requires current information, use the web search tool to find and analyze relevant content. Always cite your sources with URLs when providing information based on web search results.\n\nProvide clear, well-structured answers based on the most current information available.',
    to: 'You are a helpful AI assistant with access to web search. You can search the web and automatically extract full content from relevant pages to provide comprehensive, up-to-date information. When the user asks a question that requires current information, research it with web search: break it into its parts, search as often as needed with different wording, check important claims against more than one source, and combine the findings into one answer. Always cite your sources with URLs when providing information based on web search results.\n\nProvide clear, well-structured answers based on the most current information available.'
  },
  de: {
    from: 'Du bist ein hilfreicher KI-Assistent mit Zugriff auf Websuche. Du kannst das Web durchsuchen und automatisch vollständige Inhalte von relevanten Seiten extrahieren, um umfassende, aktuelle Informationen bereitzustellen. Wenn der Benutzer eine Frage stellt, die aktuelle Informationen erfordert, nutze das Websuch-Tool, um relevante Inhalte zu finden und zu analysieren. Zitiere immer deine Quellen mit URLs, wenn du Informationen auf Basis von Websuchergebnissen bereitstellst.\n\nGib klare, gut strukturierte Antworten basierend auf den aktuellsten verfügbaren Informationen.',
    to: 'Du bist ein hilfreicher KI-Assistent mit Zugriff auf Websuche. Du kannst das Web durchsuchen und automatisch vollständige Inhalte von relevanten Seiten extrahieren, um umfassende, aktuelle Informationen bereitzustellen. Wenn der Benutzer eine Frage stellt, die aktuelle Informationen erfordert, recherchiere sie mit der Websuche: Zerlege sie in ihre Teile, suche so oft wie nötig mit unterschiedlichen Formulierungen, prüfe wichtige Aussagen anhand mehrerer Quellen und führe die Ergebnisse zu einer Antwort zusammen. Zitiere immer deine Quellen mit URLs, wenn du Informationen auf Basis von Websuchergebnissen bereitstellst.\n\nGib klare, gut strukturierte Antworten basierend auf den aktuellsten verfügbaren Informationen.'
  }
};

export async function precondition(ctx) {
  return await ctx.fileExists(APP_FILE);
}

export async function up(ctx) {
  const app = await ctx.readJson(APP_FILE);
  const system = app?.system;
  if (!system || typeof system !== 'object' || Array.isArray(system)) {
    ctx.log('web-chat has no localized system prompt — nothing to update');
    return;
  }

  const updated = [];
  for (const [locale, { from, to }] of Object.entries(PROMPT_UPDATES)) {
    if (system[locale] === from) {
      system[locale] = to;
      updated.push(locale);
    }
  }

  if (updated.length === 0) {
    ctx.log('web-chat system prompt was customized or already updated — left as is');
    return;
  }

  await ctx.writeJson(APP_FILE, app);
  ctx.log(`Updated web-chat default system prompt for multi-step research (${updated.join(', ')})`);
}
