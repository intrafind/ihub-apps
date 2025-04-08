import React from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

const ChatMessage = ({ message, outputFormat = 'markdown' }) => {
  const isUser = message.role === 'user';
  const isError = message.error === true;
  const hasVariables = message.variables && Object.keys(message.variables).length > 0;
  
  // Render the message content based on the output format
  const renderContent = () => {
    if (message.loading) {
      return (
        <div className="flex items-center">
          <span>{message.content}</span>
          <span className="ml-2 inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse"></span>
          <span className="ml-1 inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse" style={{ animationDelay: '0.2s' }}></span>
          <span className="ml-1 inline-block w-2 h-2 bg-gray-500 rounded-full animate-pulse" style={{ animationDelay: '0.4s' }}></span>
        </div>
      );
    }
    
    if (isError) {
      return (
        <div className="flex items-center">
          <svg className="w-5 h-5 mr-1.5 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{message.content}</span>
        </div>
      );
    }
    
    if (outputFormat === 'markdown' && !isUser) {
      return (
        <ReactMarkdown
          children={message.content}
          components={{
            code({ node, inline, className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '');
              return !inline && match ? (
                <SyntaxHighlighter
                  children={String(children).replace(/\n$/, '')}
                  style={atomDark}
                  language={match[1]}
                  PreTag="div"
                  {...props}
                />
              ) : (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
          }}
        />
      );
    }
    
    return <div>{message.content}</div>;
  };

  // Render variables if they exist (like target language)
  const renderVariables = () => {
    if (!hasVariables) return null;
    
    return (
      <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {Object.entries(message.variables).map(([key, value]) => (
            <div key={key} className="inline-block mr-3">
              <span className="font-medium">{key}:</span> {value}
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div 
        className={`max-w-4xl rounded-lg px-4 py-3 ${
          isUser 
            ? 'bg-indigo-600 text-white' 
            : isError
              ? 'bg-red-50 border border-red-200 text-red-700'
              : 'bg-white border border-gray-200 text-gray-800'
        }`}
      >
        {renderContent()}
        {isUser && hasVariables && renderVariables()}
      </div>
    </div>
  );
};

export default ChatMessage;