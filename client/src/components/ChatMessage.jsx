import React from 'react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

const ChatMessage = ({ message, outputFormat = 'markdown' }) => {
  const isUser = message.role === 'user';
  const isError = message.error === true;
  
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
      </div>
    </div>
  );
};

export default ChatMessage;