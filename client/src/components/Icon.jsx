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

      case 'arrowLeft':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M11 7l-5 5 5 5M19 12H6" />
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
        
      case 'paper-clip':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
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
        
      case 'camera':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
            <path d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        );
        
      case 'photo':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        );
        
      case 'textLines':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        );
        
      case 'singleLine':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M4 12h16" />
          </svg>
        );
        
      case 'apps-svg-logo':
        return (
          <svg 
            className={combinedClassName}
            viewBox="0 0 99 94" 
            xmlns="http://www.w3.org/2000/svg"
            xmlnsXlink="http://www.w3.org/1999/xlink"
            xmlSpace="preserve"
            overflow="hidden"
            {...defaultStyle}
          >
            <defs>
              <clipPath id="clip0">
                <rect x="136" y="936" width="99" height="94"/>
              </clipPath>
              <image 
                width="94" 
                height="94" 
                xlinkHref="data:image/png;base64,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" 
                preserveAspectRatio="none" 
                id="img1"
              />
              <clipPath id="clip2">
                <path d="M136 951.67C136 943.016 143.016 936 151.67 936L219.33 936C227.985 936 235 943.016 235 951.67L235 1014.33C235 1022.98 227.985 1030 219.33 1030L151.67 1030C143.016 1030 136 1022.98 136 1014.33Z" fillRule="evenodd" clipRule="evenodd"/>
              </clipPath>
            </defs>
            <g clipPath="url(#clip0)" transform="translate(-136 -936)">
              <g clipPath="url(#clip2)">
                <use width="100%" height="100%" xlinkHref="#img1" transform="matrix(1.05319 0 0 0.999998 136 936)"></use>
              </g>
            </g>
          </svg>
        );  

      case 'user':
        return (
          <svg className={combinedClassName} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...defaultStyle}>
            <path d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
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