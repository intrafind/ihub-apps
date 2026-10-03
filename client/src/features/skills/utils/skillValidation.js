/**
 * The rules a personal skill has to satisfy, as the editor checks them while
 * the user types. The server applies the same rules (see the user skills API
 * contract) and stays the authority — these only let the editor say what is
 * wrong before a round trip.
 *
 * Every validator returns `null` when the value is fine, or an error code the
 * UI turns into a translated message (see `skillValidationMessage`).
 */

/** A skill name: lowercase letters, digits and single hyphens, not at either end. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Longest allowed skill name. */
export const SKILL_NAME_MAX_LENGTH = 64;

/** Longest allowed description ("what it does. Use when …"). */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/** The folders a skill file may live in. */
export const SKILL_FILE_FOLDERS = ['references', 'assets', 'scripts'];

/** A file name inside one of those folders. */
export const SKILL_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** The text formats a skill file may have. */
export const SKILL_FILE_EXTENSIONS = ['.md', '.txt', '.csv', '.json', '.yaml', '.yml'];

/** Limits used when the platform config does not name them. */
export const DEFAULT_SKILL_LIMITS = { maxSkillSizeKB: 256, maxFilesPerSkill: 20 };

/**
 * Check a skill name.
 *
 * @param {string} name - The name as typed.
 * @returns {null|'required'|'tooLong'|'doubleHyphen'|'pattern'}
 *
 * @example
 * validateSkillName('weekly-report'); // null
 * validateSkillName('Weekly Report'); // 'pattern'
 */
export function validateSkillName(name) {
  const value = typeof name === 'string' ? name : '';
  if (!value) return 'required';
  if (value.length > SKILL_NAME_MAX_LENGTH) return 'tooLong';
  if (value.includes('--')) return 'doubleHyphen';
  if (!SKILL_NAME_PATTERN.test(value)) return 'pattern';
  return null;
}

/**
 * Check a skill description.
 *
 * @param {string} description - The description as typed.
 * @returns {null|'required'|'tooLong'}
 */
export function validateSkillDescription(description) {
  const value = typeof description === 'string' ? description : '';
  if (!value.trim()) return 'required';
  if (value.length > SKILL_DESCRIPTION_MAX_LENGTH) return 'tooLong';
  return null;
}

/**
 * Check a skill's instructions (the SKILL.md body).
 *
 * @param {string} body - The Markdown body.
 * @returns {null|'required'}
 */
export function validateSkillBody(body) {
  return typeof body === 'string' && body.trim() ? null : 'required';
}

/**
 * Split a stored file path into the folder and the file name the editor
 * shows. A path outside the known folders keeps its folder empty so the user
 * has to pick one.
 *
 * @param {string} path - E.g. `references/template.md`.
 * @returns {{folder: string, fileName: string}}
 */
export function splitSkillFilePath(path) {
  const value = typeof path === 'string' ? path : '';
  const slash = value.indexOf('/');
  if (slash === -1) return { folder: '', fileName: value };
  const folder = value.slice(0, slash);
  return {
    folder: SKILL_FILE_FOLDERS.includes(folder) ? folder : '',
    fileName: value.slice(slash + 1)
  };
}

/**
 * Join a folder and a file name into the stored path.
 *
 * @param {string} folder - One of `SKILL_FILE_FOLDERS`.
 * @param {string} fileName - The file name.
 * @returns {string}
 */
export function joinSkillFilePath(folder, fileName) {
  return `${folder || ''}/${(fileName || '').trim()}`;
}

/**
 * Check one file's folder and name.
 *
 * @param {string} folder - The chosen folder.
 * @param {string} fileName - The file name as typed.
 * @returns {null|'folder'|'nameRequired'|'namePattern'|'extension'}
 */
export function validateSkillFile(folder, fileName) {
  if (!SKILL_FILE_FOLDERS.includes(folder)) return 'folder';
  const value = typeof fileName === 'string' ? fileName.trim() : '';
  if (!value) return 'nameRequired';
  if (!SKILL_FILE_NAME_PATTERN.test(value)) return 'namePattern';
  const lower = value.toLowerCase();
  if (!SKILL_FILE_EXTENSIONS.some(ext => lower.endsWith(ext) && lower.length > ext.length)) {
    return 'extension';
  }
  return null;
}

