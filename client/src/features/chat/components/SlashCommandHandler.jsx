import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import SearchModal from '../../../shared/components/SearchModal';

/**
 * Built-in slash commands that don't require external prompt fetching
 */
const BUILT_IN_COMMANDS = [
  {
    id: 'summarize',
    name: 'Summarize',
    command: '/summarize',
    description: 'Generate a comprehensive conversation summary for AI context handoff',
    icon: 'document-text',
    action: 'summarize',
    prompt: `Please provide a comprehensive report on everything we've spoken about in this conversation. It should outline all elements to such a degree that by giving this report to a new AI instance it will have all the necessary context to pick up and continue from where we are right now. Do not worry about token output length.`
  }
];

const SlashCommandHandler = ({ isOpen, onClose, onSelect, query = '' }) => {
  const { t } = useTranslation();
  const [filteredCommands, setFilteredCommands] = useState(BUILT_IN_COMMANDS);

  useEffect(() => {
    if (query) {
      const filtered = BUILT_IN_COMMANDS.filter(
        cmd =>
          cmd.command.toLowerCase().includes(query.toLowerCase()) ||
          cmd.name.toLowerCase().includes(query.toLowerCase()) ||
          cmd.description.toLowerCase().includes(query.toLowerCase())
      );
      setFilteredCommands(filtered);
    } else {
      setFilteredCommands(BUILT_IN_COMMANDS);
    }
  }, [query]);

  const handleSelect = command => {
    onSelect(command);
  };

  if (!isOpen) return null;

  return (
    <SearchModal
      isOpen={isOpen}
      onClose={onClose}
      onSelect={handleSelect}
      items={filteredCommands}
      fuseKeys={['command', 'name', 'description']}
      placeholder={t('common.slashCommands.placeholder', 'Search commands...')}
      query={query}
      renderResult={cmd => (
        <div className="flex items-start space-x-3">
          <div className="flex-shrink-0 w-6 h-6 bg-blue-100 rounded-lg flex items-center justify-center">
            <Icon name={cmd.icon || 'terminal'} className="w-3.5 h-3.5 text-blue-600" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center flex-wrap mb-1">
              <span className="font-mono text-blue-600 text-sm font-medium mr-2">
                {cmd.command}
              </span>
              <span className="font-medium text-gray-900 text-sm">{cmd.name}</span>
            </div>
            <p
              className="text-xs text-gray-500 leading-4 overflow-hidden"
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical'
              }}
            >
              {cmd.description}
            </p>
          </div>
        </div>
      )}
    />
  );
};

export default SlashCommandHandler;
