import registerAdminAuthRoutes from './admin/auth.js';
import registerAdminCacheRoutes from './admin/cache.js';
import registerAdminConfigRoutes from './admin/configs.js';
import registerAdminAppsRoutes from './admin/apps.js';
import registerAdminModelsRoutes from './admin/models.js';
import registerAdminPromptsRoutes from './admin/prompts.js';
import registerAdminSourcesRoutes from './admin/sources.js';
import registerAdminGroupRoutes from './admin/groups.js';
import registerAdminTranslateRoute from './admin/translate.js';
import registerAdminPagesRoutes from './admin/pages.js';
import registerAdminUIRoutes from './admin/ui.js';
import registerBackupRoutes from './admin/backup.js';
import registerAdminSchemasRoutes from './admin/schemas.js';

export default async function registerAdminRoutes(app, basePath = '') {
  registerAdminAuthRoutes(app, basePath);
  registerAdminCacheRoutes(app, basePath);
  registerAdminConfigRoutes(app, basePath);
  registerAdminAppsRoutes(app, basePath);
  registerAdminModelsRoutes(app, basePath);
  registerAdminPromptsRoutes(app, basePath);
  registerAdminSourcesRoutes(app, basePath);
  registerAdminGroupRoutes(app, basePath);
  registerAdminTranslateRoute(app, basePath);
  registerAdminPagesRoutes(app, basePath);
  registerAdminUIRoutes(app, basePath);
  await registerBackupRoutes(app, basePath);
  registerAdminSchemasRoutes(app, basePath);
}
