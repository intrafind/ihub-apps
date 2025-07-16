import React, { useState, useEffect, useRef } from 'react';
import Fuse from 'fuse.js';
import Icon from './Icon';

const SearchModal = ({
  isOpen,
  onClose,
  onSelect,
  items = [],
  fuseKeys = [],
  placeholder = '',
  renderResult
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  const fuseRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    fuseRef.current = new Fuse(items, { keys: fuseKeys, threshold: 0.4 });
    setQuery('');
    setResults([]);
    setSelectedIndex(0);
  }, [isOpen, items, fuseKeys]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = e => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || !query.trim() || !fuseRef.current) {
      setResults([]);
      return;
    }
    const searchResults = fuseRef.current.search(query).map(r => r.item || r);
    setResults(searchResults.slice(0, 5));
    setSelectedIndex(0);
  }, [query, isOpen]);

  const handleKeyNav = e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      onSelect(results[selectedIndex]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-xl mt-20">
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <Icon name="search" className="text-gray-400" />
          </div>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyNav}
            placeholder={placeholder}
            className="w-full pl-12 pr-12 py-3 border rounded-lg text-base focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600"
              aria-label="Clear"
            >
              <Icon name="x" className="w-5 h-5" />
            </button>
          )}
        </div>
        <ul className="max-h-64 overflow-y-auto">
          {results.map((item, idx) => (
            <li
              key={idx}
              className={`p-3 cursor-pointer border-b border-gray-100 last:border-b-0 hover:bg-gray-50 ${idx === selectedIndex ? 'bg-indigo-50 border-indigo-200' : ''}`}
              onMouseDown={() => onSelect(item)}
            >
              {renderResult ? renderResult(item) : JSON.stringify(item)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

export default SearchModal;
