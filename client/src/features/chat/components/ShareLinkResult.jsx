// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

export const shareInputClass =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-indigo-500';

/**
 * The iframe markup that embeds a shared artifact's embed page.
 *
 * @param {string} embedUrl - Absolute URL of the embed page.
 * @returns {string}
 */
export function embedSnippet(embedUrl) {
  const safe = String(embedUrl).replace(/"/g, '%22');
  return `<iframe src="${safe}" width="100%" height="480" style="border:0" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
}

/**
 * A small copy-to-clipboard button that says when it worked.
 *
 * @param {Object} props - Component properties.
 * @param {string} props.text - What to copy.
 * @param {string} [props.label] - Button text (default: "Copy link").
 * @param {string} [props.className] - Extra classes.
 * @returns {JSX.Element}
 */
export function CopyLinkButton({ text, label, className = '' }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard (insecure context, denied): the link stays selectable.
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 whitespace-nowrap ${className}`}
    >
      <Icon name={copied ? 'check' : 'copy'} size="sm" />
      {copied ? t('chatSharing.copied', 'Copied') : label || t('chatSharing.copy', 'Copy link')}
    </button>
  );
}

/**
 * The box a share form turns into once its link exists: the URL, a copy
 * button and a way back to the form for another link.
 *
 * @param {Object} props - Component properties.
 * @param {string} props.url - The new link.
 * @param {string|null} [props.embedUrl] - The embed page, for an embeddable link.
 * @param {() => void} props.onCreateAnother - Back to the form.
 * @returns {JSX.Element}
 */
export default function ShareLinkResult({ url, embedUrl = null, onCreateAnother }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-4 space-y-3">
      <div className="flex items-center gap-2 text-green-800 dark:text-green-200 font-semibold">
        <Icon name="check-circle" size="sm" />
        {t('chatSharing.created', 'Link created')}
      </div>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={url}
          onFocus={e => e.target.select()}
          aria-label={t('chatSharing.linkLabel', 'Share link')}
          className={`${shareInputClass} font-mono text-xs`}
        />
        <CopyLinkButton text={url} />
      </div>
      {embedUrl && (
        <div className="space-y-1.5">
          <label
            htmlFor="share-embed-code"
            className="block text-sm font-medium text-green-900 dark:text-green-100"
          >
            {t('chatSharing.embed.codeLabel', 'Embed code')}
          </label>
          <div className="flex items-start gap-2">
            <textarea
              id="share-embed-code"
              readOnly
              rows={3}
              value={embedSnippet(embedUrl)}
              onFocus={e => e.target.select()}
              className={`${shareInputClass} font-mono text-xs`}
            />
            <CopyLinkButton
              text={embedSnippet(embedUrl)}
              label={t('chatSharing.embed.copy', 'Copy embed code')}
            />
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={onCreateAnother}
        className="text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
      >
        {t('chatSharing.createAnother', 'Create another link')}
      </button>
    </div>
  );
}
