// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { formatSnapshotDate, provenanceView } from '../utils/projectProvenance';

const ICONS = { uploaded: 'upload', picked: 'cloud', linked: 'link' };

/**
 * The "uploaded" / "picked" / "linked" marker of a project item or of a
 * citation that came from one (spec 2 §5): *Uploaded*, *Picked from
 * SharePoint · text taken 12 Oct 2026*, *Linked*. Renders nothing for a
 * provenance it does not know (web and iFinder sources carry none).
 *
 * @param {Object} props
 * @param {Object|null} props.provenance - `{ origin, kind?, at?, source? }`
 * @param {{kind?: string, snapshotAt?: string|null}} [props.item] - The item, when known.
 * @param {string} [props.className]
 * @returns {JSX.Element|null}
 */
function provenanceLabel(view, t) {
  if (view.marker === 'uploaded') return t('projects.provenance.uploaded', 'Uploaded');
  if (view.marker === 'linked') return t('projects.provenance.linked', 'Linked');
  if (view.site) {
    return t('projects.provenance.pickedFrom', 'Picked from {{site}}', { site: view.site });
  }
  return t('projects.provenance.picked', 'Picked');
}

function ItemProvenance({ provenance, item, className = '' }) {
  const { t, i18n } = useTranslation();
  const view = provenanceView(provenance, item);
  if (!view) return null;
  const date = formatSnapshotDate(view.at, i18n?.language);
  const label = provenanceLabel(view, t);
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 ${className}`}
      data-testid="item-provenance"
    >
      <Icon name={ICONS[view.marker]} size="xs" />
      <span>{label}</span>
      {date && (
        <>
          <span aria-hidden="true">·</span>
          <span>{t('projects.provenance.snapshot', 'text taken {{date}}', { date })}</span>
        </>
      )}
    </span>
  );
}

export default ItemProvenance;
