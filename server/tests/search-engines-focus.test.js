// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every web search engine takes the optional `focus` (#3511): its action
 * declares it, and its script hands it to the shared search extraction.
 */
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const searchWithExtractionMock = jest.fn(async () => ({ results: [] }));

jest.unstable_mockModule('../tools/lib/searchWithExtraction.js', () => ({
  default: searchWithExtractionMock
}));

const PARAMETERS = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../services/integrations/protocols/native/connectors/websearch/parameters.json',
        import.meta.url
      )
    ),
    'utf8'
  )
);

describe('the search engines accept a focus', () => {
  test.each(['brave', 'staan', 'qwant'])(
    '%s declares it as an optional string next to extractContent',
    engine => {
      const { properties, required } = PARAMETERS[engine].parameters;
      expect(properties.focus.type).toBe('string');
      expect(properties.focus.description.en).toBeTruthy();
      expect(properties.focus.description.de).toBeTruthy();
      expect(required).toEqual(['query']);
      expect(properties.extractContent).toBeDefined();
      expect(properties.contentMaxLength).toBeDefined();
    }
  );

  test.each(['braveSearch', 'staanSearch', 'qwantSearch'])(
    '%s hands the focus to the search extraction',
    async file => {
      const { default: search } = await import(`../tools/${file}.js`);
      searchWithExtractionMock.mockClear();
      await search({ query: 'enterprise plan', extractContent: true, focus: 'price per seat' });
      const [call] = searchWithExtractionMock.mock.calls[0];
      expect(call.focus).toBe('price per seat');
      expect(call.extractContent).toBe(true);

      searchWithExtractionMock.mockClear();
      await search({ query: 'enterprise plan' });
      expect(searchWithExtractionMock.mock.calls[0][0].focus).toBeUndefined();
    }
  );
});
