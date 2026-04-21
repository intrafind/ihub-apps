import Icon from '../../../shared/components/Icon';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { officeLocale } from '../utilities/officeLocale';

const AppCard = ({ item, onClick }) => {
  const name = getLocalizedContent(item.name, officeLocale);
  const description = getLocalizedContent(item.description, officeLocale);

  return (
    <div
      className="relative bg-white rounded-lg shadow hover:shadow-md transition-shadow duration-200 w-full flex flex-row cursor-pointer"
      style={{ height: '75px', minHeight: '72px' }}
      role="listitem"
      onClick={() => onClick(item)}
    >
      <div
        className="flex items-center justify-center w-10 h-full flex-shrink-0 rounded-l-lg"
        style={{ backgroundColor: item.color || '#4F46E5' }}
      >
        <div className="w-8 h-8 bg-white/30 rounded-full flex items-center justify-center">
          <Icon name={item.icon} className="w-6 h-6 text-white" />
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
    </div>
  );
};

export default AppCard;
