import registerAdminAuthRoutes from './admin/auth.js';
import registerAdminCacheRoutes from './admin/cache.js';
import registerAdminConfigRoutes from './admin/configs.js';
import registerAdminAppsRoutes from './admin/apps.js';
import registerAdminModelsRoutes from './admin/models.js';
import registerAdminPromptsRoutes from './admin/prompts.js';
import registerAdminGroupRoutes from './admin/groups.js';
import registerAdminTranslateRoute from './admin/translate.js';
import registerAdminPagesRoutes from './admin/pages.js';
import registerAdminUIRoutes from './admin/ui.js';
import registerBackupRoutes from './admin/backup.js';

export default async function registerAdminRoutes(app) {
  registerAdminAuthRoutes(app);
  registerAdminCacheRoutes(app);
  registerAdminConfigRoutes(app);
  registerAdminAppsRoutes(app);
  registerAdminModelsRoutes(app);
  registerAdminPromptsRoutes(app);
  registerAdminGroupRoutes(app);
  registerAdminTranslateRoute(app);
  registerAdminPagesRoutes(app);
  registerAdminUIRoutes(app);
  registerBackupRoutes(app);
}