/**
 * The size of a skill in bytes as UTF-8: its body plus the content of every
 * file. Compared against `maxSkillSizeKB` (1 KB = 1024 bytes).
 *
 * @param {string} body - The Markdown body.
 * @param {Array<{content?: string}>} [files] - The skill's files.
 * @returns {number}
 */
export function skillContentSize(body, files = []) {
  const encoder = new TextEncoder();
  let size = encoder.encode(typeof body === 'string' ? body : '').length;
  for (const file of Array.isArray(files) ? files : []) {
    size += encoder.encode(typeof file?.content === 'string' ? file.content : '').length;
  }
  return size;
}

/**
 * Check a whole draft as the editor holds it.
 *
 * @param {Object} draft
 * @param {string} draft.name
 * @param {string} draft.description
 * @param {string} draft.body
 * @param {Array<{folder: string, fileName: string, content: string}>} [draft.files]
 * @param {Object} [limits]
 * @param {number} [limits.maxSkillSizeKB]
 * @param {number} [limits.maxFilesPerSkill]
 * @returns {{
 *   name: string|null,
 *   description: string|null,
 *   body: string|null,
 *   files: Array<string|null>,
 *   tooManyFiles: boolean,
 *   size: number,
 *   maxBytes: number,
 *   tooLarge: boolean,
 *   valid: boolean
 * }}
 */
export function validateSkillDraft(draft, limits = {}) {
  const files = Array.isArray(draft?.files) ? draft.files : [];
  const maxSkillSizeKB = Number(limits.maxSkillSizeKB) || DEFAULT_SKILL_LIMITS.maxSkillSizeKB;
  const maxFilesPerSkill = Number.isFinite(Number(limits.maxFilesPerSkill))
    ? Number(limits.maxFilesPerSkill)
    : DEFAULT_SKILL_LIMITS.maxFilesPerSkill;

  const seen = new Set();
  const fileErrors = files.map(file => {
    const error = validateSkillFile(file.folder, file.fileName);
    if (error) return error;
    const path = joinSkillFilePath(file.folder, file.fileName).toLowerCase();
    if (seen.has(path)) return 'duplicate';
    seen.add(path);
    return null;
  });

  const size = skillContentSize(draft?.body, files);
  const maxBytes = maxSkillSizeKB * 1024;
  const result = {
    name: validateSkillName(draft?.name),
    description: validateSkillDescription(draft?.description),
    body: validateSkillBody(draft?.body),
    files: fileErrors,
    tooManyFiles: files.length > maxFilesPerSkill,
    size,
    maxBytes,
    tooLarge: size > maxBytes
  };
  result.valid =
    !result.name &&
    !result.description &&
    !result.body &&
    fileErrors.every(error => !error) &&
    !result.tooManyFiles &&
    !result.tooLarge;
  return result;
}

/**
 * The translated message for a validation error code.
 *
 * @param {string|null} code - A code returned by one of the validators.
 * @param {Function} t - i18next `t`.
 * @returns {string|null}
 */
export function skillValidationMessage(code, t) {
  switch (code) {
    case null:
    case undefined:
      return null;
    case 'required':
      return t('skills.validation.required', 'Required');
    case 'tooLong':
      return t('skills.validation.tooLong', 'Too long');
    case 'doubleHyphen':
      return t('skills.validation.doubleHyphen', 'Use single hyphens only (no “--”).');
    case 'pattern':
      return t(
        'skills.validation.namePattern',
        'Use lowercase letters, digits and hyphens; start and end with a letter or digit.'
      );
    case 'folder':
      return t('skills.validation.folder', 'Choose a folder.');
    case 'nameRequired':
      return t('skills.validation.fileNameRequired', 'Enter a file name.');
    case 'namePattern':
      return t(
        'skills.validation.fileNamePattern',
        'Use letters, digits, dots, hyphens and underscores only.'
      );
    case 'extension':
      return t('skills.validation.extension', {
        defaultValue: 'Allowed file types: {{extensions}}',
        extensions: SKILL_FILE_EXTENSIONS.join(' ')
      });
    case 'duplicate':
      return t('skills.validation.duplicate', 'Another file has this name.');
    default:
      return t('skills.validation.invalid', 'Invalid value');
  }
}
