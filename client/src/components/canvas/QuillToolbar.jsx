import React, { useRef, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ExportMenu from './ExportMenu';
import Icon from '../Icon';
import CanvasVoiceInput from './CanvasVoiceInput';
import './QuillToolbar.css';

const QuillToolbar = ({
  content,
  showExportMenu,
  onToggleExportMenu,
  quillRef, // Add quillRef prop to access the editor instance
  app, // Add app prop for voice input
  onVoiceInput // Add callback for voice input
}) => {
  const { t } = useTranslation();
  const exportMenuRef = useRef(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [currentFormat, setCurrentFormat] = useState({});

  const characterCount = content.replace(/<[^>]*>/g, '').length;

  // Update undo/redo button states and current format
  useEffect(() => {
    if (!quillRef?.current) return;

    const quill = quillRef.current.getEditor();
    const history = quill.getModule('history');

    if (!history) return;

    const updateHistoryState = () => {
      setCanUndo(history.stack.undo.length > 0);
      setCanRedo(history.stack.redo.length > 0);
    };

    const updateCurrentFormat = () => {
      const range = quill.getSelection();
      if (range) {
        const format = quill.getFormat(range);
        setCurrentFormat(format);
      }
    };

    // Update state on text changes and selection changes
    quill.on('text-change', updateHistoryState);
    quill.on('selection-change', updateCurrentFormat);

    // Initial state
    updateHistoryState();
    updateCurrentFormat();

    return () => {
      quill.off('text-change', updateHistoryState);
      quill.off('selection-change', updateCurrentFormat);
    };
  }, [quillRef, content]);

  // Handle undo action
  const handleUndo = () => {
    if (!quillRef?.current || !canUndo) return;
    const quill = quillRef.current.getEditor();
    const history = quill.getModule('history');
    if (history) {
      history.undo();
    }
  };

  // Handle redo action
  const handleRedo = () => {
    if (!quillRef?.current || !canRedo) return;
    const quill = quillRef.current.getEditor();
    const history = quill.getModule('history');
    if (history) {
      history.redo();
    }
  };

  // Handle outside clicks to close export menu
  useEffect(() => {
    if (!showExportMenu) return;

    const handleClickOutside = event => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target)) {
        onToggleExportMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showExportMenu, onToggleExportMenu]);

  // Helper function to maintain focus and selection
  const applyFormatWithFocus = (formatName, formatValue) => {
    if (!quillRef?.current) return;
    const quill = quillRef.current.getEditor();

    // Store current selection
    const range = quill.getSelection(true); // Force focus

    if (range) {
      // Apply format
      if (formatValue !== undefined) {
        quill.format(formatName, formatValue);
      } else {
        const currentFormat = quill.getFormat(range);
        quill.format(formatName, !currentFormat[formatName]);
      }

      // Restore selection and focus
      quill.setSelection(range);
      quill.focus();
    }
  };

  return (
    <>
      {/* Hidden Quill Toolbar */}
      <div id="quill-toolbar" style={{ display: 'none' }}>
        <select className="ql-header" defaultValue="">
          <option value="1"></option>
          <option value="2"></option>
          <option value="3"></option>
          <option value=""></option>
        </select>
        <button className="ql-bold"></button>
        <button className="ql-italic"></button>
        <button className="ql-underline"></button>
        <button className="ql-list" value="ordered"></button>
        <button className="ql-list" value="bullet"></button>
        <button className="ql-blockquote"></button>
        <button className="ql-code-block"></button>
        <button className="ql-link"></button>
        <button className="ql-undo">
          <svg fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M7.707 3.293a1 1 0 010 1.414L5.414 7H11a7 7 0 017 7v2a1 1 0 11-2 0v-2a5 5 0 00-5-5H5.414l2.293 2.293a1 1 0 11-1.414 1.414L2.586 8l3.707-3.707a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <button className="ql-redo">
          <svg fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M12.293 3.293a1 1 0 011.414 0L17.414 7l-3.707 3.707a1 1 0 01-1.414-1.414L14.586 7H9a5 5 0 00-5 5v2a1 1 0 11-2 0v-2a7 7 0 017-7h5.586L12.293 4.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      {/* Custom Modern Toolbar */}
      <div className="modern-toolbar bg-white border-b border-gray-300 px-4 py-3">
        <div className="flex items-center justify-between w-full">
          {/* Left side - Formatting tools */}
          <div className="flex items-center gap-2">
            {/* Text style dropdown */}
            <div className="relative">
              <select
                className="modern-select bg-white border border-gray-300 rounded px-3 h-8 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                onChange={e => {
                  const headerValue = e.target.value;
                  if (headerValue === '') {
                    applyFormatWithFocus('header', false);
                  } else {
                    applyFormatWithFocus('header', parseInt(headerValue));
                  }
                }}
                value={currentFormat.header || ''}
              >
                <option value="1">Heading 1</option>
                <option value="2">Heading 2</option>
                <option value="3">Heading 3</option>
                <option value="">Normal text</option>
              </select>
            </div>

            <div className="border-l border-gray-300 h-6 mx-2"></div>

            {/* Formatting buttons */}
            <div className="flex items-center">
              <button
                className={`modern-btn ${currentFormat.bold ? 'ql-active' : ''}`}
                title="Bold"
                onClick={() => applyFormatWithFocus('bold')}
              >
                <strong>B</strong>
              </button>
              <button
                className={`modern-btn ${currentFormat.italic ? 'ql-active' : ''}`}
                title="Italic"
                onClick={() => applyFormatWithFocus('italic')}
              >
                <em>I</em>
              </button>
              <button
                className={`modern-btn ${currentFormat.underline ? 'ql-active' : ''}`}
                title="Underline"
                onClick={() => applyFormatWithFocus('underline')}
              >
                <u>U</u>
              </button>
            </div>

            <div className="border-l border-gray-300 h-6 mx-2"></div>

            {/* List buttons */}
            <div className="flex items-center">
              <button
                className={`modern-btn ${currentFormat.list === 'bullet' ? 'ql-active' : ''}`}
                title="Bullet List"
                onClick={() => {
                  if (!quillRef?.current) return;
                  const quill = quillRef.current.getEditor();
                  const range = quill.getSelection();
                  if (range) {
                    const currentFormat = quill.getFormat(range);
                    quill.format('list', currentFormat.list === 'bullet' ? false : 'bullet');
                  }
                }}
              >
                <Icon name="list" size="sm" />
              </button>
              <button
                className={`modern-btn ${currentFormat.list === 'ordered' ? 'ql-active' : ''}`}
                title="Numbered List"
                onClick={() => {
                  if (!quillRef?.current) return;
                  const quill = quillRef.current.getEditor();
                  const range = quill.getSelection();
                  if (range) {
                    const currentFormat = quill.getFormat(range);
                    quill.format('list', currentFormat.list === 'ordered' ? false : 'ordered');
                  }
                }}
              >
                <span className="text-xs font-bold">1.</span>
              </button>
            </div>

            <div className="border-l border-gray-300 h-6 mx-2"></div>

            {/* Additional formatting */}
            <div className="flex items-center">
              <button
                className={`modern-btn ${currentFormat.blockquote ? 'ql-active' : ''}`}
                title="Quote"
                onClick={() => {
                  if (!quillRef?.current) return;
                  const quill = quillRef.current.getEditor();
                  const range = quill.getSelection();
                  if (range) {
                    const currentFormat = quill.getFormat(range);
                    quill.format('blockquote', !currentFormat.blockquote);
                  }
                }}
              >
                <span>"</span>
              </button>
              <button
                className={`modern-btn ${currentFormat['code-block'] ? 'ql-active' : ''}`}
                title="Code"
                onClick={() => {
                  if (!quillRef?.current) return;
                  const quill = quillRef.current.getEditor();
                  const range = quill.getSelection();
                  if (range) {
                    const currentFormat = quill.getFormat(range);
                    quill.format('code-block', !currentFormat['code-block']);
                  }
                }}
              >
                <Icon name="code" size="sm" />
              </button>
              <button
                className={`modern-btn ${currentFormat.link ? 'ql-active' : ''}`}
                title="Link"
                onClick={() => {
                  if (!quillRef?.current) return;
                  const quill = quillRef.current.getEditor();
                  const range = quill.getSelection();
                  if (range && range.length > 0) {
                    const currentFormat = quill.getFormat(range);
                    if (currentFormat.link) {
                      quill.format('link', false);
                    } else {
                      // TODO: Replace with a proper UI modal for link input.
                      const url = prompt('Enter URL:');
                      if (url) {
                        quill.format('link', url);
                      }
                    }
                  }
                }}
              >
                <span>🔗</span>
              </button>
            </div>

            <div className="border-l border-gray-300 h-6 mx-2"></div>

            {/* Undo/Redo buttons */}
            <div className="flex items-center">
              <button
                className={`modern-btn ${!canUndo ? 'disabled' : ''}`}
                title="Undo"
                onClick={handleUndo}
                disabled={!canUndo}
              >
                <Icon name="undo" size="sm" />
              </button>
              <button
                className={`modern-btn ${!canRedo ? 'disabled' : ''}`}
                title="Redo"
                onClick={handleRedo}
                disabled={!canRedo}
              >
                <Icon name="redo" size="sm" />
              </button>
            </div>

            <div className="border-l border-gray-300 h-6 mx-2"></div>

            {/* Voice Input */}
            {app && (
              <div className="flex items-center">
                <CanvasVoiceInput
                  app={app}
                  quillRef={quillRef}
                  onSpeechResult={onVoiceInput}
                  disabled={false}
                />
              </div>
            )}
          </div>

          {/* Right side - Word count and actions */}
          <div className="flex items-center gap-3">
            <div className="text-sm text-gray-500 px-3 py-1 bg-gray-50 rounded border border-gray-200">
              {characterCount} characters
            </div>

            <div className="relative" ref={exportMenuRef}>
              <button
                onClick={() => onToggleExportMenu(!showExportMenu)}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                title={t('canvas.export.title', 'Export Document')}
                type="button"
              >
                <span>⬇</span>
                <span>{t('canvas.export.export', 'Export')}</span>
              </button>
              {showExportMenu && (
                <ExportMenu content={content} onClose={() => onToggleExportMenu(false)} />
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default QuillToolbar;
