#!/usr/bin/env node
/**
 * Static site generator for the iHub Apps marketing website.
 *
 * Renders every page module in `_src/pages/` into `website/<page>.html` and
 * builds `changelog.html` from `docs/releases/`. No dependencies beyond Node.
 *
 *   node website/_src/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '..');
const REPO = path.resolve(here, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

const SITE = {
  name: 'iHub Apps',
  tagline: 'The open-source AI platform for your whole organization.',
  url: 'https://intrafind.github.io/ihub-apps',
  github: 'https://github.com/intrafind/ihub-apps',
  releases: 'https://github.com/intrafind/ihub-apps/releases',
  docs: 'https://github.com/intrafind/ihub-apps/blob/main/docs/README.md',
  docsBase: 'https://github.com/intrafind/ihub-apps/blob/main/docs/',
  contact: 'mailto:sales@intrafind.com',
  company: 'IntraFind Software AG',
  companyUrl: 'https://intrafind.com/',
  version: pkg.version
};

// --- Icons (inline SVG, stroke based) -------------------------------------
const I = {
  chat: '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 1 1 21 12z"/>',
  apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  workflow:
    '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M9 6h4a3 3 0 0 1 3 3v6"/><path d="M12 15l3 3 3-3"/>',
  plug: '<path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0V8z"/><path d="M12 16v6"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  shield:
    '<path d="M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3z"/><path d="m9 12 2 2 4-4"/>',
  building:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7h.01M12 7h.01M16 7h.01M8 11h.01M12 11h.01M16 11h.01M9 21v-4h6v4"/>',
  tag: '<path d="M20 12 12 20 3 11V3h8l9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  book: '<path d="M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4V4zM20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6V4z"/>',
  sparkles:
    '<path d="m12 3 1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15zM5 15l.6 1.4L7 17l-1.4.6L5 19l-.6-1.4L3 17l1.4-.6L5 15z"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  server:
    '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  users:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.5A5 5 0 0 1 21.5 20"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  github:
    '<path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7 3.6 3.6 0 0 1 .1-2.7s.8-.3 2.8 1a9.5 9.5 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1a3.6 3.6 0 0 1 .1 2.7 3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"/><path d="M14 3v6h6M8 13h8M8 17h6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  image:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5-9 9"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  puzzle:
    '<path d="M10 3h4v3a2 2 0 1 0 4 0h3v4h-3a2 2 0 1 0 0 4h3v4h-3a2 2 0 1 0-4 0v3h-4v-3a2 2 0 1 0-4 0H3v-4h3a2 2 0 1 0 0-4H3V6h3a2 2 0 1 0 4 0V3z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M15 5l3 3M18 8l2-2"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/>',
  languages: '<path d="M4 5h8M8 3v2M6 5c0 4 3 7 6 8M11 5c-1 4-4 7-7 8M13 21l4-10 4 10M14.5 17h5"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  window:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>'
};
const icon = (name, cls = '') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name] || I.sparkles}</svg>`;

// --- Navigation model -----------------------------------------------------
export const PRODUCTS = [
  {
    href: 'chat.html',
    icon: 'chat',
    title: 'Chat',
    text: 'Model-agnostic chat for everyone in the company.'
  },
  {
    href: 'apps.html',
    icon: 'apps',
    title: 'Apps',
    text: 'Ready-made AI assistants for recurring tasks.'
  },
  {
    href: 'workflows.html',
    icon: 'workflow',
    title: 'Workflows & Agents',
    text: 'Multi-step automation with human approval.'
  },
  {
    href: 'integrations.html',
    icon: 'plug',
    title: 'Integrations',
    text: 'Tools, MCP, Outlook, browser, Nextcloud, Teams.'
  },
  {
    href: 'api.html',
    icon: 'code',
    title: 'API',
    text: 'OpenAI-compatible API, MCP gateway, OAuth.'
  },
  {
    href: 'models.html',
    icon: 'cpu',
    title: 'Models',
    text: 'Every major provider plus local models.'
  }
];
const LEARN = [
  {
    href: 'docs.html',
    icon: 'book',
    title: 'Documentation',
    text: 'Guides for users, admins and developers.'
  },
  {
    href: 'changelog.html',
    icon: 'clock',
    title: 'Changelog',
    text: 'What shipped in every release.'
  },
  {
    href: 'security.html',
    icon: 'shield',
    title: 'Security & privacy',
    text: 'Data control, identity, encryption, audit.'
  },
  { href: SITE.github, icon: 'github', title: 'GitHub', text: 'Source code, issues and releases.' }
];

const esc = s =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const shot = (src, alt, opts = {}) => {
  const cls = ['shot', opts.browser ? 'browser' : '', opts.zoom === false ? '' : 'zoomable']
    .filter(Boolean)
    .join(' ');
  return `<figure class="${cls}"><img src="assets/screenshots/${src}" alt="${esc(alt)}" loading="${opts.eager ? 'eager' : 'lazy'}" decoding="async"></figure>`;
};

// --- Partials -------------------------------------------------------------
function nav(active) {
  const menu = (items, narrow = false) =>
    `<div class="menu${narrow ? ' narrow' : ''}">${items
      .map(
        i =>
          `<a href="${i.href}"${i.href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}><span class="ico">${icon(i.icon)}</span><span><strong>${i.title}</strong><small>${i.text}</small></span></a>`
      )
      .join('')}</div>`;
  const link = (href, label) =>
    `<a href="${href}"${active === href ? ' class="active"' : ''}>${label}</a>`;
  return `<header class="nav" id="top">
  <div class="wrap">
    <a class="brand" href="index.html" aria-label="iHub Apps home"><img src="assets/img/ihub-mark.svg" alt=""><span>iHub <b>Apps</b></span></a>
    <ul class="nav-links">
      <li><button type="button" aria-expanded="false" aria-haspopup="true">Platform ${icon('chevron')}</button>${menu(PRODUCTS)}</li>
      <li><button type="button" aria-expanded="false" aria-haspopup="true">Learn ${icon('chevron')}</button>${menu(LEARN, true)}</li>
      <li>${link('security.html', 'Security')}</li>
      <li>${link('enterprise.html', 'Enterprise')}</li>
      <li>${link('pricing.html', 'Pricing')}</li>
    </ul>
    <div class="nav-spacer"></div>
    <div class="nav-cta">
      <a class="btn secondary sm hide-m" href="${SITE.github}" target="_blank" rel="noopener">${icon('github')} GitHub</a>
      <a class="btn primary sm" href="${SITE.releases}" target="_blank" rel="noopener">Get started</a>
      <button class="nav-toggle" type="button" aria-label="Open menu" aria-expanded="false">${icon('menu')}</button>
    </div>
  </div>
</header>`;
}

function trust() {
  return `<section class="trust" aria-label="Trust">
  <div class="wrap">
    <div class="item"><span class="ico">${icon('github')}</span><div><strong>Open source</strong><span>BSD-3-Clause with attribution. Full source on GitHub.</span></div></div>
    <div class="item"><span class="ico">${icon('server')}</span><div><strong>Deployable anywhere</strong><span>Binary, Docker, Windows service, on-prem or air-gapped.</span></div></div>
    <div class="item"><span class="ico">${icon('shield')}</span><div><strong>GDPR by design</strong><span>Your infrastructure, your models, your data. Made in Germany.</span></div></div>
  </div>
</section>`;
}

function cta(custom = {}) {
  const title = custom.title || 'Run iHub Apps in 60 seconds.';
  const text =
    custom.text ||
    'One command installs the standalone binary. No Node.js, no Docker, no database. Open http://localhost:3000, add a model key, and your team has 24 AI apps.';
  return `<section class="cta">
  <div class="wrap">
    <div class="box">
      <h2>${title}</h2>
      <p class="lead">${text}</p>
      <pre><code>curl -fsSL https://raw.githubusercontent.com/intrafind/ihub-apps/main/install.sh | sh</code></pre>
      <div class="btn-row">
        <a class="btn primary" href="${SITE.releases}" target="_blank" rel="noopener">${icon('download')} Download for Linux, macOS, Windows</a>
        <a class="btn secondary" href="${SITE.contact}">Talk to IntraFind</a>
      </div>
    </div>
  </div>
</section>`;
}

function footer() {
  const col = (title, items) =>
    `<div><h4>${title}</h4><ul>${items.map(([l, h]) => `<li><a href="${h}"${h.startsWith('http') || h.startsWith('mailto') ? ' target="_blank" rel="noopener"' : ''}>${l}</a></li>`).join('')}</ul></div>`;
  return `<footer>
  <div class="wrap">
    <div class="foot-grid">
      <div class="foot-brand">
        <a class="brand" href="index.html"><img src="assets/img/ihub-mark.svg" alt=""><span>iHub <b>Apps</b></span></a>
        <p>${SITE.tagline} Built by <a href="${SITE.companyUrl}" target="_blank" rel="noopener">${SITE.company}</a> in Berlin, Bonn and Munich.</p>
      </div>
      ${col('Platform', [
        ['Chat', 'chat.html'],
        ['Apps', 'apps.html'],
        ['Workflows & Agents', 'workflows.html'],
        ['Integrations', 'integrations.html'],
        ['API', 'api.html'],
        ['Models', 'models.html'],
        ['Outlook add-in', 'integrations.html#outlook'],
        ['Browser extension', 'integrations.html#browser'],
        ['Nextcloud app', 'integrations.html#nextcloud']
      ])}
      ${col('Learn', [
        ['Documentation', 'docs.html'],
        ['Changelog', 'changelog.html'],
        ['Security & privacy', 'security.html'],
        ['Enterprise', 'enterprise.html'],
        ['Pricing', 'pricing.html'],
        ['Releases', SITE.releases],
        ['Docker image', 'https://github.com/intrafind/ihub-apps/pkgs/container/ihub-apps']
      ])}
      ${col('Company', [
        ['IntraFind', SITE.companyUrl],
        ['Contact sales', SITE.contact],
        ['GitHub', SITE.github],
        ['Issues', SITE.github + '/issues'],
        ['License', SITE.github + '/blob/main/LICENSE']
      ])}
      ${col('Also by IntraFind', [
        ['iFinder enterprise search', 'https://intrafind.com/'],
        ['iAssistant', 'https://intrafind.com/']
      ])}
    </div>
    <div class="foot-bottom">
      <span>© ${new Date().getFullYear()} ${SITE.company}. iHub Apps ${SITE.version}.</span>
      <span><a href="${SITE.companyUrl}" target="_blank" rel="noopener">Imprint</a> · <a href="${SITE.companyUrl}" target="_blank" rel="noopener">Privacy policy</a> · <a href="${SITE.github}/blob/main/LICENSE" target="_blank" rel="noopener">License</a></span>
    </div>
  </div>
</footer>`;
}

// --- Section renderers ----------------------------------------------------
const R = {
  hero(s) {
    return `<section class="hero">
  <div class="wrap">
    ${s.eyebrow ? `<span class="eyebrow">${s.eyebrow}</span>` : ''}
    <h1>${s.title}</h1>
    <p class="lead">${s.lead}</p>
    <div class="btn-row">${(s.ctas || [])
      .map(
        c =>
          `<a class="btn ${c.primary ? 'primary' : 'secondary'}" href="${c.href}"${c.href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${c.icon ? icon(c.icon) : ''}${c.label}</a>`
      )
      .join('')}</div>
    ${s.sub ? `<p class="sub">${s.sub}</p>` : ''}
    ${s.image ? `<div class="hero-art">${shot(s.image, s.alt || '', { browser: true, eager: true })}</div>` : ''}
  </div>
</section>`;
  },
  stats(s) {
    return `<section class="section tight${s.soft ? ' soft' : ''}"><div class="wrap">
    ${s.title ? `<div class="section-head center"><h2>${s.title}</h2>${s.lead ? `<p class="lead">${s.lead}</p>` : ''}</div>` : ''}
    <div class="stats">${s.items.map(i => `<div class="stat"><b>${i.value}</b><span>${i.label}</span></div>`).join('')}</div>
    ${s.note ? `<p class="muted center mt-2" style="font-size:.9rem">${s.note}</p>` : ''}
  </div></section>`;
  },
  cards(s) {
    const cols = s.cols || Math.min(s.items.length, 3);
    return `<section class="section${s.soft ? ' soft' : ''}" ${s.id ? `id="${s.id}"` : ''}><div class="wrap">
    ${s.title ? `<div class="section-head${s.center === false ? '' : ' center'}">${s.eyebrow ? `<span class="eyebrow">${s.eyebrow}</span>` : ''}<h2>${s.title}</h2>${s.lead ? `<p class="lead">${s.lead}</p>` : ''}</div>` : ''}
    <div class="grid cols-${cols}${s.docs ? ' doc-cards' : ''}">${s.items
      .map(i => {
        const tag = i.href ? 'a' : 'div';
        const href = i.href
          ? ` href="${i.href}"${i.href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}`
          : '';
        return `<${tag} class="card${s.softCards ? ' soft' : ''}"${href}>${i.icon ? `<span class="ico">${icon(i.icon)}</span>` : ''}<h3>${i.title}${i.badge ? `<span class="badge ${i.badgeClass || ''}">${i.badge}</span>` : ''}</h3><p>${i.text}</p>${i.href ? `<span class="more">${i.more || 'Learn more'} →</span>` : ''}</${tag}>`;
      })
      .join('')}</div>
  </div></section>`;
  },
  features(s) {
    return `<section class="section${s.soft ? ' soft' : ''}" ${s.id ? `id="${s.id}"` : ''}><div class="wrap">
    ${s.title ? `<div class="section-head${s.center ? ' center' : ''}">${s.eyebrow ? `<span class="eyebrow">${s.eyebrow}</span>` : ''}<h2>${s.title}</h2>${s.lead ? `<p class="lead">${s.lead}</p>` : ''}</div>` : ''}
    ${s.items
      .map(
        (f, i) => `<div class="feature${i % 2 ? ' flip' : ''}" ${f.id ? `id="${f.id}"` : ''}>
      <div class="feature-text">
        ${f.eyebrow ? `<span class="eyebrow">${f.eyebrow}</span>` : ''}
        <h3>${f.title}${f.badge ? `<span class="badge ${f.badgeClass || ''}">${f.badge}</span>` : ''}</h3>
        <p>${f.text}</p>
        ${f.bullets ? `<ul>${f.bullets.map(b => `<li>${b}</li>`).join('')}</ul>` : ''}
        ${f.link ? `<p class="mt-1"><a class="btn ghost" href="${f.link.href}"${f.link.href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${f.link.label} ${icon('arrow')}</a></p>` : ''}
      </div>
      <div class="feature-media">${f.image ? shot(f.image, f.alt || f.title, { browser: f.browser !== false }) : f.html || ''}</div>
    </div>`
      )
      .join('')}
  </div></section>`;
  },
  tabs(s) {
    return `<section class="section${s.soft ? ' soft' : ''}" ${s.id ? `id="${s.id}"` : ''}><div class="wrap" data-tabs>
    <div class="section-head center"><h2>${s.title}</h2>${s.lead ? `<p class="lead">${s.lead}</p>` : ''}</div>
    <div class="tabs" role="tablist">${s.tabs.map((t, i) => `<button type="button" role="tab" aria-selected="${i === 0}">${t.label}</button>`).join('')}</div>
    ${s.tabs
      .map(
        (t, i) =>
          `<div class="tab-panel${i === 0 ? ' active' : ''}" role="tabpanel">${shot(t.image, t.alt || t.label, { browser: true })}${t.caption ? `<p class="caption">${t.caption}</p>` : ''}</div>`
      )
      .join('')}
  </div></section>`;
  },
  bento(s) {
    return `<section class="section${s.soft ? ' soft' : ''}" ${s.id ? `id="${s.id}"` : ''}><div class="wrap">
    <div class="section-head center"><h2>${s.title}</h2>${s.lead ? `<p class="lead">${s.lead}</p>` : ''}</div>
    <div class="bento">${s.items
      .map(
        i =>
          `<div class="tile"><div class="txt"><h3>${i.title}${i.badge ? `<span class="badge ${i.badgeClass || ''}">${i.badge}</span>` : ''}</h3><p>${i.text}</p></div>${i.image ? shot(i.image, i.alt || i.title) : ''}</div>`
      )
      .join('')}</div>
  </div></section>`;
  },
  faq(s) {
    return `<section class="section soft" id="faq"><div class="wrap">
    <div class="section-head center"><h2>${s.title || 'Questions & answers'}</h2></div>
    <div class="faq">${s.items.map(i => `<details><summary>${i.q}</summary><div class="answer"><p>${i.a}</p></div></details>`).join('')}</div>
  </div></section>`;
  },
  crosssell(s) {
    const items = PRODUCTS.filter(p => p.href !== s.exclude);
    return `<section class="section"><div class="wrap">
    <div class="section-head center"><h2>The essential AI stack for your company.</h2><p class="lead">Simple for business users. Ready for advanced use cases. Governed by IT.</p></div>
    <div class="grid cols-${Math.min(items.length, 5)}">${items.map(p => `<a class="card" href="${p.href}"><span class="ico">${icon(p.icon)}</span><h3>${p.title}</h3><p>${p.text}</p><span class="more">Learn more →</span></a>`).join('')}</div>
  </div></section>`;
  },
  table(s) {
    return `<section class="section${s.soft ? ' soft' : ''}" ${s.id ? `id="${s.id}"` : ''}><div class="wrap">
    ${s.title ? `<div class="section-head${s.center ? ' center' : ''}"><h2>${s.title}</h2>${s.lead ? `<p class="lead">${s.lead}</p>` : ''}</div>` : ''}
    <div class="table-wrap"><table><thead><tr>${s.columns.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${s.rows
      .map(
        r =>
          `<tr>${r.map(c => `<td>${c === true ? '<span class="ok">✓</span>' : c === false ? '<span class="no">—</span>' : c}</td>`).join('')}</tr>`
      )
      .join('')}</tbody></table></div>
    ${s.note ? `<p class="muted mt-1" style="font-size:.9rem">${s.note}</p>` : ''}
  </div></section>`;
  },
  steps(s) {
    return `<section class="section${s.soft ? ' soft' : ''}" ${s.id ? `id="${s.id}"` : ''}><div class="wrap">
    <div class="section-head center"><h2>${s.title}</h2>${s.lead ? `<p class="lead">${s.lead}</p>` : ''}</div>
    <div class="steps">${s.items.map(i => `<div class="step"><h3>${i.title}</h3><p>${i.text}</p>${i.code ? `<pre><code>${esc(i.code)}</code></pre>` : ''}</div>`).join('')}</div>
  </div></section>`;
  },
  html(s) {
    return `<section class="section${s.soft ? ' soft' : ''}" ${s.id ? `id="${s.id}"` : ''}><div class="wrap">${s.html}</div></section>`;
  },
  cta: s => cta(s),
  trust: () => trust()
};

// --- Page shell -----------------------------------------------------------
function page(p) {
  const body = p.sections.map(s => (R[s.type] || (() => ''))(s)).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:type" content="website">
${p.ogImage ? `<meta property="og:image" content="assets/screenshots/${p.ogImage}">` : ''}
<link rel="icon" href="assets/img/favicon.ico">
<link rel="stylesheet" href="assets/css/site.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${nav(p.file)}
<main id="main">
${body}
</main>
${footer()}
<script src="assets/js/site.js" defer></script>
</body>
</html>
`;
}

// --- Changelog from docs/releases -----------------------------------------
function mdInline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (m, a, h) =>
        `<a href="${h.startsWith('http') ? h : SITE.docsBase + h}" target="_blank" rel="noopener">${a}</a>`
    );
}
function mdBlock(md) {
  const lines = md.split('\n');
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${mdInline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<ul>${list.map(l => `<li>${mdInline(l)}</li>`).join('')}</ul>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*[-*] /.test(line)) {
      flushPara();
      (list ||= []).push(line.replace(/^\s*[-*] /, ''));
    } else if (/^\s{2,}\S/.test(raw) && list) {
      list[list.length - 1] += ' ' + line.trim();
    } else if (line.trim() === '') {
      flushPara();
      flushList();
    } else if (/^```/.test(line)) {
      // ignore fences; keep content as paragraph text
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out.join('');
}
function parseEntries(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const parts = text.split(/^## /m).slice(1);
  return parts.map(p => {
    const [title, ...rest] = p.split('\n');
    return { title: title.trim(), body: mdBlock(rest.join('\n').trim()) };
  });
}
function changelogSections() {
  const dir = path.join(REPO, 'docs/releases');
  const versions = fs
    .readdirSync(dir)
    .filter(v => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const releases = versions
    .map(v => {
      const d = path.join(dir, v);
      const groups = [
        ['breaking', 'Breaking', parseEntries(path.join(d, 'breaking-changes.md'))],
        ['feature', 'New', parseEntries(path.join(d, 'features.md'))],
        ['fix', 'Fixed', parseEntries(path.join(d, 'fixes.md'))]
      ].filter(g => g[2].length);
      if (!groups.length) return '';
      return `<article class="release" id="v${v}"><div class="ver">${v}<small>${groups.reduce((n, g) => n + g[2].length, 0)} entries</small></div><div>${groups
        .map(([k, label, entries]) =>
          entries
            .map(
              e => `<h3><span class="kind ${k}">${label}</span>${mdInline(e.title)}</h3>${e.body}`
            )
            .join('')
        )
        .join('')}</div></article>`;
    })
    .filter(Boolean);
  return `<div class="log">${releases.join('')}</div>`;
}

// --- Build ----------------------------------------------------------------
async function build() {
  const pagesDir = path.join(here, 'pages');
  const files = fs
    .readdirSync(pagesDir)
    .filter(f => f.endsWith('.mjs'))
    .sort();
  const ctx = { SITE, icon, shot, changelogSections, PRODUCTS, esc };
  let n = 0;
  for (const f of files) {
    const mod = await import(path.join(pagesDir, f));
    const p = typeof mod.default === 'function' ? mod.default(ctx) : mod.default;
    fs.writeFileSync(path.join(OUT, p.file), page(p));
    n++;
  }
  console.log(`Built ${n} pages into ${path.relative(REPO, OUT)}/ (iHub Apps ${SITE.version})`);
}

build().catch(e => {
  console.error(e);
  process.exit(1);
});
