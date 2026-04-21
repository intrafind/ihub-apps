import { useRef, useEffect } from 'react';
import { ArrowUpIcon, StopIcon } from '@heroicons/react/24/solid';

const MAX_HEIGHT = 70;

const ChatInput = ({
  value = '',
  onChange,
  onSubmit,
  placeholder = 'Type your message here . . .',
  disabled = false,
  isStreaming = false,
  onStop,
  allowEmptyContent = false
}) => {
  const textareaRef = useRef(null);

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const nextHeight = Math.min(el.scrollHeight, MAX_HEIGHT);
    el.style.height = `${nextHeight}px`;
  };

  const handleKeyDown = e => {
    if (isStreaming) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const trimmed = value.trim();
      if ((trimmed || allowEmptyContent) && onSubmit) onSubmit(trimmed);
    }
  };

  const handleSendClick = () => {
    if (isStreaming) return;
    const trimmed = value.trim();
    if ((trimmed || allowEmptyContent) && onSubmit) onSubmit(trimmed);
  };

  useEffect(() => {
    resizeTextarea();
  }, [value]);

  return (
    <div className="w-full px-2 py-1 bg-white border-t border-[#e0e0e0] shrink-0">
      <div className="flex items-center w-full gap-1.5 rounded-xl bg-white border border-gray-300 focus-within:border-indigo-400 focus-within:ring-1 focus-within:ring-indigo-400">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => onChange?.(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || isStreaming}
          rows={1}
          className="flex-1 min-w-0 resize-none overflow-y-auto py-3 pl-3 pr-2 bg-transparent border-0 outline-none ring-0 text-slate-900 placeholder:text-slate-500 text-sm rounded-l-xl leading-5"
        />
        {isStreaming && typeof onStop === 'function' ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className="rounded-full p-1.5 text-slate-700 hover:bg-slate-200 shrink-0 self-center mr-1"
          >
            <StopIcon className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          onSubmit && (
            <button
              type="button"
              onClick={handleSendClick}
              disabled={disabled || (!value.trim() && !allowEmptyContent)}
              aria-label="Send"
              className="rounded-full p-1.5 text-slate-600 hover:bg-slate-200 shrink-0 self-center mr-1 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ArrowUpIcon className="h-4 w-4" aria-hidden />
            </button>
          )
        )}
      </div>
    </div>
  );
};

export default ChatInput;
