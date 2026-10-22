// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef } from 'react';
import Icon from '../../../shared/components/Icon';

/**
 * Button that opens a file picker. The native input is visually hidden and
 * skipped by Tab; the button is the single, labelled control for mouse, touch
 * and keyboard users (an invisible input stretched over a button is focusable
 * with no label and no visible focus ring).
 */
function UploadConfigButton({ onChange, uploading = false, label, uploadingLabel, title }) {
  const inputRef = useRef(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".json"
        onChange={onChange}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        disabled={uploading}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="inline-flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-xs hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={uploading}
        title={title}
      >
        <Icon
          name={uploading ? 'refresh' : 'upload'}
          className={`h-4 w-4 mr-2 ${uploading ? 'animate-spin' : ''}`}
        />
        {uploading ? uploadingLabel : label}
      </button>
    </>
  );
}

export default UploadConfigButton;
