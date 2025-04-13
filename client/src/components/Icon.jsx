import React from 'react';

/**
 * Icon component for rendering SVG icons consistently throughout the application.
 * 
 * @param {Object} props - Component props
 * @param {string} props.name - Icon name (e.g., 'check', 'exclamation-circle', etc.)
 * @param {string} [props.size='md'] - Icon size (xs, sm, md, lg, xl, 2xl)
 * @param {string} [props.className=''] - Additional CSS classes
 * @param {boolean} [props.solid=false] - Whether to use solid fill or outline style
 * @returns {React.ReactElement} SVG icon
 */
const Icon = ({ name, size = 'md', className = '', solid = false }) => {
  // Define size classes
  const sizeClasses = {
    'xs': 'w-3 h-3',
    'sm': 'w-4 h-4',
    'md': 'w-5 h-5', 
    'lg': 'w-6 h-6',
    'xl': 'w-8 h-8',
    '2xl': 'w-12 h-12'
  };
  
  // Default stroke/fill configuration
  const defaultStyle = solid
    ? { fill: 'currentColor', stroke: 'none' }
    : { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
  
  // Combine the size class with any additional classes
  const combinedClassName = `${sizeClasses[size] || sizeClasses.md} ${className}`;
  
  // Icon paths based on name
  const renderIcon = () => {
    switch (name) {
      case 'check':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M5 13l4 4L19 7" />
          </svg>
        );
      
      case 'check-circle':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
        
      case 'exclamation-circle':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
        
      case 'copy':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
          </svg>
        );
        
      case 'edit':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        );
        
      case 'refresh':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        );
        
      case 'trash':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        );
        
      case 'thumbs-up':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905a3.61 3.61 0 01-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
          </svg>
        );
        
      case 'thumbs-down':
        return (
          <svg className={combinedClassName} transform="rotate(180)" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905a3.61 3.61 0 01-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
          </svg>
        );
        
      case 'chat':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        );
        
      case 'download':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
        );
        
      case 'star':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
          </svg>
        );
        
      case 'microphone':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        );

      case 'app-window':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
          </svg>
        );

      case 'settings':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        );

      case 'arrowRight':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M13 7l5 5-5 5M5 12h13" />
          </svg>
        );

      case 'sparkles':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
          </svg>
        );
        
      case 'chat-bubbles':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        );
        
      case 'globe':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
        
      case 'document-text':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        );
        
      case 'mail':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        );
        
      case 'light-bulb':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
        );
        
      case 'code':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
        );
        
      case 'users':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
        );

      case 'search':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        );
        
      case 'x':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        );
        
      case 'close':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        );
        
      case 'sliders':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
          </svg>
        );
        
      case 'clearCircle':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
        
      case 'lightning-bolt':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        );

      case 'calendar':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        );
        
      case 'document-search':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M10 21H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2h-3m-3-4l2 2m0 0l2-2m-2 2v-4m-5-7h.01M9 3v4a2 2 0 002 2h4a2 2 0 002-2V5.414a1 1 0 00-.293-.707L14.293 3H13" />
          </svg>
        );
        
      case 'question-mark-circle':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
        
      case 'share':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
          </svg>
        );

      default:
        console.warn(`Icon "${name}" not found`);
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
    }
  };

  return renderIcon();
};

export default Icon;