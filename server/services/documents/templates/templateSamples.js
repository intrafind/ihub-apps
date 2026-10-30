// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createPdf, renderPagePreview } from '../pdf/PdfService.js';
import { renderInWorker } from '../renderService.js';
import {
  applyTemplateToDocxSpec,
  applyTemplateToPdfSpec,
  applyTemplateToPptxSpec
} from './applyTemplate.js';
import { loadTemplateBundle } from './DocumentTemplateService.js';

/**
 * Sample documents for the admin's template editor: the same content in PDF,
 * Word and PowerPoint, rendered with a template, so the admin sees how
 * generated documents will look before an app uses the template.
 */

const TEXT = {
  en: {
    title: 'Sample report',
    subtitle: 'How generated documents look with this template',
    markdown: `## Summary

Documents the assistant creates use this template: its colours, fonts, logo, header and footer. This paragraph shows **bold**, *italic* and a [link](https://example.com).

> [!NOTE]
> Callouts, tables and lists take the template's colours.

## Figures

| Region | Revenue (k€) | Growth |
|---|---:|---:|
| EMEA | 1,200 | +12 % |
| APAC | 800 | +4 % |
| Americas | 1,050 | –2 % |

## Next steps

1. Review the figures
2. Agree on the budget
   - Marketing
   - Sales
3. Present to the board
`,
    slides: [
      { layout: 'title', title: 'Sample presentation', subtitle: 'How generated slides look' },
      {
        title: 'Highlights',
        text: '- Revenue grew 12 %\n- 40 new customers\n  - 25 enterprise\n- Churn down to 3.1 %'
      },
      { layout: 'section', title: 'Figures' },
      {
        title: 'Revenue by region',
        chart: {
          type: 'column',
          categories: ['EMEA', 'APAC', 'Americas'],
          series: [
            { name: '2025', values: [1.1, 0.7, 1.0] },
            { name: '2026', values: [1.2, 0.8, 1.05] }
          ]
        },
        text: 'Revenue in € million'
      },
      {
        title: 'Pipeline',
        table: {
          header: ['Deal', 'Stage', 'Value (k€)'],
          rows: [
            ['Contoso', 'Negotiation', '450'],
            ['Fabrikam', 'Proposal', '320']
          ],
          align: ['left', 'left', 'right']
        }
      },
      {
        layout: 'two-column',
        title: 'Options',
        left: { heading: 'Build', text: '- Full control\n- 9 months' },
        right: { heading: 'Buy', text: '- Live in 2 months\n- Licence fees' }
      }
    ]
  },
  de: {
    title: 'Beispielbericht',
    subtitle: 'So sehen erzeugte Dokumente mit dieser Vorlage aus',
    markdown: `## Zusammenfassung

Dokumente, die der Assistent erstellt, verwenden diese Vorlage: Farben, Schriften, Logo, Kopf- und Fußzeile. Dieser Absatz zeigt **fett**, *kursiv* und einen [Link](https://example.com).

> [!NOTE]
> Hinweisboxen, Tabellen und Listen übernehmen die Farben der Vorlage.

## Zahlen

| Region | Umsatz (T€) | Wachstum |
|---|---:|---:|
| EMEA | 1.200 | +12 % |
| APAC | 800 | +4 % |
| Amerika | 1.050 | –2 % |

## Nächste Schritte

1. Zahlen prüfen
2. Budget abstimmen
   - Marketing
   - Vertrieb
3. Dem Vorstand vorstellen
`,
    slides: [
      { layout: 'title', title: 'Beispielpräsentation', subtitle: 'So sehen erzeugte Folien aus' },
      {
        title: 'Highlights',
        text: '- Umsatz +12 %\n- 40 Neukunden\n  - 25 Großkunden\n- Kündigungsrate 3,1 %'
      },
      { layout: 'section', title: 'Zahlen' },
      {
        title: 'Umsatz nach Region',
        chart: {
          type: 'column',
          categories: ['EMEA', 'APAC', 'Amerika'],
          series: [
            { name: '2025', values: [1.1, 0.7, 1.0] },
            { name: '2026', values: [1.2, 0.8, 1.05] }
          ]
        },
        text: 'Umsatz in Mio. €'
      },
      {
        title: 'Pipeline',
        table: {
          header: ['Projekt', 'Phase', 'Wert (T€)'],
          rows: [
            ['Contoso', 'Verhandlung', '450'],
            ['Fabrikam', 'Angebot', '320']
          ],
          align: ['left', 'left', 'right']
        }
      },
      {
        layout: 'two-column',
        title: 'Optionen',
        left: { heading: 'Selbst bauen', text: '- Volle Kontrolle\n- 9 Monate' },
        right: { heading: 'Kaufen', text: '- In 2 Monaten live\n- Lizenzkosten' }
      }
    ]
  }
};

/**
 * Render a sample document with a template.
 *
 * @param {Object} template - A template (enabled or not).
 * @param {'pdf'|'png'|'docx'|'pptx'} format - `png` is the first PDF page.
 * @param {string} [language]
 * @returns {Promise<{ buffer: Buffer, filename: string }>}
 */
export async function renderTemplateSample(template, format, language = 'en') {
  const text = TEXT[String(language).slice(0, 2)] || TEXT.en;
  const lang = String(language).slice(0, 2) === 'de' ? 'de' : 'en';
  const filename = `${template.id}-sample.${format}`;
  if (format === 'pdf' || format === 'png') {
    const bundle = await loadTemplateBundle(template, 'pdf');
    const { spec, assets } = applyTemplateToPdfSpec(
      {
        title: text.title,
        subtitle: text.subtitle,
        language: lang,
        markdown: text.markdown,
        pageNumbers: true
      },
      bundle
    );
    const { buffer } = await createPdf(spec, { assets });
    if (format === 'pdf') return { buffer, filename };
    return { buffer: (await renderPagePreview(buffer, 1)).png, filename };
  }
  if (format === 'docx') {
    const bundle = await loadTemplateBundle(template, 'docx');
    const { spec, assets } = applyTemplateToDocxSpec(
      {
        title: text.title,
        subtitle: text.subtitle,
        language: lang,
        markdown: text.markdown,
        pageNumbers: true
      },
      bundle
    );
    const { buffer } = await renderInWorker('docx', { spec, assets });
    return { buffer, filename };
  }
  const bundle = await loadTemplateBundle(template, 'pptx');
  const { spec, assets } = applyTemplateToPptxSpec(
    { title: text.title, language: lang === 'de' ? 'de-DE' : 'en-US', slides: text.slides },
    bundle
  );
  const { buffer } = await renderInWorker('pptx', { spec, assets });
  return { buffer, filename };
}
