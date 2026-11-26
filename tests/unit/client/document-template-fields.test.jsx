// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  cleanTemplate,
  emptyTemplate,
  normalizeTemplate
} from '../../../client/src/features/admin/utils/documentTemplates';

/**
 * The custom fields of a document template are declared in template.json
 * until the editor has a place for them. The editor must keep them when it
 * saves: its save body is built from a fixed list of sections.
 */

const FIELDS = {
  classification: { required: true, options: ['public', 'internal'], default: 'internal' },
  department: {}
};

describe('document template fields in the editor', () => {
  it('has none in a new template', () => {
    expect(emptyTemplate().fields).toEqual({});
  });

  it('keeps the fields of a template from the server in the draft', () => {
    expect(normalizeTemplate({ id: 'acme', name: { en: 'Acme' }, fields: FIELDS }).fields).toEqual(
      FIELDS
    );
  });

  it('keeps them when the draft is saved', () => {
    const draft = normalizeTemplate({ id: 'acme', name: { en: 'Acme' }, fields: FIELDS });
    draft.brand.companyName = 'Acme AG';
    expect(cleanTemplate(draft).fields).toEqual(FIELDS);
  });

  it('saves a template without fields with an empty list', () => {
    expect(cleanTemplate(normalizeTemplate({ id: 'acme', name: { en: 'Acme' } })).fields).toEqual(
      {}
    );
  });
});
