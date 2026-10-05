import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../shared/components/Modal';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { addMarketplaceSkill, fetchMarketplaceSkill, fetchMarketplaceSkills } from '../../../api';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { skillErrorMessage } from '../utils/skillErrors';
import {
  SKILL_NAME_MAX_LENGTH,
  skillValidationMessage,
  validateSkillName
} from '../utils/skillValidation';

const PAGE_SIZE = 12;
const SEARCH_DELAY_MS = 250;

const inputClass =
  'block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 text-sm px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
const secondaryButton =
  'px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 inline-flex items-center gap-1';
const primaryButton =
  'px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 inline-flex items-center gap-1';

/** The words of a catalog category, e.g. `productivity` → `Productivity`. */
const categoryLabel = category =>
  String(category || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());

/** A marker next to a skill: added already, or available as a global skill. */
function StatusBadges({ skill }) {
  const { t } = useTranslation();
  return (
    <>
      {skill.added && (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/40 rounded-full">
          <Icon name="check" size="sm" className="w-3 h-3" />
          {t('skills.marketplace.added', 'In your skills')}
        </span>
      )}
      {!skill.added && skill.availableAsGlobal && (
        <span
          className="px-1.5 py-0.5 text-xs text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-900/40 rounded-full"
          title={t(
            'skills.marketplace.availableHint',
            'A skill of this name is already in your library. Add it only if you want your own copy.'
          )}
        >
          {t('skills.marketplace.available', 'Already available')}
        </span>
      )}
    </>
  );
}

/** One skill in the result list. */
function MarketplaceSkillRow({ skill, language, onOpen, onAdd, adding }) {
  const { t } = useTranslation();
  const title = getLocalizedContent(skill.displayName, language) || skill.name;
  const description = getLocalizedContent(skill.description, language) || '';
  return (
    <li className="p-3 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 flex flex-col">
      <button
        type="button"
        onClick={() => onOpen(skill)}
        className="text-left grow focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-sm"
        aria-label={t('skills.marketplace.showNamed', {
          defaultValue: 'Show details of {{name}}',
          name: title
        })}
      >
        <div className="flex items-start gap-2">
          <div className="shrink-0 w-8 h-8 bg-purple-100 dark:bg-purple-900/50 rounded-lg flex items-center justify-center">
            <Icon name="sparkles" className="w-4 h-4 text-purple-600 dark:text-purple-400" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-sm text-gray-900 dark:text-gray-100 truncate">
              {title}
            </div>
            <div className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate">
              /{skill.name}
            </div>
          </div>
        </div>
        <p
          className="mt-2 text-xs text-gray-600 dark:text-gray-300 leading-4"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden'
          }}
        >
          {description}
        </p>
      </button>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {skill.category && (
          <span className="px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-full">
            {categoryLabel(skill.category)}
          </span>
        )}
        <StatusBadges skill={skill} />
        <span className="grow" />
        {!skill.added && (
          <button
            type="button"
            onClick={() => onAdd(skill)}
            disabled={adding}
            className="px-2.5 py-1 text-xs bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 inline-flex items-center gap-1"
            aria-label={t('skills.marketplace.addNamed', {
              defaultValue: 'Add {{name}} to my skills',
              name: title
            })}
          >
            <Icon name="plus" size="sm" />
            {t('skills.marketplace.add', 'Add')}
          </button>
        )}
      </div>
    </li>
  );
}

