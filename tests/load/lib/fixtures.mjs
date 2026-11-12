// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Test documents for uploads and projects.
 *
 * By default a deterministic set is generated in memory (Markdown, text, HTML,
 * CSV, JSON and real multi-page PDFs) around a handful of business topics, so
 * project chats can ask questions the documents answer. Point LT_FIXTURES_DIR
 * (or `fixtures.dir`) at a folder of real documents (PDF, DOCX, PPTX, XLSX …)
 * to measure extraction with your customers' kind of files — recommended for
 * the sizing runs, since PDF/Office extraction dominates ingestion CPU.
 */

import fs from 'node:fs';
import path from 'node:path';

export const TOPICS = [
  {
    id: 'travel',
    title: 'Travel Expense Policy',
    facts: [
      'The maximum hotel rate in Munich is 180 EUR per night.',
      'Train travel in second class is the default for trips under 600 km.',
      'Receipts must be submitted within 30 days after the trip.',
      'Per diem for a full day in Germany is 28 EUR.',
      'Flights longer than six hours may be booked in premium economy.'
    ],
    keywords: ['hotel rate', 'per diem', 'receipts', 'premium economy', 'train travel']
  },
  {
    id: 'security',
    title: 'Security Incident Response Process',
    facts: [
      'Every incident must be reported to the SOC within 60 minutes.',
      'Severity 1 incidents require a bridge call within 15 minutes.',
      'Forensic images are kept for 180 days.',
      'The incident commander is the on-call security engineer.',
      'Customer notification follows within 72 hours where required by GDPR.'
    ],
    keywords: ['severity 1', 'forensic images', 'incident commander', 'SOC', 'notification']
  },
  {
    id: 'onboarding',
    title: 'Employee Onboarding Handbook',
    facts: [
      'New employees receive their laptop on the first day at 9:00.',
      'The buddy programme lasts twelve weeks.',
      'Mandatory compliance training must be completed within 14 days.',
      'Access to production systems is granted after the probation review.',
      'The welcome lunch takes place on the first Friday.'
    ],
    keywords: [
      'buddy programme',
      'compliance training',
      'probation review',
      'laptop',
      'welcome lunch'
    ]
  },
  {
    id: 'product',
    title: 'Product Release Notes 6.9',
    facts: [
      'Release 6.9 introduces hybrid search with a semantic reranker.',
      'The connector for SharePoint Online now supports incremental crawls.',
      'Index size was reduced by 18 percent through compression.',
      'The admin UI gained a bulk permission editor.',
      'Support for Java 17 runtime ends with release 6.11.'
    ],
    keywords: ['hybrid search', 'SharePoint', 'compression', 'bulk permission editor', 'Java 17']
  },
  {
    id: 'procurement',
    title: 'Procurement Guidelines',
    facts: [
      'Purchases above 10,000 EUR require three competing offers.',
      'Framework contracts are reviewed every 24 months.',
      'Suppliers must sign the code of conduct before the first order.',
      'Payment terms are 30 days net by default.',
      'Software purchases need approval from IT architecture.'
    ],
    keywords: [
      'competing offers',
      'framework contracts',
      'code of conduct',
      'payment terms',
      'IT architecture'
    ]
  }
];

const FILLER = (
  'The organisation reviews this guideline regularly and aligns it with legal requirements, ' +
  'internal audits and feedback from the departments that apply it in daily work. Managers are ' +
  'responsible for communicating changes to their teams, and employees are expected to read the ' +
  'current version before they act on it. Exceptions are documented in the ticket system together ' +
  'with the reason, the approver and the date of approval. '
).repeat(1);

/** Deterministic pseudo-random generator so every run uploads the same bytes. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Plain text of roughly `bytes` size about a topic, with its facts spread through it. */
export function topicText(topic, bytes, seed = 1) {
  const rand = rng(seed);
  const parts = [`${topic.title}\n\n`];
  let size = parts[0].length;
  let section = 1;
  while (size < bytes) {
    const fact = topic.facts[Math.floor(rand() * topic.facts.length)];
    const kw = topic.keywords[Math.floor(rand() * topic.keywords.length)];
    const block =
      `Section ${section}: ${kw}\n\n${fact} ${FILLER}` +
      `In section ${section} the rules about ${kw} are explained in detail. ${FILLER}\n\n`;
    parts.push(block);
    size += block.length;
    section += 1;
  }
  return parts.join('').slice(0, Math.max(bytes, 200));
}

function toMarkdown(text) {
  return text.replace(/^Section (\d+): (.*)$/gm, '## Section $1: $2');
}

