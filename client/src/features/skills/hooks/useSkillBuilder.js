import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import useApps from '../../../shared/hooks/useApps';
import useFavorites from '../../../shared/hooks/useFavorites';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { pickDefaultChatApp } from '../../../utils/homePage';

/** The global skill that interviews the user and drafts a SKILL.md (shipped with iHub). */
export const SKILL_BUILDER_NAME = 'skill-builder';

/** How many skills a turn runs at most, as the server caps them (skillAccess.js). */
const DEFAULT_MAX_ACTIVE_SKILLS = 3;
const MAX_ACTIVE_SKILLS_LIMIT = 10;

/**
 * Whether `app` is built around the skill-builder skill: it runs the skill on
 * every turn (`skillSettings.autoActivate`), like the shipped Skill Builder
 * app, so a chat there needs no `/skill-builder` to start. The server
 * auto-activates the app's skills in order up to `maxActiveSkills`, so the
 * skill has to be within that many.
 *
 * @param {Object} app
 * @returns {boolean}
 */
export function runsSkillBuilder(app) {
  if (app?.skillSettings?.autoActivate !== true || !Array.isArray(app?.skills)) return false;
  const configured = app.skillSettings.maxActiveSkills;
  const cap =
    Number.isInteger(configured) && configured >= 1
      ? Math.min(configured, MAX_ACTIVE_SKILLS_LIMIT)
      : DEFAULT_MAX_ACTIVE_SKILLS;
  const index = app.skills.indexOf(SKILL_BUILDER_NAME);
  return index >= 0 && index < cap;
}

/**
 * The chat app "Create skill with AI" opens: a chat app the user may use that
 * has the `skill-builder` skill assigned, while the skill is granted to them.
 * An app built around the skill ({@link runsSkillBuilder}) comes first; among
 * several, the start page's choice wins (configured default app, then
 * favorites, featured apps and order).
 *
 * @param {Object[]} apps - Apps the user may use.
 * @param {Object[]} globalSkills - Global skills granted to the user (`/api/skills`).
 * @param {Object} [options]
 * @param {string[]} [options.favoriteAppIds]
 * @param {Object} [options.uiConfig]
 * @returns {Object|null} The app, or null when there is none.
 */
export function findSkillBuilderApp(apps, globalSkills, { favoriteAppIds = [], uiConfig } = {}) {
  const granted = (Array.isArray(globalSkills) ? globalSkills : []).some(
    skill => skill?.name === SKILL_BUILDER_NAME
  );
  if (!granted) return null;
  const candidates = (Array.isArray(apps) ? apps : []).filter(
    app => Array.isArray(app?.skills) && app.skills.includes(SKILL_BUILDER_NAME)
  );
  const dedicated = candidates.filter(runsSkillBuilder);
  return (
    pickDefaultChatApp(dedicated, favoriteAppIds, uiConfig) ||
    pickDefaultChatApp(candidates, favoriteAppIds, uiConfig)
  );
}

/**
 * "Create skill with AI": open a chat where the skill-builder skill drafts the
 * skill the user describes — the app built around it as it is, any other app
 * with `/skill-builder ` in the input. The answer's "Save as skill" then takes
 * the draft into the editor.
 *
 * @param {Object} options
 * @param {boolean} options.enabled - Whether the user may keep skills of their own.
 * @param {Object[]} options.globalSkills - Global skills granted to the user.
 * @returns {{app: Object|null, start: () => void}} `app` is null when there is
 *   no app to open, and the entry is not offered.
 */
export default function useSkillBuilder({ enabled, globalSkills }) {
  const navigate = useNavigate();
  const { apps } = useApps();
  const { uiConfig } = useUIConfig();
  const { favorites: favoriteAppIds } = useFavorites('ihub_favorite_apps');

  const app = useMemo(
    () => (enabled ? findSkillBuilderApp(apps, globalSkills, { favoriteAppIds, uiConfig }) : null),
    [enabled, apps, globalSkills, favoriteAppIds, uiConfig]
  );

  const start = useCallback(() => {
    if (!app) return;
    const path = `/apps/${encodeURIComponent(app.id)}`;
    if (runsSkillBuilder(app)) {
      navigate(path);
      return;
    }
    const params = new URLSearchParams({ prefill: `/${SKILL_BUILDER_NAME} ` });
    navigate(`${path}?${params}`);
  }, [app, navigate]);

  return { app, start };
}
