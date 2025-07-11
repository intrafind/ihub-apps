import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';

const ShortLinkDetailsPopup = ({ link, isOpen, onClose }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  if (!isOpen || !link) return null;

  const handleTest = () => {
    window.open(`/s/${link.code}`, '_blank');
  };

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50 flex items-center justify-center p-4">
      <div className="relative bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between rounded-t-lg">
          <div className="flex items-center space-x-3">
            <div className="w-12 h-12 rounded-lg bg-indigo-100 flex items-center justify-center">
              <Icon name="link" className="w-6 h-6 text-indigo-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">{link.code}</h3>
              <p className="text-sm text-gray-500">/s/{link.code}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
            <Icon name="x" className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 gap-4">
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {t('admin.shortlinks.appId', 'App ID')}
              </div>
              <div className="text-sm text-gray-900 mt-1">{link.appId}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {t('admin.shortlinks.userId', 'User ID')}
              </div>
              <div className="text-sm text-gray-900 mt-1">{link.userId || '-'}</div>
            </div>
            {link.url && (
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t('admin.shortlinks.url', 'Redirect URL')}
                </div>
                <div className="text-sm text-gray-900 break-all mt-1">{link.url}</div>
              </div>
            )}
            {link.path && (
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t('admin.shortlinks.path', 'Path')}
                </div>
                <div className="text-sm text-gray-900 mt-1">{link.path}</div>
              </div>
            )}
            {link.params && Object.keys(link.params).length > 0 && (
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t('admin.shortlinks.params', 'Params')}
                </div>
                <pre className="text-sm text-gray-900 whitespace-pre-wrap break-all mt-1">
{JSON.stringify(link.params, null, 2)}
                </pre>
              </div>
            )}
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {t('admin.shortlinks.includeParams', 'Include Params')}
              </div>
              <div className="text-sm text-gray-900 mt-1">{String(link.includeParams)}</div>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {t('admin.shortlinks.usage', 'Usage')}
              </div>
              <div className="text-sm text-gray-900 mt-1">{link.usage || 0}</div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-gray-50 border-t border-gray-200 px-6 py-4 flex justify-between items-center rounded-b-lg">
          <div className="space-x-2">
            <button onClick={handleTest} className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">
              <Icon name="arrow-right" className="w-4 h-4 mr-2" />
              {t('admin.shortlinks.test', 'Test')}
            </button>
            <button onClick={() => { navigate(`/admin/shortlinks/${link.code}`); onClose(); }} className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">
              <Icon name="pencil" className="w-4 h-4 mr-2" />
              {t('admin.shortlinks.edit', 'Edit')}
            </button>
          </div>
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">
            {t('common.close', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ShortLinkDetailsPopup;