function toHtml(title, text) {
  const body = text
    .split(/\n\n+/)
    .map(p => (p.startsWith('Section ') ? `<h2>${escapeHtml(p)}</h2>` : `<p>${escapeHtml(p)}</p>`))
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>\n${body}</body></html>`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function toCsv(topic, rows, seed) {
  const rand = rng(seed);
  const lines = ['id,topic,keyword,rule,amount_eur,owner'];
  for (let i = 1; i <= rows; i++) {
    const kw = topic.keywords[Math.floor(rand() * topic.keywords.length)];
    const fact = topic.facts[Math.floor(rand() * topic.facts.length)].replace(/,/g, '');
    lines.push(
      `${i},${topic.id},${kw},"${fact}",${Math.floor(rand() * 5000)},team-${1 + Math.floor(rand() * 12)}`
    );
  }
  return lines.join('\n');
}

/** A valid multi-page PDF with a text layer (Helvetica, WinAnsi), no dependencies. */
export function buildPdf(text) {
  const lines = [];
  for (const para of text.split('\n')) {
    let rest = para.replace(/[^\x20-\x7e]/g, ' ');
    if (!rest) {
      lines.push('');
      continue;
    }
    while (rest.length > 95) {
      let cut = rest.lastIndexOf(' ', 95);
      if (cut < 40) cut = 95;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    lines.push(rest);
  }
  const perPage = 56;
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (pages.length === 0) pages.push(['']);

  const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  const kids = [];
  pages.forEach((pageLines, i) => {
    const pageObj = 4 + i * 2;
    const contentObj = pageObj + 1;
    kids.push(`${pageObj} 0 R`);
    const stream =
      'BT /F1 10 Tf 13 TL 50 760 Td\n' +
      pageLines.map(l => `(${esc(l)}) Tj T*`).join('\n') +
      '\nET';
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objects[contentObj] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = Buffer.byteLength(out, 'latin1');
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++)
    out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const MIME = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.eml': 'message/rfc822'
};

/**
 * Generated set: per topic a small Markdown, a medium PDF, an HTML page, a CSV
 * and a JSON file, plus one large text file and one large PDF overall.
 */
export function generateFixtures() {
  const files = [];
  TOPICS.forEach((topic, i) => {
    const seed = 1000 + i;
    files.push({
      name: `${topic.id}-summary.md`,
      mime: MIME['.md'],
      buffer: Buffer.from(toMarkdown(topicText(topic, 12_000, seed))),
      topic: topic.id
    });
    files.push({
      name: `${topic.id}-handbook.pdf`,
      mime: MIME['.pdf'],
      buffer: buildPdf(topicText(topic, 120_000, seed + 1)),
      topic: topic.id
    });
    files.push({
      name: `${topic.id}-page.html`,
      mime: MIME['.html'],
      buffer: Buffer.from(toHtml(topic.title, topicText(topic, 30_000, seed + 2))),
      topic: topic.id
    });
    files.push({
      name: `${topic.id}-register.csv`,
      mime: MIME['.csv'],
      buffer: Buffer.from(toCsv(topic, 800, seed + 3)),
      topic: topic.id
    });
    files.push({
      name: `${topic.id}-facts.json`,
      mime: MIME['.json'],
      buffer: Buffer.from(
        JSON.stringify(
          { title: topic.title, facts: topic.facts, keywords: topic.keywords },
          null,
          2
        )
      ),
      topic: topic.id
    });
  });
  files.push({
    name: 'archive-large.txt',
    mime: MIME['.txt'],
    buffer: Buffer.from(topicText(TOPICS[0], 2_000_000, 77)),
    topic: TOPICS[0].id
  });
  files.push({
    name: 'manual-large.pdf',
    mime: MIME['.pdf'],
    buffer: buildPdf(topicText(TOPICS[3], 1_200_000, 78)),
    topic: TOPICS[3].id
  });
  return files;
}

/** Files of a directory with a supported extension (not recursive). */
export function readFixtureDir(dir) {
  return fs
    .readdirSync(dir)
    .filter(name => MIME[path.extname(name).toLowerCase()])
    .map(name => ({
      name,
      mime: MIME[path.extname(name).toLowerCase()],
      buffer: fs.readFileSync(path.join(dir, name)),
      topic: null
    }));
}

export function loadFixtures(dir) {
  const files = dir ? readFixtureDir(dir) : generateFixtures();
  if (files.length === 0) throw new Error(`No supported fixture files in ${dir}`);
  return files;
}

/** Questions a user would ask about a topic (or generically about a document). */
export function questionsFor(topicId) {
  const topic = TOPICS.find(t => t.id === topicId);
  if (!topic) {
    return [
      'Summarize the attached document in five bullet points.',
      'What are the three most important rules in this document?',
      'Which deadlines or numbers does the document mention?',
      'Who is responsible for what according to the document?'
    ];
  }
  return [
    `Summarize the ${topic.title} in five bullet points.`,
    ...topic.keywords.map(kw => `What does the ${topic.title} say about ${kw}?`),
    `List every number and deadline mentioned in the ${topic.title}.`
  ];
}

export function multipart(file, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append('file', new Blob([file.buffer], { type: file.mime }), file.name);
  return form;
}
