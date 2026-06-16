/**
 * Tests for the shared CSV helpers — quoting and spreadsheet formula-injection
 * neutralization.
 */
import { escapeCsvField, buildCsv } from '../utils/csv.js';

describe('escapeCsvField', () => {
  test('passes through plain values', () => {
    expect(escapeCsvField('hello')).toBe('hello');
    expect(escapeCsvField(42)).toBe('42');
    expect(escapeCsvField(null)).toBe('');
  });

  test('quotes values containing comma, quote, CR or newline', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('a"b')).toBe('"a""b"');
    expect(escapeCsvField('a\nb')).toBe('"a\nb"');
    expect(escapeCsvField('a\rb')).toBe('"a\rb"');
  });

  test('neutralizes formula-injection prefixes', () => {
    expect(escapeCsvField('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(escapeCsvField('+1')).toBe("'+1");
    expect(escapeCsvField('-1')).toBe("'-1");
    expect(escapeCsvField('@cmd')).toBe("'@cmd");
  });
});

describe('buildCsv', () => {
  test('builds header + rows', () => {
    const csv = buildCsv(
      ['a', 'b'],
      [
        ['1', '2'],
        ['x,y', '3']
      ]
    );
    expect(csv).toBe('a,b\n1,2\n"x,y",3\n');
  });

  test('header-only when no rows', () => {
    expect(buildCsv(['a', 'b'], [])).toBe('a,b\n');
  });
});