/** The details of one skill, with a preview and "Add to my skills". */
function MarketplaceSkillDetail({ entry, language, onBack, onAdded }) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [name, setName] = useState(entry.name);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);
  const nameError = skillValidationMessage(validateSkillName(name), t);

  useEffect(() => {
    let active = true;
    fetchMarketplaceSkill(entry.registryId, entry.name)
      .then(result => active && setDetail(result))
      .catch(err => active && setLoadError(skillErrorMessage(err, t)));
    return () => {
      active = false;
    };
  }, [entry.registryId, entry.name, t]);

  const skill = detail || entry;
  const title = getLocalizedContent(skill.displayName, language) || skill.name;
  const description = getLocalizedContent(skill.description, language) || '';
  const files = detail?.preview?.files || [];
  const leftOut = files.filter(file => !file.included);

  const add = async event => {
    event.preventDefault();
    if (nameError) return;
    setAdding(true);
    setError(null);
    try {
      const created = await addMarketplaceSkill(entry.registryId, entry.name, { name });
      onAdded(created);
    } catch (err) {
      setError(skillErrorMessage(err, t));
      setAdding(false);
    }
  };

  const meta = [
    [t('skills.marketplace.registry', 'Source'), skill.registryName],
    [t('skills.marketplace.category', 'Category'), skill.category && categoryLabel(skill.category)],
    [t('skills.marketplace.author', 'Author'), skill.author],
    [t('skills.marketplace.version', 'Version'), skill.version]
  ].filter(([, value]) => value);

  return (
    <form onSubmit={add} noValidate className="flex flex-col min-h-0">
      <div className="px-5 pt-3">
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"
        >
          <Icon name="chevron-left" size="sm" />
          {t('skills.marketplace.back', 'All skills')}
        </button>
      </div>
      <div className="px-5 py-3 overflow-y-auto min-h-0 grow">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-xs font-mono text-gray-500 dark:text-gray-400">/{skill.name}</span>
          <StatusBadges skill={skill} />
        </div>
        {description && (
          <p className="mt-3 text-sm text-gray-700 dark:text-gray-300 whitespace-pre-line">
            {description}
          </p>
        )}
        {meta.length > 0 && (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {meta.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
                <dd className="text-gray-800 dark:text-gray-200">{value}</dd>
              </div>
            ))}
            {skill.license && (
              <div className="contents">
                <dt className="text-gray-500 dark:text-gray-400">
                  {t('skills.marketplace.license', 'License')}
                </dt>
                <dd className="text-gray-800 dark:text-gray-200">
                  {skill.licenseUrl ? (
                    <a
                      href={skill.licenseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      {skill.license}
                    </a>
                  ) : (
                    skill.license
                  )}
                </dd>
              </div>
            )}
          </dl>
        )}

        <div className="mt-4 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
          {t('skills.details.instructions', 'Instructions')}
        </div>
        {loadError ? (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {loadError}
          </p>
        ) : !detail ? (
          <div className="py-4">
            <LoadingSpinner />
          </div>
        ) : detail.preview?.body ? (
          <pre className="bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 p-3 rounded-sm whitespace-pre-wrap wrap-break-word text-sm max-h-72 overflow-y-auto">
            {detail.preview.body}
          </pre>
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('skills.marketplace.noPreview', 'No preview available.')}
          </p>
        )}

        {files.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
              {t('skills.details.files', 'Files')}
            </div>
            <ul className="border border-gray-200 dark:border-gray-700 rounded-md divide-y divide-gray-100 dark:divide-gray-700">
              {files.map(file => (
                <li
                  key={file.path}
                  className="px-3 py-2 flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200"
                >
                  <Icon name="document-text" size="sm" className="text-gray-500 shrink-0" />
                  <span
                    className={`font-mono truncate ${file.included ? '' : 'line-through opacity-60'}`}
                  >
                    {file.path}
                  </span>
                </li>
              ))}
            </ul>
            {leftOut.length > 0 && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  'skills.marketplace.filesLeftOut',
                  'Crossed-out files are not added: your skills hold text files directly in references/, assets/ or scripts/.'
                )}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700 space-y-2">
        <label
          htmlFor="marketplace-skill-name"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          {t('skills.marketplace.nameLabel', 'Name in your skills')}
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative grow">
            <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-400 font-mono text-sm pointer-events-none">
              /
            </span>
            <input
              id="marketplace-skill-name"
              className={`${inputClass} pl-6 font-mono`}
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={SKILL_NAME_MAX_LENGTH}
              aria-invalid={Boolean(nameError)}
              aria-describedby="marketplace-skill-name-hint"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button type="submit" disabled={adding || Boolean(nameError)} className={primaryButton}>
            <Icon name="plus" size="sm" />
            {adding
              ? t('skills.marketplace.adding', 'Adding…')
              : t('skills.marketplace.addToMine', 'Add to my skills')}
          </button>
        </div>
        <p
          id="marketplace-skill-name-hint"
          className={`text-xs ${nameError ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
        >
          {nameError ||
            t('skills.marketplace.nameHint', {
              defaultValue:
                'Type /{{name}} in a chat to use it. The copy is private until you share it, and you can change it like any of your skills.',
              name: name || skill.name
            })}
        </p>
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

/**
 * Browse the skills the marketplace offers and add one to one's own skills —
 * the easy way to start with skills, without writing one, and without an
 * admin installing it for everyone. Search, category and source narrow the
 * list; a skill opens with a preview of its instructions and the files that
 * come with it. A skill added here is an ordinary personal skill: private
 * until shared, and editable like any other.
 *
 * Shown only when the platform says the marketplace is offered to users
 * (`platformConfig.userSkills.marketplace`); the server enforces it.
 *
 * @param {Object} props
 * @param {() => void} props.onClose
 * @param {(skill: Object) => void} props.onAdded - Called with the new skill
 *   (including `skippedFiles`).
 */
function SkillMarketplaceModal({ onClose, onAdded }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [registry, setRegistry] = useState('');
  const [result, setResult] = useState(null);
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [addingKey, setAddingKey] = useState(null);
  const [addError, setAddError] = useState(null);
  const searchRef = useRef(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (nextPage, { append = false } = {}) => {
      const request = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const data = await fetchMarketplaceSkills({
          search: query || undefined,
          category: category || undefined,
          registry: registry || undefined,
          page: nextPage,
          limit: PAGE_SIZE
        });
        if (request !== requestRef.current) return;
        setResult(data);
        setPage(data.page || nextPage);
        setItems(prev => (append ? [...prev, ...(data.items || [])] : data.items || []));
      } catch (err) {
        if (request !== requestRef.current) return;
        setError(skillErrorMessage(err, t));
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [query, category, registry, t]
  );

  useEffect(() => {
    load(1);
  }, [load]);

  const quickAdd = async skill => {
    const key = `${skill.registryId}:${skill.name}`;
    setAddingKey(key);
    setAddError(null);
    try {
      const created = await addMarketplaceSkill(skill.registryId, skill.name);
      onAdded(created);
    } catch (err) {
      setAddError(skillErrorMessage(err, t));
      setAddingKey(null);
    }
  };

  const registries = result?.registries || [];
  const categories = result?.categories || [];
  const filtered = Boolean(query || category || registry);
  const hasMore = result && page < (result.totalPages || 1);

  return (
    <Modal
      isOpen
      onClose={onClose}
      maxWidthClassName="max-w-4xl"
      initialFocusRef={selected ? undefined : searchRef}
    >
      <div className="flex items-start justify-between gap-3 p-5 border-b border-gray-200 dark:border-gray-700">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('skills.marketplace.title', 'Skills from the marketplace')}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            {t(
              'skills.marketplace.subtitle',
              'Pick a ready-made skill and add it to your skills. It stays private until you share it, and you can adapt it to how you work.'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
          className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <Icon name="x" />
        </button>
      </div>

      {selected ? (
        <MarketplaceSkillDetail
          key={`${selected.registryId}:${selected.name}`}
          entry={selected}
          language={language}
          onBack={() => setSelected(null)}
          onAdded={onAdded}
        />
      ) : (
        <>
          <div className="px-5 pt-4 flex flex-col sm:flex-row gap-2">
            <div className="relative grow">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Icon name="search" className="h-4 w-4 text-gray-400" />
              </div>
              <input
                ref={searchRef}
                type="search"
                className={`${inputClass} pl-9`}
                placeholder={t('skills.marketplace.searchPlaceholder', 'Search skills…')}
                aria-label={t('skills.marketplace.searchLabel', 'Search the marketplace')}
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoComplete="off"
              />
            </div>
            {categories.length > 0 && (
              <select
                className={`${inputClass} sm:w-48`}
                value={category}
                onChange={e => setCategory(e.target.value)}
                aria-label={t('skills.marketplace.category', 'Category')}
              >
                <option value="">{t('skills.marketplace.allCategories', 'All categories')}</option>
                {categories.map(entry => (
                  <option key={entry} value={entry}>
                    {categoryLabel(entry)}
                  </option>
                ))}
              </select>
            )}
            {registries.length > 1 && (
              <select
                className={`${inputClass} sm:w-48`}
                value={registry}
                onChange={e => setRegistry(e.target.value)}
                aria-label={t('skills.marketplace.registry', 'Source')}
              >
                <option value="">{t('skills.marketplace.allRegistries', 'All sources')}</option>
                {registries.map(entry => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="px-5 py-4 overflow-y-auto min-h-0 grow">
            {addError && (
              <p className="mb-3 text-sm text-red-600 dark:text-red-400" role="alert">
                {addError}
              </p>
            )}
            {error ? (
              <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            ) : items.length === 0 && loading ? (
              <div className="py-8">
                <LoadingSpinner />
              </div>
            ) : items.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                {filtered
                  ? t('skills.marketplace.noMatches', 'No skills match your search.')
                  : t(
                      'skills.marketplace.empty',
                      'The marketplace has no skills to offer yet. Ask your administrator to refresh it.'
                    )}
              </p>
            ) : (
              <>
                <p className="mb-2 text-xs text-gray-500 dark:text-gray-400" aria-live="polite">
                  {t('skills.marketplace.count', {
                    defaultValue: '{{count}} skill(s)',
                    count: result?.total ?? items.length
                  })}
                </p>
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map(skill => {
                    const key = `${skill.registryId}:${skill.name}`;
                    return (
                      <MarketplaceSkillRow
                        key={key}
                        skill={skill}
                        language={language}
                        onOpen={setSelected}
                        onAdd={quickAdd}
                        adding={addingKey === key}
                      />
                    );
                  })}
                </ul>
                {hasMore && (
                  <div className="mt-4 flex justify-center">
                    <button
                      type="button"
                      onClick={() => load(page + 1, { append: true })}
                      disabled={loading}
                      className={secondaryButton}
                    >
                      {loading
                        ? t('skills.marketplace.loading', 'Loading…')
                        : t('skills.marketplace.more', 'Show more')}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

export default SkillMarketplaceModal;
