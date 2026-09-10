import { equalsIgnoreCase, findUserByIdentifier } from '../utils/userManager.js';

describe('equalsIgnoreCase', () => {
  test('matches strings that differ only in case', () => {
    expect(equalsIgnoreCase('Daniel.Manzke', 'daniel.manzke')).toBe(true);
    expect(equalsIgnoreCase('ADMIN', 'admin')).toBe(true);
    expect(equalsIgnoreCase('same', 'same')).toBe(true);
  });

  test('rejects genuinely different strings', () => {
    expect(equalsIgnoreCase('daniel.manzke', 'daniel.mueller')).toBe(false);
  });

  test('returns false for non-string or missing values', () => {
    expect(equalsIgnoreCase(undefined, 'admin')).toBe(false);
    expect(equalsIgnoreCase('admin', undefined)).toBe(false);
    expect(equalsIgnoreCase(null, null)).toBe(false);
  });
});

describe('findUserByIdentifier case-insensitivity', () => {
  const usersConfig = {
    users: {
      user_1: {
        id: 'user_1',
        username: 'Daniel.Manzke',
        email: 'Daniel.Manzke@example.com',
        authMethods: ['local']
      }
    }
  };

  test('finds user by username regardless of case', () => {
    const user = findUserByIdentifier(usersConfig, 'daniel.manzke');
    expect(user?.id).toBe('user_1');
  });

  test('finds user by email regardless of case', () => {
    const user = findUserByIdentifier(usersConfig, 'daniel.manzke@example.com');
    expect(user?.id).toBe('user_1');
  });

  test('does not match an unrelated identifier', () => {
    expect(findUserByIdentifier(usersConfig, 'someone.else')).toBeNull();
  });
});
