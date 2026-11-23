// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * App IDs of the app builder (`shared/appId.js`): derived from a name,
 * checked, and made free. The create page asks the author for no ID, so every
 * name has to end in one the server accepts.
 */
import {
  RESERVED_APP_IDS,
  appIdProblem,
  isValidAppId,
  slugifyAppId,
  uniqueAppId
} from '../../../shared/appId.js';
import { APP_ID_MAX_LENGTH, APP_ID_PATTERN } from '../../../shared/validationPatterns.js';
import { appConfigSchema } from '../../../server/validators/appConfigSchema.js';
import { isValidId } from '../../../server/utils/pathSecurity.js';

const SIXTY_CHARACTERS = 'Zusammenfassung langer Vertragsdokumente für die Rechtsabteilung';

describe('slugifyAppId', () => {
  test.each([
    ['Übersetzer für Verträge', 'uebersetzer-fuer-vertraege'],
    ['Zusammenfassung für Ärzte', 'zusammenfassung-fuer-aerzte'],
    ['Große Straße', 'grosse-strasse'],
    ['Plain-language summary', 'plain-language-summary'],
    ['Résumé  &  Café', 'resume-cafe'],
    ['Dr. Watson', 'dr-watson'],
    ['Release notes v2.1', 'release-notes-v2.1'],
    ['my_app', 'my_app'],
    ['  --Hello, World!--  ', 'hello-world'],
    ['E-Mail (Entwurf)', 'e-mail-entwurf'],
    ['FAQ 2026', 'faq-2026']
  ])('%p → %p', (name, expected) => {
    expect(slugifyAppId(name)).toBe(expected);
  });

  test('a decomposed umlaut (a + combining diaeresis) is spelled out like the composed one', () => {
    expect(slugifyAppId('Märkte')).toBe('maerkte');
  });

  test.each([['要約'], ['Резюме'], ['ملخص'], ['!!!'], [''], [undefined], [null]])(
    'a name without Latin letters or digits (%p) gives an empty slug',
    name => {
      expect(slugifyAppId(name)).toBe('');
    }
  );

  test('a 60-character name is cut so that a suffix still fits', () => {
    expect(SIXTY_CHARACTERS.length).toBeGreaterThanOrEqual(60);

    const slug = slugifyAppId(SIXTY_CHARACTERS);

    expect(slug.length).toBeLessThan(APP_ID_MAX_LENGTH - 2);
    expect(slug).toMatch(APP_ID_PATTERN);
    expect(slug).toMatch(/[a-z0-9]$/);
  });

  test('the cut never leaves a separator at the end', () => {
    // 45 letters, then a space exactly where the cut falls.
    const slug = slugifyAppId(`${'a'.repeat(45)} ${'b'.repeat(20)}`);

    expect(slug).toBe('a'.repeat(45));
  });

  test('slugifying a slug changes nothing', () => {
    for (const name of ['Übersetzer für Verträge', SIXTY_CHARACTERS, 'Release notes v2.1']) {
      const slug = slugifyAppId(name);
      expect(slugifyAppId(slug)).toBe(slug);
    }
  });

  test.each([
    'Übersetzer für Verträge',
    SIXTY_CHARACTERS,
    'a'.repeat(200),
    '.hidden_file.',
    '__init__',
    'Ünïcödé — ¿qué?',
    '100 % sicher',
    'x'
  ])('the slug of %p matches the ID pattern and the length limit', name => {
    const slug = slugifyAppId(name);

    expect(slug).toMatch(APP_ID_PATTERN);
    expect(slug.length).toBeLessThanOrEqual(APP_ID_MAX_LENGTH);
    expect(slug.startsWith('_')).toBe(false);
  });
});

describe('isValidAppId', () => {
  test.each(['chat', 'my-app', 'my_app.v2', 'a', 'a'.repeat(APP_ID_MAX_LENGTH)])(
    '%p is valid',
    id => {
      expect(isValidAppId(id)).toBe(true);
      expect(appIdProblem(id)).toBeNull();
    }
  );

  test.each([
    ['', 'required'],
    [undefined, 'required'],
    [null, 'required'],
    [42, 'required'],
    ['a'.repeat(APP_ID_MAX_LENGTH + 1), 'tooLong'],
    ['My App', 'format'],
    ['übersetzer', 'format'],
    ['Chat', 'format'],
    ['a/b', 'format'],
    ['../../x', 'format'],
    ['a..b', 'format'],
    ['..', 'format'],
    ['.', 'format'],
    ['constructor', 'reserved'],
    ['prototype', 'reserved'],
    ['__proto__', 'reserved'],
    ['_generate', 'reserved'],
    ['_x', 'reserved']
  ])('%p is refused as %p', (id, problem) => {
    expect(isValidAppId(id)).toBe(false);
    expect(appIdProblem(id)).toBe(problem);
  });

  test.each(RESERVED_APP_IDS)('the reserved ID %p is refused', id => {
    // The pattern itself accepts it; only this check keeps it away from the routes.
    expect(id).toMatch(APP_ID_PATTERN);
    expect(isValidAppId(id)).toBe(false);
    expect(appIdProblem(id)).toBe('reserved');
  });

  test('an ID this check accepts is one the create route accepts', () => {
    // `POST /api/admin/apps` runs `assertValidId`; an ID the page calls valid must pass it.
    const samples = [
      'chat',
      'my-app',
      'my_app.v2',
      'a.b',
      'a..b',
      'a...b',
      '.',
      '..',
      '.a',
      'a.',
      '-',
      'constructor',
      'prototype',
      '__proto__',
      'constructor-2',
      'new',
      '_x',
      'a/b',
      'a'.repeat(APP_ID_MAX_LENGTH),
      'a'.repeat(APP_ID_MAX_LENGTH + 1)
    ];
    for (const id of samples) {
      if (isValidAppId(id)) expect([id, isValidId(id)]).toEqual([id, true]);
    }
    for (const name of ['Constructor', 'Prototype', '__proto__', 'a..b', '.', '..']) {
      const id = uniqueAppId(slugifyAppId(name), () => false);
      expect([name, isValidAppId(id), isValidId(id)]).toEqual([name, true, true]);
    }
  });

  test('the routes that shadow an app ID are on the list', () => {
    expect(RESERVED_APP_IDS).toEqual(
      expect.arrayContaining(['new', 'templates', 'integration-status'])
    );
  });
});

