import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import Modal from './Modal';
import { DetailsPopupHeader, DetailsPopupFooter } from './DetailsPopup';

function ShortLinkDetailsPopup({ link, isOpen, onClose }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  if (!isOpen || !link) return null;

  const handleTest = () => {
    window.open(`/s/${link.code}`, '_blank');
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidthClassName="max-w-lg">
      <DetailsPopupHeader
        icon="link"
        title={link.code}
        subtitle={`/s/${link.code}`}
        onClose={onClose}
      />

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
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
          {link.expiresAt && (
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {t('admin.shortlinks.expiresAt', 'Expires')}
              </div>
              <div className="text-sm text-gray-900 mt-1">
                {new Date(link.expiresAt).toLocaleString()}
              </div>
            </div>
          )}
          <div className="bg-gray-50 rounded-lg p-3">
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              {t('admin.shortlinks.usage', 'Usage')}
            </div>
            <div className="text-sm text-gray-900 mt-1">{link.usage || 0}</div>
          </div>
        </div>
      </div>

      <DetailsPopupFooter>
        <div className="space-x-2">
          <button
            onClick={handleTest}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            <Icon name="arrow-right" className="w-4 h-4 mr-2" />
            {t('admin.shortlinks.test', 'Test')}
          </button>
          <button
            onClick={() => {
              navigate(`/admin/shortlinks/${link.code}`);
              onClose();
            }}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            <Icon name="pencil" className="w-4 h-4 mr-2" />
            {t('admin.shortlinks.edit', 'Edit')}
          </button>
        </div>
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          {t('common.close', 'Close')}
        </button>
      </DetailsPopupFooter>
    </Modal>
  );
}

export default ShortLinkDetailsPopup;
