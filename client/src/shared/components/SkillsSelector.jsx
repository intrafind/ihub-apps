import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import { fetchSkills } from '../../api/endpoints/skills';

/**
 * SkillsSelector - Multi-select component for choosing skills to assign to an app.
 *
 * Follows the same pattern as ToolsSelector but adapted for skills.
 * Skills have a `name` (unique identifier) and a `description` field
 * instead of localized name/description objects.
 *
 * @param {Object} props
 * @param {string[]} props.selectedSkills - Array of selected skill name strings
 * @param {Function} props.onSkillsChange - Callback receiving updated array of skill name strings
 */
const SkillsSelector = ({ selectedSkills = [], onSkillsChange }) => {
  const { t } = useTranslation();
  const [searchTerm, setSearchTerm] = useState('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [availableSkills, setAvailableSkills] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const dropdownRef = useRef(null);
  const searchInputRef = useRef(null);

  // Fetch skills from API
  useEffect(() => {
    const loadSkills = async () => {
      try {
        setIsLoading(true);
        const skills = await fetchSkills();
        setAvailableSkills(skills || []);
      } catch (error) {
        console.error('Failed to fetch skills:', error);
        setAvailableSkills([]);
      } finally {
        setIsLoading(false);
      }
    };

    loadSkills();
  }, []);

  // Filter skills based on search term and exclude already selected
  const filteredSkills = availableSkills.filter(skill => {
    const skillName = skill.name || '';
    const skillDescription = skill.description || '';
    const searchableText = `${skillName} ${skillDescription}`.toLowerCase();
    const matchesSearch = searchableText.includes(searchTerm.toLowerCase());
    const notSelected = !selectedSkills.includes(skill.name);
    return matchesSearch && notSelected;
  });

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = event => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsDropdownOpen(false);
        setSearchTerm('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isDropdownOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isDropdownOpen]);

  /**
   * Add a skill to the selection by its name.
   * @param {Object|string} skill - Skill object or skill name string
   */
  const handleAddSkill = skill => {
    const skillName = typeof skill === 'string' ? skill : skill.name;
    if (!selectedSkills.includes(skillName)) {
      onSkillsChange([...selectedSkills, skillName]);
    }
    setSearchTerm('');
    setIsDropdownOpen(false);
  };

  /**
   * Remove a skill from the selection.
   * @param {string} skillToRemove - The skill name to remove
   */
  const handleRemoveSkill = skillToRemove => {
    onSkillsChange(selectedSkills.filter(skill => skill !== skillToRemove));
  };

  const handleSearchChange = e => {
    setSearchTerm(e.target.value);
    setIsDropdownOpen(true);
  };

  const handleSearchKeyDown = e => {
    if (e.key === 'Enter' && filteredSkills.length > 0) {
      handleAddSkill(filteredSkills[0]);
    } else if (e.key === 'Escape') {
      setIsDropdownOpen(false);
      setSearchTerm('');
    }
  };

  return (
    <div className="space-y-3">
      {/* Selected Skills */}
      {selectedSkills.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedSkills.map(skillName => {
            const skillInfo = availableSkills.find(s => s.name === skillName);
            const displayName = skillInfo ? skillInfo.name : skillName;
            return (
              <span
                key={skillName}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-medium bg-indigo-100 text-indigo-800"
              >
                {displayName}
                <button
                  onClick={() => handleRemoveSkill(skillName)}
                  className="ml-1 flex-shrink-0 text-indigo-600 hover:text-indigo-800"
                  aria-label={`Remove ${displayName}`}
                >
                  <Icon name="x" className="w-3 h-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Search and Add Skills */}
      <div className="relative" ref={dropdownRef}>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Icon name="search" className="h-5 w-5 text-gray-400" />
          </div>
          <input
            ref={searchInputRef}
            type="text"
            placeholder={t('admin.apps.edit.searchSkills', 'Search skills to add...')}
            value={searchTerm}
            onChange={handleSearchChange}
            onKeyDown={handleSearchKeyDown}
            onFocus={() => setIsDropdownOpen(true)}
            className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            autoComplete="off"
          />
        </div>

        {/* Dropdown */}
        {isDropdownOpen && (
          <div className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
            {isLoading ? (
              <div className="px-3 py-2 text-sm text-gray-500">
                {t('common.loading', 'Loading...')}
              </div>
            ) : filteredSkills.length > 0 ? (
              filteredSkills.map(skill => (
                <button
                  key={skill.name}
                  onClick={() => handleAddSkill(skill)}
                  className="w-full text-left px-3 py-3 text-sm text-gray-700 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none border-b border-gray-100 last:border-b-0"
                >
                  <div className="font-medium text-gray-900">{skill.name}</div>
                  {skill.description && (
                    <div className="text-xs text-gray-500 mt-1 line-clamp-2">
                      {skill.description}
                    </div>
                  )}
                </button>
              ))
            ) : (
              <div className="px-3 py-2 text-sm text-gray-500">
                {searchTerm
                  ? t('admin.apps.edit.skills.noResults', 'No skills match your search')
                  : t('admin.apps.edit.skills.noSkills', 'No skills available')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Helper text */}
      <p className="text-sm text-gray-500">
        {t(
          'admin.apps.edit.skillsHelper',
          'Search and select skills to add to this app. Click on selected skills to remove them.'
        )}
      </p>
    </div>
  );
};

export default SkillsSelector;
