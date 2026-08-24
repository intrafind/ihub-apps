import { describe, it, expect } from '@jest/globals';
import {
  BadFilterError,
  MAX_FILTER_VALUES,
  MAX_QUERY_LENGTH,
  clampInt,
  isFlagSet,
  parseAuditLogQuery
} from '../../../server/routes/admin/auditLogQueryParams.js';

describe('parseAuditLogQuery value separators', () => {
  it('passes the date range through untouched', () => {
    expect(parseAuditLogQuery({ from: '2026-08-01', to: '2026-08-02' })).toMatchObject({
      from: '2026-08-01',
      to: '2026-08-02'
    });
  });

  it('reads a single value', () => {
    expect(parseAuditLogQuery({ action: 'login' }).action).toEqual(['login']);
  });

  it('splits comma-separated values for the comma-free vocabularies', () => {
    expect(parseAuditLogQuery({ action: 'create,update' }).action).toEqual(['create', 'update']);
    expect(parseAuditLogQuery({ resource: 'app,model' }).resource).toEqual(['app', 'model']);
    expect(parseAuditLogQuery({ result: 'success,failure' }).result).toEqual([
      'success',
      'failure'
    ]);
    expect(parseAuditLogQuery({ source: 'web,admin' }).source).toEqual(['web', 'admin']);
  });

  it('reads repeated parameters', () => {
    expect(parseAuditLogQuery({ action: ['create', 'update'] }).action).toEqual([
      'create',
      'update'
    ]);
  });

  it('combines repeated and comma-separated parameters', () => {
    expect(parseAuditLogQuery({ action: ['create,update', 'delete'] }).action).toEqual([
      'create',
      'update',
      'delete'
    ]);
  });

  it('never comma-splits the actor, so a username may contain a comma', () => {
    expect(parseAuditLogQuery({ actor: 'Doe, John' }).actor).toEqual(['Doe, John']);
    expect(parseAuditLogQuery({ actor: ['Doe, John', 'alice'] }).actor).toEqual([
      'Doe, John',
      'alice'
    ]);
    expect(parseAuditLogQuery({ actorExclude: 'Doe, John' }).actorExclude).toEqual(['Doe, John']);
  });

  it('reads the exclude parameter of every field', () => {
    const parsed = parseAuditLogQuery({
      actorExclude: 'alice',
      resourceExclude: 'app,model',
      actionExclude: 'login',
      resultExclude: 'success',
      sourceExclude: 'web'
    });
    expect(parsed).toMatchObject({
      actorExclude: ['alice'],
      resourceExclude: ['app', 'model'],
      actionExclude: ['login'],
      resultExclude: ['success'],
      sourceExclude: ['web']
    });
  });

  it('keeps the wildcard as a plain value for the service to interpret', () => {
    expect(parseAuditLogQuery({ actionExclude: '*' }).actionExclude).toEqual(['*']);
  });

  it('leaves absent and empty parameters undefined', () => {
    const parsed = parseAuditLogQuery({ action: '', resource: ',,', source: [] });
    expect(parsed.action).toBeUndefined();
    expect(parsed.resource).toBeUndefined();
    expect(parsed.source).toBeUndefined();
    expect(parsed.actor).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(parseAuditLogQuery({ action: ' create , update ' }).action).toEqual([
      'create',
      'update'
    ]);
  });

  it('ignores non-string values (a nested object query parameter)', () => {
    expect(parseAuditLogQuery({ action: [{ evil: true }, 'create'] }).action).toEqual(['create']);
  });
});

describe('the filter-value cap', () => {
  it('matches the cap the checkbox UI encodes against', async () => {
    // A mismatch would let the UI emit a request its own server rejects.
    const client = await import('../../../client/src/features/admin/utils/auditLogFilters.js');
    expect(client.MAX_FILTER_VALUES).toBe(MAX_FILTER_VALUES);
  });
});

describe('parseAuditLogQuery limits', () => {
  it('accepts a filter set right at the cap', () => {
    const values = Array.from({ length: MAX_FILTER_VALUES }, (_, i) => `a${i}`);
    expect(parseAuditLogQuery({ action: values }).action).toHaveLength(MAX_FILTER_VALUES);
  });

  it('rejects a filter set beyond the cap', () => {
    const values = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => `a${i}`);
    expect(() => parseAuditLogQuery({ action: values })).toThrow(BadFilterError);
    expect(() => parseAuditLogQuery({ action: values.join(',') })).toThrow(BadFilterError);
    expect(() => parseAuditLogQuery({ actorExclude: values })).toThrow(BadFilterError);
  });

  it('rejects an over-long search term', () => {
    expect(parseAuditLogQuery({ q: 'x'.repeat(MAX_QUERY_LENGTH) }).q).toHaveLength(
      MAX_QUERY_LENGTH
    );
    expect(() => parseAuditLogQuery({ q: 'x'.repeat(MAX_QUERY_LENGTH + 1) })).toThrow(
      BadFilterError
    );
  });
});

describe('parseAuditLogQuery free-text search', () => {
  it('keeps a term verbatim', () => {
    expect(parseAuditLogQuery({ q: 'Created the app' }).q).toBe('Created the app');
  });

  it('drops a blank term', () => {
    expect(parseAuditLogQuery({ q: '   ' }).q).toBeUndefined();
    expect(parseAuditLogQuery({}).q).toBeUndefined();
  });

  it('takes the first value of a repeated parameter', () => {
    expect(parseAuditLogQuery({ q: ['first', 'second'] }).q).toBe('first');
  });
});

describe('isFlagSet', () => {
  it('accepts the truthy query-string spellings', () => {
    expect(isFlagSet('1')).toBe(true);
    expect(isFlagSet('true')).toBe(true);
    expect(isFlagSet('')).toBe(true); // a bare ?facets
    expect(isFlagSet(['1'])).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isFlagSet(undefined)).toBe(false);
    expect(isFlagSet('0')).toBe(false);
    expect(isFlagSet('false')).toBe(false);
    expect(isFlagSet('yes')).toBe(false);
  });
});

describe('clampInt', () => {
  it('falls back on unparseable input', () => {
    expect(clampInt(undefined, 50, 1, 1000)).toBe(50);
    expect(clampInt('abc', 50, 1, 1000)).toBe(50);
  });

  it('clamps to the bounds', () => {
    expect(clampInt('0', 50, 1, 1000)).toBe(1);
    expect(clampInt('-5', 0, 0, 1000)).toBe(0);
    expect(clampInt('99999', 50, 1, 1000)).toBe(1000);
    expect(clampInt('200', 50, 1, 1000)).toBe(200);
  });
});
