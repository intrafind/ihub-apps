import { Link } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';

const AdminSectionCard = ({ section }) => {
  return (
    <Link
      to={section.href}
      className="group relative bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md hover:border-gray-300 dark:hover:border-gray-600 transition-all duration-200 overflow-hidden"
    >
      <div className="p-6">
        <div className="flex items-center mb-4">
          <div className={`p-3 rounded-lg ${section.color} flex-shrink-0`}>
            <Icon name={section.icon} className="h-6 w-6 text-white" />
          </div>
          <div className="ml-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400">
              {section.title}
            </h3>
          </div>
        </div>
        <p className="text-gray-600 dark:text-gray-400 text-sm leading-relaxed">
          {section.description}
        </p>
      </div>

      <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        <Icon name="arrow-right" className="h-5 w-5 text-gray-400" />
      </div>
    </Link>
  );
};

export default AdminSectionCard;
