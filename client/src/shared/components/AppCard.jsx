import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import { getLocalizedContent } from '../../utils/localizeContent';

/**
 * Shared app card component.
 *
 * variant="compact" — used in Office taskpane and AppListPanel.
 *   75px tall row with left color strip, icon, name + description.
 *   Requires: onClick(app), language
 *
 * variant="full" — used in AppsList (main web).
 *   Responsive: side strip on mobile, top banner on desktop.
 *   Shows favorite star, recent clock, app type badge.
 *   Requires: href (Link navigation) OR onClick(app), language
 *   Optional: isFavorite, isRecent, onToggleFavorite(e, appId)
 */
function AppCard({
  app,
  variant = 'compact',
  onClick,
  language = 'en',
  // full variant only
  href,
  isFavorite = false,
  isRecent = false,
  onToggleFavorite
}) {
  const { t } = useTranslation();
  const name = getLocalizedContent(app.name, language) || app.id;
  const description = getLocalizedContent(app.description, language) || '';

  if (variant === 'compact') {
    return (
      <button
        type="button"
        className="relative bg-white rounded-lg shadow hover:shadow-md transition-shadow duration-200 w-full flex flex-row cursor-pointer text-left"
        style={{ height: '75px', minHeight: '72px' }}
        role="listitem"
        onClick={() => onClick?.(app)}
      >
        <div
          className="flex items-center justify-center w-10 h-full flex-shrink-0 rounded-l-lg"
          style={{ backgroundColor: app.color || '#4F46E5' }}
        >
          <div className="w-8 h-8 bg-white/30 rounded-full flex items-center justify-center">
            <Icon name={app.icon} className="w-6 h-6 text-white" />
          </div>
        </div>
        <div className="px-4 py-2 flex flex-col flex-1 overflow-hidden justify-center">
          <h4 className="font-semibold text-sm text-slate-900 truncate" title={name}>
            {name}
          </h4>
          <p className="text-slate-500 text-xs truncate mt-0.5" title={description}>
            {description}
          </p>
        </div>
      </button>
    );
  }

  const innerContent = (
    <div className="flex flex-row sm:flex-col h-full">
      <div
        className="flex items-center justify-center w-20 h-full flex-shrink-0 rounded-l-lg sm:rounded-t-lg sm:rounded-l-none sm:w-full sm:h-24 relative"
        style={{ backgroundColor: app.color || '#4f46e5' }}
      >
        <div className="w-12 h-12 bg-white/30 rounded-full flex items-center justify-center">
          <Icon name={app.icon || 'lightning-bolt'} size="xl" className="text-white" />
        </div>
        {app.type && app.type !== 'chat' && (
          <div className="absolute bottom-2 right-2 bg-white/90 dark:bg-gray-800/90 px-2 py-0.5 rounded-full text-xs font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1">
            <Icon name={app.type === 'redirect' ? 'external-link' : 'window'} size="xs" />
            {t(`pages.appsList.appTypes.${app.type}`)}
          </div>
        )}
      </div>
      <div className="px-4 py-2 flex flex-col flex-1">
        <h3 className="font-bold text-lg mb-1 break-words">
          {name}
          {isFavorite && (
            <span className="ml-2 hidden sm:inline-block" aria-label="Favorite">
              <Icon name="star" size="sm" className="text-yellow-500" solid={true} />
            </span>
          )}
          {isRecent && (
            <span
              className="ml-1 inline-block"
              aria-label={t('pages.appsList.recent')}
              title={t('pages.appsList.recent')}
            >
              <Icon name="clock" size="sm" className="text-indigo-600" solid={true} />
            </span>
          )}
        </h3>
        <p className="text-gray-600 dark:text-gray-400 text-sm flex-grow">{description}</p>
      </div>
    </div>
  );

  return (
    <div
      className="relative bg-white dark:bg-gray-800 rounded-lg shadow-lg hover:shadow-xl transition-shadow duration-300 w-full max-w-md"
      role="listitem"
    >
      {onToggleFavorite && (
        <button
          onClick={e => {
            e.preventDefault();
            e.stopPropagation();
            onToggleFavorite(e, app.id);
          }}
          className="absolute top-2 right-2 z-10 p-1 bg-white dark:bg-gray-700 bg-opacity-70 rounded-full hover:bg-opacity-100 transition-all"
          title={isFavorite ? t('pages.appsList.unfavorite') : t('pages.appsList.favorite')}
          aria-label={isFavorite ? t('pages.appsList.unfavorite') : t('pages.appsList.favorite')}
        >
          <Icon
            name="star"
            className={isFavorite ? 'text-yellow-500' : 'text-gray-400'}
            solid={isFavorite}
          />
        </button>
      )}
      {href ? (
        <Link to={href} className="block h-full" aria-label={`Open ${name} app`}>
          {innerContent}
        </Link>
      ) : (
        <button
          type="button"
          className="block h-full w-full text-left"
          onClick={() => onClick?.(app)}
        >
          {innerContent}
        </button>
      )}
    </div>
  );
}

export default AppCard;
