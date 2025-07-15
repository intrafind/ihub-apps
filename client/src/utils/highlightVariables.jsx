import React from 'react';

export const highlightVariables = text =>
  text.split(/(\[[^\]]+\])/g).map((part, idx) =>
    part.startsWith('[') && part.endsWith(']') ? (
      <span key={idx} className="text-indigo-600 font-semibold">
        {part}
      </span>
    ) : (
      <span key={idx}>{part}</span>
    )
  );
