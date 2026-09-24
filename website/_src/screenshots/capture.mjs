/**
 * Captures the product screenshots used by the website from a running iHub instance.
 *
 * Usage: node capture.mjs [batch ...]
 * Batches: static (every user and admin page), dynamic (chat answers, workflow editor, canvas, mobile),
 *          extras (share modal, history, dark mode, API docs, command palette), round3/round4/round5
 *          (model selector, email composer, mermaid, compare mode, canvas refinements). No argument runs everything.
 * Env:     IHUB_URL (default http://localhost:5173), IHUB_API_URL (default http://localhost:3000),
 *          SHOTS_DIR (default ./out), CHROME_PATH (optional Chromium executable).
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const BASE = process.env.IHUB_URL || 'http://localhost:5173';
const API = process.env.IHUB_API_URL || 'http://localhost:3000';
const OUT = process.env.SHOTS_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
fs.mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
const want = n => only.length === 0 || only.includes(n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
);
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  locale: 'en-US',
  colorScheme: 'light'
});
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    sessionStorage.setItem('setup_skipped', '1');
  } catch {}
});
const page = await ctx.newPage();
page.setDefaultTimeout(20000);

async function shot(name, opts = {}) {
  await sleep(opts.wait ?? 700);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: opts.fullPage ?? false });
  console.log('shot', name);
}
async function go(path, opts = {}) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await sleep(opts.wait ?? 600);
}
async function login() {
  await go('/login');
  await page.fill('input[name="username"]', 'admin');
  await page.fill('input[name="password"]', 'password123');
  await page.click('button[type="submit"]');
  await page.waitForURL(u => !u.pathname.endsWith('/login'));
  await sleep(800);
}
async function send(text, waitMs = 4500) {
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('textarea[aria-label="Type your message"]')].find(
      e => e.offsetWidth > 0
    );
    if (el) {
      el.focus();
      el.click();
    }
  });
  await sleep(150);
  await page.keyboard.insertText(text);
  await sleep(250);
  await page.keyboard.press('Enter');
  await sleep(waitMs);
}

await login();

const staticPages = {
  home: '/',
  apps: '/apps',
  prompts: '/prompts',
  chats: '/chats',
  workflows: '/workflows',
  'admin-overview': '/admin',
  'admin-apps': '/admin/apps',
  'admin-app-edit': '/admin/apps/email-composer',
  'admin-models': '/admin/models',
  'admin-model-edit': '/admin/models/claude-sonnet-5',
  'admin-providers': '/admin/providers',
  'admin-prompts': '/admin/prompts',
  'admin-tools': '/admin/tools',
  'admin-skills': '/admin/skills',
  'admin-sources': '/admin/sources',
  'admin-workflows': '/admin/workflows',
  'admin-workflow-executions': '/admin/workflows/executions',
  'admin-agents': '/admin/agents',
  'admin-agent-edit': '/admin/agents/claude-style-agent',
  'admin-agent-inboxes': '/admin/agents/inboxes',
  'admin-agent-approvals': '/admin/agents/approvals',
  'admin-agent-runs': '/admin/agents/runs',
  'admin-marketplace': '/admin/marketplace',
  'admin-users': '/admin/users',
  'admin-groups': '/admin/groups',
  'admin-group-edit': '/admin/groups/users',
  'admin-auth': '/admin/auth',
  'admin-oauth': '/admin/oauth',
  'admin-oauth-server': '/admin/oauth/server',
  'admin-mcp-servers': '/admin/mcp/servers',
  'admin-mcp-gateway': '/admin/mcp/gateway',
  'admin-credentials': '/admin/credentials',
  'admin-integrations': '/admin/integrations',
  'admin-integrations-jira': '/admin/integrations/jira',
  'admin-integrations-office365': '/admin/integrations/office365',
  'admin-office': '/admin/office-integration',
  'admin-browser-extension': '/admin/browser-extension',
  'admin-nextcloud-embed': '/admin/nextcloud-embed',
  'admin-ui': '/admin/ui',
  'admin-localization': '/admin/localization',
  'admin-pages': '/admin/pages',
  'admin-shortlinks': '/admin/shortlinks',
  'admin-usage': '/admin/usage',
  'admin-feedback': '/admin/feedback',
  'admin-logging': '/admin/logging',
  'admin-telemetry': '/admin/telemetry',
  'admin-chat-history': '/admin/chat-history',
  'admin-voice-input': '/admin/voice-input',
  'admin-audit-log': '/admin/audit-log',
  'admin-changelog': '/admin/changelog',
  'admin-features': '/admin/features',
  'admin-security': '/admin/security',
  'admin-backup': '/admin/backup',
  'admin-updates': '/admin/updates',
  'admin-advanced': '/admin/advanced',
  'page-faq': '/pages/faq'
};
for (const [name, path] of Object.entries(staticPages)) {
  if (!want(name) && !want('static')) continue;
  try {
    await go(path);
    await shot(name);
  } catch (e) {
    console.log('FAILED', name, e.message.split('\n')[0]);
  }
}

if (want('chat') || want('dynamic')) {
  try {
    await go('/apps/chat');
    await shot('chat-empty');
    await send('Give me a short overview of how I can use iHub Apps in my team.');
    await shot('chat-answer');
  } catch (e) {
    console.log('FAILED chat', e.message.split('\n')[0]);
  }
}
if (want('mermaid') || want('dynamic')) {
  try {
    await go('/apps/mermaid-diagrams');
    await send('Draw a flowchart of our purchase approval process from request to payment.');
    await shot('chat-mermaid', { wait: 1500 });
  } catch (e) {
    console.log('FAILED mermaid', e.message.split('\n')[0]);
  }
}
if (want('summarizer') || want('dynamic')) {
  try {
    await go('/apps/summarizer');
    await shot('app-summarizer-empty');
    await send(
      'Summarize: The 2026 digital workplace strategy focuses on secure AI adoption, knowledge management and process automation across HR, procurement and customer service.'
    );
    await shot('chat-summarizer');
  } catch (e) {
    console.log('FAILED summarizer', e.message.split('\n')[0]);
  }
}
if (want('research') || want('dynamic')) {
  try {
    await go('/apps/web-chat');
    await send(
      'Research the EU AI Act obligations for internal AI assistants and cite your sources.'
    );
    await shot('chat-research');
  } catch (e) {
    console.log('FAILED research', e.message.split('\n')[0]);
  }
}
if (want('workflow-editor') || want('dynamic')) {
  try {
    await go('/admin/workflows/research-assistant/edit', { wait: 1500 });
    await shot('workflow-editor', { wait: 1200 });
  } catch (e) {
    console.log('FAILED workflow-editor', e.message.split('\n')[0]);
  }
}
if (want('canvas') || want('dynamic')) {
  try {
    await go('/apps/chat/canvas', { wait: 1200 });
    await shot('canvas');
  } catch (e) {
    console.log('FAILED canvas', e.message.split('\n')[0]);
  }
}
if (want('mobile') || want('dynamic')) {
  try {
    const mctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      locale: 'en-US'
    });
    await mctx.addInitScript(() => {
      try {
        localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
        sessionStorage.setItem('setup_skipped', '1');
      } catch {}
    });
    const mp = await mctx.newPage();
    await mp.goto(BASE + '/login', { waitUntil: 'networkidle' });
    await mp.fill('input[name="username"]', 'admin');
    await mp.fill('input[name="password"]', 'password123');
    await mp.click('button[type="submit"]');
    await mp.waitForURL(u => !u.pathname.endsWith('/login'));
    await sleep(1000);
    await mp.screenshot({ path: `${OUT}/mobile-home.png` });
    await mp.goto(BASE + '/apps/chat', { waitUntil: 'networkidle' });
    const ta = mp.getByPlaceholder('Type your message here...').first();
    await ta.fill('Give me a short overview of iHub Apps.', { force: true });
    await ta.press('Enter');
    await sleep(4500);
    await mp.screenshot({ path: `${OUT}/mobile-chat.png` });
    console.log('shot mobile');
    await mctx.close();
  } catch (e) {
    console.log('FAILED mobile', e.message.split('\n')[0]);
  }
}

if (want('extras') || want('dynamic')) {
  // Model selector dropdown open
  try {
    await go('/apps/chat');
    await page.locator('button[aria-label="Select Model"]').first().click();
    await shot('chat-model-selector', { wait: 600 });
    await page.keyboard.press('Escape');
  } catch (e) {
    console.log('FAILED model-selector', e.message.split('\n')[0]);
  }
  // Email composer with variables
  try {
    await go('/apps/email-composer');
    await shot('app-email-composer-empty');
    await send(
      'Please write a follow-up email to Sarah about the Q4 roadmap review, summarising decisions and next steps.'
    );
    await shot('chat-email-composer');
  } catch (e) {
    console.log('FAILED email-composer', e.message.split('\n')[0]);
  }
  // Share modal
  try {
    await go('/apps/chat');
    await page.locator('button[aria-label="Share"]').first().click();
    await shot('chat-share-modal', { wait: 700 });
    await page.keyboard.press('Escape');
  } catch (e) {
    console.log('FAILED share', e.message.split('\n')[0]);
  }
  // Chats history after messages
  try {
    await go('/chats');
    await shot('chats-history');
  } catch (e) {
    console.log('FAILED chats', e.message.split('\n')[0]);
  }
  // Dark mode chat
  try {
    await page.evaluate(() => {
      localStorage.setItem('ih-dark-mode', 'dark');
      document.documentElement.classList.add('dark');
    });
    await go('/apps/chat');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await send('Give me a short overview of how I can use iHub Apps in my team.');
    await shot('chat-answer-dark');
    await page.evaluate(() => {
      localStorage.setItem('ih-dark-mode', 'light');
      document.documentElement.classList.remove('dark');
    });
  } catch (e) {
    console.log('FAILED dark', e.message.split('\n')[0]);
  }
  // Swagger API docs (served by the API server directly)
  try {
    await page.goto(API + '/api/docs', { waitUntil: 'networkidle' });
    await shot('api-docs', { wait: 1200 });
  } catch (e) {
    console.log('FAILED api-docs', e.message.split('\n')[0]);
  }
  // Admin: change history drawer + command palette
  try {
    await go('/admin/apps');
    await page.keyboard.press('Meta+K');
    await sleep(300);
    if ((await page.locator('input[placeholder*="Search"]').count()) === 0)
      await page.keyboard.press('Control+K');
    await shot('admin-command-palette', { wait: 600 });
    await page.keyboard.press('Escape');
  } catch (e) {
    console.log('FAILED palette', e.message.split('\n')[0]);
  }
}

if (want('round3')) {
  try {
    await go('/apps/chat');
    const sel = page
      .locator('button[title="Select Model"], button[aria-label="Select Model"]')
      .first();
    if (await sel.count()) {
      await sel.click();
    } else {
      await page.getByText('Gemini Flash (latest)').first().click();
    }
    await shot('chat-model-selector', { wait: 700 });
    await page.keyboard.press('Escape');
  } catch (e) {
    console.log('FAILED model-selector', e.message.split('\n')[0]);
  }
  try {
    await go('/apps/email-composer');
    await page.getByPlaceholder('Enter Recipient').fill('Sarah Miller, Head of Product');
    await page
      .getByPlaceholder('Enter Subject')
      .fill('Q4 roadmap review – decisions and next steps');
    await shot('app-email-composer-form');
    await send(
      "Follow up on yesterday's roadmap meeting: launch moved to 15 November, Marcus owns the legal review, pilot in Munich and Bonn."
    );
    await shot('chat-email-composer');
  } catch (e) {
    console.log('FAILED email-composer', e.message.split('\n')[0]);
  }
  try {
    await go('/apps/mermaid-diagrams');
    await shot('app-mermaid-empty');
    await send('Draw a flowchart of our purchase approval process from request to payment.', 5500);
    await shot('chat-mermaid', { wait: 1500 });
  } catch (e) {
    console.log('FAILED mermaid', e.message.split('\n')[0]);
  }
  try {
    await go('/apps/file-analysis');
    await shot('app-file-analysis-empty');
  } catch (e) {
    console.log('FAILED file-analysis', e.message.split('\n')[0]);
  }
  try {
    await go('/apps/image-generator');
    await shot('app-image-generator-empty');
  } catch (e) {
    console.log('FAILED image-gen', e.message.split('\n')[0]);
  }
  try {
    await go('/apps/nda-risk-analyzer');
    await shot('app-nda-empty');
  } catch (e) {
    console.log('FAILED nda', e.message.split('\n')[0]);
  }
  try {
    await go('/apps/chat');
    const cmp = page.locator('button[aria-label="Compare Mode"]').first();
    if (await cmp.count()) {
      await cmp.click();
      await sleep(800);
      await shot('chat-compare-empty');
      await send('Give me a short overview of how I can use iHub Apps in my team.', 6000);
      await shot('chat-compare');
    } else {
      console.log('compare toggle not present');
    }
  } catch (e) {
    console.log('FAILED compare', e.message.split('\n')[0]);
  }
  try {
    await go('/apps/chat/canvas', { wait: 2500 });
    await send('Write a short project status update for the analytics dashboard launch.', 6000);
    await shot('canvas', { wait: 1500 });
  } catch (e) {
    console.log('FAILED canvas', e.message.split('\n')[0]);
  }
  try {
    await go('/prompts');
    const first = page
      .locator('main button, main a')
      .filter({ hasText: /Summar|Translate|FAQ|App/ })
      .first();
    if (await first.count()) {
      await first.click();
      await shot('prompts-detail', { wait: 800 });
    }
  } catch (e) {
    console.log('FAILED prompts-detail', e.message.split('\n')[0]);
  }
}

if (want('round4')) {
  try {
    await go('/apps/chat');
    await page.locator('button:visible', { hasText: 'Gemini Flash (latest)' }).first().click();
    await shot('chat-model-selector', { wait: 700 });
    await page.keyboard.press('Escape');
  } catch (e) {
    console.log('FAILED model-selector', e.message.split('\n')[0]);
  }
  try {
    await go('/apps/email-composer');
    await page.getByPlaceholder('Enter Recipient').fill('Sarah Miller, Head of Product');
    await page
      .getByPlaceholder('Enter Subject')
      .fill('Q4 roadmap review – decisions and next steps');
    await send(
      "Follow up on yesterday's roadmap meeting: launch moved to 15 November, Marcus owns the legal review, pilot in Munich and Bonn."
    );
    await shot('chat-email-composer');
  } catch (e) {
    console.log('FAILED email-composer', e.message.split('\n')[0]);
  }
  try {
    await go('/apps/chat/canvas', { wait: 3000 });
    await send('Write a short project status update for the analytics dashboard launch.', 6000);
    await shot('canvas', { wait: 1500 });
  } catch (e) {
    console.log('FAILED canvas', e.message.split('\n')[0]);
  }
}

if (want('round5')) {
  try {
    await go('/apps/email-composer');
    await page.getByPlaceholder('Enter Recipient').fill('Sarah Miller, Head of Product');
    await page
      .getByPlaceholder('Enter Subject')
      .fill('Q4 roadmap review – decisions and next steps');
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('textarea[aria-label="Type your message"]')].find(
        e => e.offsetWidth > 0
      );
      if (el) {
        el.focus();
      }
    });
    await page.keyboard.insertText(
      "Follow up on yesterday's roadmap meeting: launch moved to 15 November, Marcus owns the legal review, pilot in Munich and Bonn."
    );
    await sleep(300);
    await page.locator('button[aria-label="Send"]:visible').first().click();
    await sleep(5000);
    await shot('chat-email-composer');
  } catch (e) {
    console.log('FAILED email-composer', e.message.split('\n')[0]);
  }
}

await browser.close();
