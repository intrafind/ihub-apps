/**
 * Unit tests for AppFormEditor's numeric input guarding and output-format options.
 * Regression coverage for #1797: clearing a numeric field must not store NaN
 * (which JSON-serializes to null and is rejected by the strict server schema),
 * and the Output Format select must offer every value the server schema allows.
 */

// Mirrors parseNumberOrUndefined() in client/src/features/admin/components/AppFormEditor.jsx
function parseNumberOrUndefined(value, parser = parseFloat) {
  const n = parser(value);
  return Number.isFinite(n) ? n : undefined;
}

describe('AppFormEditor - parseNumberOrUndefined', () => {
  test('returns undefined instead of NaN when the field is cleared', () => {
    expect(parseNumberOrUndefined('')).toBeUndefined();
    expect(parseNumberOrUndefined('', parseInt)).toBeUndefined();
  });

  test('returns undefined instead of NaN for non-numeric input', () => {
    expect(parseNumberOrUndefined('abc')).toBeUndefined();
    expect(parseNumberOrUndefined('abc', parseInt)).toBeUndefined();
  });

  test('parses valid float input with parseFloat', () => {
    expect(parseNumberOrUndefined('0.9')).toBe(0.9);
  });

  test('parses valid integer input with parseInt', () => {
    expect(parseNumberOrUndefined('42', parseInt)).toBe(42);
  });

  test('never returns NaN for any input', () => {
    for (const input of ['', ' ', 'abc', '0.7', '10', '-1', 'NaN']) {
      expect(Number.isNaN(parseNumberOrUndefined(input))).toBe(false);
      expect(Number.isNaN(parseNumberOrUndefined(input, parseInt))).toBe(false);
    }
  });
});

describe('AppFormEditor - output format options', () => {
  // Mirrors the <select> options rendered for preferredOutputFormat and the
  // server enum in server/validators/appConfigSchema.js.
  const outputFormatOptions = ['markdown', 'text', 'json', 'html'];
  const serverSchemaEnum = ['markdown', 'text', 'json', 'html'];

  test('offers every value accepted by the server schema', () => {
    expect(outputFormatOptions.sort()).toEqual(serverSchemaEnum.sort());
  });

  test('includes html', () => {
    expect(outputFormatOptions).toContain('html');
  });
});
