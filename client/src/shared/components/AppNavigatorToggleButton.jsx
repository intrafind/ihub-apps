import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import { useAppNavigatorContext } from '../contexts/AppNavigatorContext';

function AppNavigatorToggleButton() {
  const { t } = useTranslation();
  const { toggle } = useAppNavigatorContext();

  return (
    <button
      onClick={toggle}
      className="text-white"
      aria-label={t('appNavigator.toggle', 'Toggle app navigator')}
      title={t('appNavigator.toggle', 'Toggle app navigator')}
    >
      <Icon name="view-columns" size="lg" className="text-white" />
    </button>
  );
}

export default AppNavigatorToggleButton;
