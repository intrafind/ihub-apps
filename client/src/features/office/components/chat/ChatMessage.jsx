import { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { marked } from 'marked';
import { ClipboardDocumentIcon } from '@heroicons/react/24/outline';
import LoadingIndicator from './LoadingIndicator';
import { displayReplyFormWithAssistantResponse } from '../../utilities/replyForm';

const ChatMessage = ({
  role = 'assistant',
  content,
  timestamp,
  children,
  loading = false,
  markdown = false
}) => {
  const isUser = role === 'user';
  const [copied, setCopied] = useState(false);

  const textToCopy = content ?? '';

  const handleCopy = useCallback(() => {
    if (!textToCopy) return;
    const html = marked.parse(textToCopy);
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    };
    if (
      navigator.clipboard &&
      typeof navigator.clipboard.write === 'function' &&
      typeof ClipboardItem !== 'undefined'
    ) {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([textToCopy], { type: 'text/plain' })
      });
      navigator.clipboard
        .write([item])
        .then(done)
        .catch(() => {
          navigator.clipboard
            .writeText(textToCopy)
            .then(done)
            .catch(() => {});
        });
    } else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard
        .writeText(textToCopy)
        .then(done)
        .catch(() => {});
    }
  }, [textToCopy]);

  const handleInsert = useCallback(() => {
    if (!textToCopy.trim()) return;
    displayReplyFormWithAssistantResponse(textToCopy);
  }, [textToCopy]);

  const showCopy = !isUser && !loading && textToCopy.length > 0;
  const awaitingAssistantContent = !isUser && loading && !String(content ?? '').trim();

  if (awaitingAssistantContent) {
    return (
      <div className="flex w-full justify-start mb-3" data-role={role}>
        <div className="inline-flex w-fit max-w-[85%] shrink-0 items-center rounded-2xl rounded-bl-md border-2 border-slate-200 bg-white px-3 py-2">
          <LoadingIndicator />
        </div>
      </div>
    );
  }

  if (!isUser && markdown && !String(content ?? '').trim()) {
    return null;
  }

  return (
    <div
      className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'} mb-3`}
      data-role={role}
    >
      <div
        className={`group flex max-w-[85%] flex-col gap-1 ${isUser ? 'items-end' : 'w-full items-stretch'}`}
      >
        <div
          className={`w-full rounded-2xl px-4 py-2.5 ${
            isUser
              ? 'bg-[#f0f0f0] text-slate-900 rounded-br-md'
              : 'bg-white text-slate-900 rounded-bl-md border-2 border-slate-200'
          }`}
        >
          {children ??
            (markdown && !isUser ? (
              <div className="text-sm break-words text-slate-900 [&_p]:mb-2 [&_p:last-child]:mb-0 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold [&_strong]:font-semibold [&_a]:text-blue-600 [&_a]:underline [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-slate-100 [&_pre]:p-2 [&_blockquote]:border-l-4 [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:italic">
                <ReactMarkdown>{content}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm whitespace-pre-wrap break-words">{content}</p>
            ))}
          {timestamp && (
            <p className={`text-xs mt-1 ${isUser ? 'opacity-90' : 'text-slate-500'}`}>
              {timestamp}
            </p>
          )}
        </div>
        {showCopy && (
          <div className="flex w-full justify-end items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              onClick={handleInsert}
              className="inline-flex items-center justify-center rounded-md px-2 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
              title="Insert into reply"
              aria-label="Insert"
            >
              Insert
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center justify-center rounded-md p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
              title={copied ? 'Copied' : 'Copy message'}
              aria-label={copied ? 'Copied' : 'Copy message'}
            >
              <ClipboardDocumentIcon className="h-4 w-4 shrink-0" aria-hidden />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatMessage;
