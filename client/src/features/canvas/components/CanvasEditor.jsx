import { useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';
import Icon from '../../../shared/components/Icon';
import QuillToolbar from './QuillToolbar';
import { htmlToMarkdown, markdownToHtml, isMarkdown } from '../../../utils/markdownUtils';

const CanvasEditor = ({
  content,
  onContentChange,
  onSelectionChange,
  processing,
  showExportMenu,
  onToggleExportMenu,
  editorRef,
  width,
  app, // Add app prop for voice input
  onVoiceInput // Add callback for voice input
}) => {
  const { t } = useTranslation();

  // Quill editor configuration
  const quillModules = useMemo(
    () => ({
      toolbar: {
        container: '#quill-toolbar'
      },
      history: {
        delay: 2000,
        maxStack: 500,
        userOnly: true
      },
      clipboard: {
        matchVisual: false
      }
    }),
    []
  );

  const quillFormats = [
    'header',
    'bold',
    'italic',
    'underline',
    'strike',
    'list',
    'bullet',
    'blockquote',
    'code-block',
    'link'
  ];

  // Custom clipboard handlers for cut/copy/paste
  useEffect(() => {
    if (!editorRef?.current) return;
    const quill = editorRef.current.getEditor();
    const Quill = ReactQuill.Quill;
    const temp = new Quill(document.createElement('div'));

    const handleCopyCut = (e, cut = false) => {
      const sel = quill.getSelection();
      if (!sel || sel.length === 0) return;
      e.preventDefault();
      const delta = quill.getContents(sel.index, sel.length);
      temp.setContents(delta);
      const html = temp.root.innerHTML;
      const markdown = htmlToMarkdown(html);
      const plain = temp.root.textContent || temp.root.innerText || '';
      e.clipboardData.setData('text/plain', plain);
      e.clipboardData.setData('text/html', html);
      e.clipboardData.setData('text/markdown', markdown);
      if (cut) quill.deleteText(sel.index, sel.length, 'user');
    };

    const handlePaste = e => {
      e.preventDefault();
      const htmlData = e.clipboardData.getData('text/html');
      const mdData = e.clipboardData.getData('text/markdown');
      const textData = e.clipboardData.getData('text/plain');
      let html = htmlData;
      if (!html) {
        if (mdData) {
          html = markdownToHtml(mdData);
        } else if (isMarkdown(textData)) {
          html = markdownToHtml(textData);
        } else {
          html = textData;
        }
      }
      const sel = quill.getSelection(true);
      const index = sel ? sel.index : quill.getLength();
      quill.clipboard.dangerouslyPasteHTML(index, html);
      quill.setSelection(index + html.length, 0);
    };

    const root = quill.root;
    const copyHandler = e => handleCopyCut(e, false);
    const cutHandler = e => handleCopyCut(e, true);
    root.addEventListener('copy', copyHandler);
    root.addEventListener('cut', cutHandler);
    root.addEventListener('paste', handlePaste);

    return () => {
      root.removeEventListener('copy', copyHandler);
      root.removeEventListener('cut', cutHandler);
      root.removeEventListener('paste', handlePaste);
    };
  }, [editorRef]);

  return (
    <div
      className="flex flex-col bg-white border border-gray-300 relative h-full min-h-0 rounded-lg overflow-hidden"
      style={{ width: `${width}%` }}
    >
      {/* Custom Quill Toolbar */}
      <QuillToolbar
        content={content}
        showExportMenu={showExportMenu}
        onToggleExportMenu={onToggleExportMenu}
        quillRef={editorRef}
        app={app}
        onVoiceInput={onVoiceInput}
      />

      {/* Canvas Editor */}
      <div className="canvas-editor-container flex-1 min-h-0 overflow-hidden relative bg-white">
        {processing && (
          <div className="processing-indicator absolute top-6 right-6 z-10 bg-white text-gray-700 px-4 py-2 rounded-full shadow-lg border border-gray-200 flex items-center gap-3 text-sm">
            <div className="flex items-center justify-center w-4 h-4">
              <div className="w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
            </div>
            <span className="font-medium">{t('canvas.aiProcessing', 'AI is working...')}</span>
          </div>
        )}
        <div className="h-full">
          <ReactQuill
            ref={editorRef}
            theme="snow"
            value={content}
            onChange={onContentChange}
            onChangeSelection={onSelectionChange}
            modules={quillModules}
            formats={quillFormats}
            placeholder={t(
              'canvas.placeholder',
              'Start typing or use the AI assistant to create your document...'
            )}
            style={{ height: '100%' }}
            className="modern-canvas-editor"
          />
        </div>
      </div>
    </div>
  );
};

export default CanvasEditor;
