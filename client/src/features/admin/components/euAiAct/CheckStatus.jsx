// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Badge from '../../../../shared/components/Badge';
import Icon from '../../../../shared/components/Icon';

/** Level -> Badge tone, icon (a different shape per level) and word. Never colour alone. */
const LEVELS = {
  ok: { tone: 'success', icon: 'check-circle', key: 'ok', fallback: 'OK' },
  warn: { tone: 'warning', icon: 'exclamation-triangle', key: 'warn', fallback: 'Attention' },
  error: { tone: 'danger', icon: 'x-circle', key: 'error', fallback: 'Failing' },
  off: { tone: 'neutral', icon: 'minus-circle', key: 'off', fallback: 'Off' }
};

/**
 * The state of one check as icon plus word.
 *
 * @param {{level: 'ok'|'warn'|'error'|'off', className?: string}} props
 */
export default function CheckStatus({ level, className = '' }) {
  const { t } = useTranslation();
  const spec = LEVELS[level] || LEVELS.off;
  return (
    <Badge
      tone={spec.tone}
      icon={<Icon name={spec.icon} size="sm" />}
      className={className}
      data-level={level}
    >
      {t(`admin.euAiAct.level.${spec.key}`, spec.fallback)}
    </Badge>
  );
}
