// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import {
  recognitionLabel,
  recognitionOf,
  recognitionTitle
} from '../../upload/utils/textRecognition';

/**
 * "Text recognized from 3 page(s)" under a project document whose text, or part
 * of it, the text recognition model read at upload (#3986, `item.text.recognized`):
 * an image, or the pages of a PDF without a text layer. "…from the first 50
 * page(s) only" when the page limit cut it. The model is named in the tooltip.
 * Renders nothing for a document whose text was extracted as usual.
 *
 * @param {Object} props
 * @param {{text?: {recognized?: {modelId: string, pages: number, truncated?: boolean}}}|null} props.item
 * @param {string} [props.className]
 * @returns {JSX.Element|null}
 */
function ItemRecognition({ item, className = '' }) {
  const { t } = useTranslation();
  const recognized = item?.text ? recognitionOf(item.text) : null;
  if (!recognized) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 ${className}`}
      title={recognitionTitle(recognized, t)}
      data-testid="item-recognition"
    >
      <Icon name="eye" size="xs" />
      <span>{recognitionLabel(recognized, t)}</span>
    </span>
  );
}

export default ItemRecognition;
