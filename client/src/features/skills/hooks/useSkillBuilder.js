import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import useApps from '../../../shared/hooks/useApps';
import useFavorites from '../../../shared/hooks/useFavorites';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { pickDefaultChatApp } from '../../../utils/homePage';

/** The global skill that interviews the user and drafts a SKILL.md (shipped with iHub). */
export const SKILL_BUILDER_NAME = 'skill-builder';

/**
 * The chat app "Create skill with AI" opens: a chat app the user may use that
 * has the `skill-builder` skill assigned, while the skill is granted to them.
 * Among several, the start page's choice wins (configured default app, then
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
  return pickDefaultChatApp(candidates, favoriteAppIds, uiConfig);
}

/**
 * "Create skill with AI": open a chat with `/skill-builder ` in the input, so
 * the user describes the skill they want and the skill-builder skill drafts
 * it. The answer's "Save as skill" then takes the draft into the editor.
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
    const params = new URLSearchParams({ prefill: `/${SKILL_BUILDER_NAME} ` });
    navigate(`/apps/${encodeURIComponent(app.id)}?${params}`);
  }, [app, navigate]);

  return { app, start };
}
