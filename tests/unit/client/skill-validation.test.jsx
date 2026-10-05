/**
 * The skill editor checks a personal skill while it is typed
 * (client/src/features/skills/utils/skillValidation.js). The rules are the
 * user skills contract's: a slug name of at most 64 characters without `--`,
 * a description of 1..1024 characters, text files under references/, assets/
 * or scripts/ with a safe name and a text extension, and a size limit over
 * body plus files.
 */
import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  joinSkillFilePath,
  skillContentSize,
  skillValidationMessage,
  splitSkillFilePath,
  validateSkillBody,
  validateSkillDescription,
  validateSkillDraft,
  validateSkillFile,
  validateSkillName
} from '../../../client/src/features/skills/utils/skillValidation';

describe('validateSkillName', () => {
  test.each(['a', 'weekly-report', 'pdf2text', 'a1-b2-c3', 'x'.repeat(64)])(
    '%s is a valid name',
    name => {
      expect(validateSkillName(name)).toBeNull();
    }
  );

  test.each([
    ['', 'required'],
    [undefined, 'required'],
    ['x'.repeat(65), 'tooLong'],
    ['weekly--report', 'doubleHyphen'],
    ['Weekly-Report', 'pattern'],
    ['weekly report', 'pattern'],
    ['-weekly', 'pattern'],
    ['weekly-', 'pattern'],
    ['weekly_report', 'pattern'],
    ['wöchentlich', 'pattern'],
    ['../etc', 'pattern']
  ])('%p is rejected as %s', (name, code) => {
    expect(validateSkillName(name)).toBe(code);
  });
});

describe('validateSkillDescription', () => {
  test('needs text, up to 1024 characters', () => {
    expect(validateSkillDescription('Drafts reports. Use when asked.')).toBeNull();
    expect(validateSkillDescription('x'.repeat(SKILL_DESCRIPTION_MAX_LENGTH))).toBeNull();
    expect(validateSkillDescription('x'.repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1))).toBe('tooLong');
    expect(validateSkillDescription('')).toBe('required');
    expect(validateSkillDescription('   ')).toBe('required');
    expect(validateSkillDescription(null)).toBe('required');
  });
});

describe('validateSkillBody', () => {
  test('needs instructions', () => {
    expect(validateSkillBody('# Do this')).toBeNull();
    expect(validateSkillBody(' \n ')).toBe('required');
    expect(validateSkillBody(undefined)).toBe('required');
  });
});

describe('skill files', () => {
  test('a path splits into folder and file name and joins back', () => {
    expect(splitSkillFilePath('references/template.md')).toEqual({
      folder: 'references',
      fileName: 'template.md'
    });
    expect(splitSkillFilePath('other/x.md')).toEqual({ folder: '', fileName: 'x.md' });
    expect(splitSkillFilePath('x.md')).toEqual({ folder: '', fileName: 'x.md' });
    expect(joinSkillFilePath('assets', ' data.csv ')).toBe('assets/data.csv');
  });

  test.each([
    ['references', 'template.md'],
    ['assets', 'data.csv'],
    ['scripts', 'run_me-2.yaml'],
    ['references', 'notes.txt'],
    ['assets', 'config.json'],
    ['assets', 'config.yml']
  ])('%s/%s is a valid file', (folder, fileName) => {
    expect(validateSkillFile(folder, fileName)).toBeNull();
  });

  test.each([
    ['', 'a.md', 'folder'],
    ['docs', 'a.md', 'folder'],
    ['references', '', 'nameRequired'],
    ['references', 'my file.md', 'namePattern'],
    ['references', 'sub/dir.md', 'namePattern'],
    ['references', 'run.sh', 'extension'],
    ['references', 'template', 'extension'],
    ['references', '.md', 'namePattern'],
    ['references', '_notes.md', 'namePattern'],
    ['assets', 'data.CSV', 'extension'],
    ['references', `${'a'.repeat(190)}.md`, 'tooLong']
  ])('%s/%s is rejected as %s', (folder, fileName, code) => {
    expect(validateSkillFile(folder, fileName)).toBe(code);
  });
});

describe('skillContentSize', () => {
  test('counts UTF-8 bytes of the body and every file', () => {
    expect(skillContentSize('abc')).toBe(3);
    expect(skillContentSize('ä', [{ content: 'é' }, { content: 'xy' }])).toBe(6);
    expect(skillContentSize(undefined, [{}])).toBe(0);
  });
});

describe('validateSkillDraft', () => {
  const valid = {
    name: 'weekly-report',
    description: 'Drafts the weekly report. Use when asked for one.',
    body: '# Weekly report',
    files: [{ folder: 'references', fileName: 'template.md', content: 'Hi' }]
  };

  test('a complete draft is valid', () => {
    const result = validateSkillDraft(valid, { maxSkillSizeKB: 1, maxFilesPerSkill: 2 });
    expect(result.valid).toBe(true);
    expect(result.files).toEqual([null]);
    expect(result.maxBytes).toBe(1024);
  });

  test('reports each problem', () => {
    const result = validateSkillDraft(
      {
        name: 'Bad Name',
        description: '',
        body: '',
        files: [
          { folder: 'references', fileName: 'a.md', content: '' },
          { folder: 'references', fileName: 'A.md', content: '' },
          { folder: 'scripts', fileName: 'run.sh', content: '' }
        ]
      },
      { maxFilesPerSkill: 2 }
    );
    expect(result).toMatchObject({
      name: 'pattern',
      description: 'required',
      body: 'required',
      files: [null, 'duplicate', 'extension'],
      tooManyFiles: true,
      valid: false
    });
  });

  test('a skill over maxSkillSizeKB is too large', () => {
    const result = validateSkillDraft(
      { ...valid, body: 'x'.repeat(1024), files: [] },
      { maxSkillSizeKB: 1 }
    );
    expect(result.tooLarge).toBe(false);
    const over = validateSkillDraft(
      { ...valid, files: [{ folder: 'assets', fileName: 'big.txt', content: 'x'.repeat(1024) }] },
      { maxSkillSizeKB: 1 }
    );
    expect(over.tooLarge).toBe(true);
    expect(over.valid).toBe(false);
  });

  test('without limits the defaults apply (256 KB, 20 files)', () => {
    const result = validateSkillDraft(valid);
    expect(result.maxBytes).toBe(256 * 1024);
    expect(
      validateSkillDraft({
        ...valid,
        files: Array.from({ length: 21 }, (_, i) => ({
          folder: 'references',
          fileName: `f${i}.md`,
          content: ''
        }))
      }).tooManyFiles
    ).toBe(true);
  });
});

describe('skillValidationMessage', () => {
  const t = (key, options) =>
    typeof options === 'string'
      ? `${key}|${options}`
      : `${key}|${options.defaultValue.replace('{{extensions}}', options.extensions)}`;

  test('no code, no message', () => {
    expect(skillValidationMessage(null, t)).toBeNull();
  });

  test('every code has a translated message', () => {
    for (const code of [
      'required',
      'tooLong',
      'doubleHyphen',
      'pattern',
      'folder',
      'nameRequired',
      'namePattern',
      'duplicate'
    ]) {
      expect(skillValidationMessage(code, t)).toMatch(/^skills\.validation\./);
    }
    expect(skillValidationMessage('extension', t)).toBe(
      'skills.validation.extension|Allowed file types: .md .txt .csv .json .yaml .yml'
    );
    expect(skillValidationMessage('something-else', t)).toBe(
      'skills.validation.invalid|Invalid value'
    );
  });
});