describe('uniqueAppId', () => {
  const takenFrom = ids => id => ids.includes(id);

  test('a free base is returned as it is', () => {
    expect(uniqueAppId('summary', () => false)).toBe('summary');
  });

  test('a taken base gets the next free number', () => {
    expect(uniqueAppId('summary', takenFrom(['summary']))).toBe('summary-2');
    expect(uniqueAppId('summary', takenFrom(['summary', 'summary-2', 'summary-3']))).toBe(
      'summary-4'
    );
  });

  test('an empty base starts from "app"', () => {
    expect(uniqueAppId('', () => false)).toBe('app');
    expect(uniqueAppId(slugifyAppId('要約'), takenFrom(['app']))).toBe('app-2');
    expect(uniqueAppId(undefined)).toBe('app');
  });

  test.each(RESERVED_APP_IDS)('the reserved ID %p gets a suffix although nothing is taken', id => {
    const result = uniqueAppId(slugifyAppId(id), () => false);

    expect(result).toBe(`${id}-2`);
    expect(isValidAppId(result)).toBe(true);
  });

  test.each(['constructor', 'prototype'])(
    '%p, which the server refuses for every ID, gets a suffix',
    id => {
      expect(uniqueAppId(id, () => false)).toBe(`${id}-2`);
      expect(uniqueAppId(slugifyAppId(id.toUpperCase()), id2 => id2 === `${id}-2`)).toBe(`${id}-3`);
    }
  );

  test('a base of dots only starts from "app"', () => {
    expect(uniqueAppId('.', () => false)).toBe('app');
    expect(uniqueAppId('a..b', () => false)).toBe('a-b');
  });

  test('a name that slugs to a reserved ID still ends in a usable one', () => {
    expect(uniqueAppId(slugifyAppId('New'), () => false)).toBe('new-2');
    expect(uniqueAppId(slugifyAppId('Templates!'), () => false)).toBe('templates-2');
  });

  test('a 60-character name plus a suffix stays within 50 characters', () => {
    const base = slugifyAppId(SIXTY_CHARACTERS);
    const taken = [base];
    for (let n = 2; n <= 120; n += 1) taken.push(`${base}-${n}`);

    const first = uniqueAppId(base, takenFrom([base]));
    const later = uniqueAppId(base, takenFrom(taken));

    expect(first).toBe(`${base}-2`);
    expect(later).toBe(`${base}-121`);
    for (const id of [first, later]) {
      expect(id.length).toBeLessThanOrEqual(APP_ID_MAX_LENGTH);
      expect(id).toMatch(APP_ID_PATTERN);
    }
  });

  test('a base of the full length is shortened for the suffix', () => {
    const base = 'a'.repeat(APP_ID_MAX_LENGTH);

    const result = uniqueAppId(base, takenFrom([base]));

    expect(result.length).toBeLessThanOrEqual(APP_ID_MAX_LENGTH);
    expect(result).toMatch(/^a+-2$/);
  });

  test('a base that is no valid ID is slugified first', () => {
    expect(uniqueAppId('Mein Übersetzer', () => false)).toBe('mein-uebersetzer');
    expect(uniqueAppId('_private', () => false)).toBe('private');
    expect(uniqueAppId('Mein Übersetzer', takenFrom(['mein-uebersetzer']))).toBe(
      'mein-uebersetzer-2'
    );
  });

  test('a taken ID keeps its spelling in front of the number', () => {
    expect(uniqueAppId('my_app.v2', takenFrom(['my_app.v2']))).toBe('my_app.v2-2');
    expect(uniqueAppId('notes-', takenFrom(['notes-']))).toBe('notes-2');
  });

  test('a base of separators only starts from "app"', () => {
    expect(uniqueAppId('---', takenFrom(['---']))).toBe('app');
    expect(uniqueAppId('...', takenFrom(['...', 'app']))).toBe('app-2');
  });

  test('never asks for an ID it would not return', () => {
    const asked = [];
    const result = uniqueAppId('New', id => {
      asked.push(id);
      return id === 'new-2';
    });

    expect(result).toBe('new-3');
    for (const id of asked) expect(isValidAppId(id)).toBe(true);
  });

  test('the IDs in use can be given as a list, compared without case', () => {
    expect(uniqueAppId('chat', ['Chat', 'chat-2'])).toBe('chat-3');
    expect(uniqueAppId('chat', new Set(['other']))).toBe('chat');
  });

  test('every result is an ID the app schema accepts', () => {
    const idSchema = appConfigSchema.shape.id;
    const names = ['Übersetzer für Verträge', '要約', SIXTY_CHARACTERS, 'New', '_x', 'a.b_c-d', ''];

    for (const name of names) {
      const taken = [];
      for (let round = 0; round < 12; round += 1) {
        const id = uniqueAppId(slugifyAppId(name), takenFrom(taken));
        expect(idSchema.safeParse(id).success).toBe(true);
        expect(isValidAppId(id)).toBe(true);
        expect(taken).not.toContain(id);
        taken.push(id);
      }
    }
  });
});
