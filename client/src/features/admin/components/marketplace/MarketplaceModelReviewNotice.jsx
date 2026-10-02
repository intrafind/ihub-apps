import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';

/**
 * Asks the admin to review a model from the marketplace before testing or
 * enabling it: the model's endpoint URL comes with the item, and testing or
 * using the model sends the provider API key and the prompts there.
 *
 * @param {Object} props
 * @param {string} [props.className] - Extra classes for the outer element
 */
function MarketplaceModelReviewNotice({ className = '' }) {
  const { t } = useTranslation();
  return (
    <div
      role="note"
      className={`flex gap-3 p-4 rounded-lg border bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700 ${className}`}
    >
      <Icon
        name="exclamation-triangle"
        className="h-5 w-5 shrink-0 text-amber-500 dark:text-amber-400"
      />
      <div className="text-sm text-amber-800 dark:text-amber-200">
        <p className="font-medium">
          {t(
            'admin.marketplace.modelReview.title',
            'Review this model before you test or enable it'
          )}
        </p>
        <p className="mt-1">
          {t(
            'admin.marketplace.modelReview.body',
            'Models from the marketplace bring their own settings, including the endpoint URL. Testing or using the model sends your provider API key and the prompts to that endpoint, so check the URL and settings first.'
          )}
        </p>
      </div>
    </div>
  );
}

export default MarketplaceModelReviewNotice;
