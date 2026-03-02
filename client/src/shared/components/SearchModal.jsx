import { useState, useEffect, useRef } from 'react';
import Fuse from 'fuse.js';
import Icon from './Icon';
import { useTranslation } from 'react-i18next';

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
  const listRef = useRef(null);
  const { t } = useTranslation();

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
    if (!isOpen) {
      setResults([]);
      return;
    }
    if (!query.trim()) {
      // Show all items when no search query (capped at reasonable limit)
      setResults(items.slice(0, 10));
      setSelectedIndex(0);
      return;
    }
    if (!fuseRef.current) {
      setResults([]);
      return;
    }
    const searchResults = fuseRef.current.search(query).map(r => r.item || r);
    setResults(searchResults.slice(0, 10));
    setSelectedIndex(0);
  }, [query, isOpen, items]);

  useEffect(() => {
    if (!listRef.current || results.length === 0) return;

    const selectedElement = listRef.current.children[selectedIndex];
    if (selectedElement) {
      selectedElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest'
      });
    }
  }, [selectedIndex, results]);

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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg w-full max-w-xl mt-20">
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            <Icon name="search" className="text-gray-400 dark:text-gray-500" />
          </div>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyNav}
            placeholder={placeholder}
            className="w-full pl-12 pr-12 py-3 border border-gray-300 dark:border-gray-600 rounded-lg text-base bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 placeholder-gray-400 dark:placeholder-gray-500"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
              aria-label={t('common.clear', 'Clear')}
            >
              <Icon name="x" className="w-5 h-5" />
            </button>
          )}
        </div>
        <ul ref={listRef} className="max-h-64 overflow-y-auto">
          {results.map((item, idx) => (
            <li
              key={idx}
              className={`p-3 cursor-pointer border-b border-gray-100 dark:border-gray-700 last:border-b-0 hover:bg-gray-50 dark:hover:bg-gray-700 ${idx === selectedIndex ? 'bg-indigo-50 dark:bg-indigo-900/50 border-indigo-200 dark:border-indigo-700' : ''}`}
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
