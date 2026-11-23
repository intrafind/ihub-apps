// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { chromium, expect, request as playwrightRequest, test } from '@playwright/test';
import {
  API_ORIGIN,
  BASE_URL,
  carries,
  chatTurn,
  createShare,
  publishHostileArtifact,
  recordBrowserRequests,
  recordForeignRequests,
  sendInUi,
  signedIn,
  signInPage,
  signInVictimPage,
  waitForSeededProjects
} from './helpers.mjs';
import { ADMIN, APPS, BOB } from './scenario.mjs';
import { HOSTILE_ARTIFACTS, PLANTED_PROMPT } from './hostileArtifacts.mjs';
import { EMBED_PARTNER_ORIGIN } from './seed.mjs';

/**
 * Prompt injection, compromised model: a hostile artifact, shared, opened by someone else.
 *
 * Bob, an ordinary user, chats with an app whose planted document makes the compromised
 * model publish a hostile artifact (`hostileArtifacts.mjs`): a page that tries to read the
 * viewer's credentials and send them away, and file names that try to break the download
 * header. Bob shares the chat and the artifact. The admin, a more privileged user whose
 * session cookie and `localStorage` token are both set, opens the links in a real browser.
 *
 * The assertions are on what the page could reach and what left the browser (every
 * request to another host, whether or not the interception dropped it), never on the
 * model's wording. `window.__probe` of the artifact says why: each attempt to read a
 * credential threw.
 *
 * What is pinned, and why it is enough:
 *
 * - A source file, HTML and SVG included, is served as `text/plain` (`artifactPolicy.js`),
 *   so opening its URL runs nothing on iHub's origin.
 * - An HTML artifact is previewed in `<iframe sandbox="allow-scripts">` with a CSP of
 *   `default-src 'none'`: an opaque origin, no storage, no cookies, no parent, and no
 *   request of any kind to another host.
 * - The one channel the CSP does not close is the frame navigating itself away
 *   (`location`, `<meta refresh>`, a clicked link): browsers do not implement
 *   `navigate-to`. It carries whatever the artifact itself holds, never a credential of
 *   iHub's; the last tests of this file pin both halves (see "known limitation").
 */

/** A request to any host but the attacker's (which `hits` and the CSP reports account for). */
const notAttacker = request => new URL(request.url).hostname !== 'canary.invalid';

const stealing = HOSTILE_ARTIFACTS.filter(artifact => artifact.stealing && !artifact.navigates);
const navigating = HOSTILE_ARTIFACTS.filter(artifact => artifact.navigates);
const htmlStealing = stealing.filter(artifact => artifact.id !== 'steal-svg');
/** The media types a browser shows without running anything. */
const INERT_MEDIA_TYPE = /^(text\/(plain|markdown|csv)|application\/json)\b/i;

/** `published.get(id)`: where bob's hostile artifact is and the links that share it. */
const published = new Map();
let bob;
let adminApi;

test.beforeAll(async () => {
  adminApi = await signedIn(ADMIN);
  await waitForSeededProjects(adminApi);
  bob = await signedIn(BOB);
  for (const hostile of HOSTILE_ARTIFACTS) {
    const { chatId, artifact } = await publishHostileArtifact(bob, hostile.id);
    const entry = { chatId, artifact };
    if (artifact) {
      entry.chatShare = await createShare(bob, chatId);
      entry.artifactShare = await createShare(bob, chatId, { artifactId: artifact.id });
    }
    published.set(hostile.id, entry);
  }
});

test.afterAll(async () => {
  await bob?.dispose();
  await adminApi?.dispose();
});

const entryOf = id => {
  const entry = published.get(id);
  expect(entry?.artifact, `the platform stored hostile artifact ${id}`).toBeTruthy();
  return entry;
};

/** What a viewer's page must never be able to do, from the artifact's own probe. */
function expectNothingReachable(probe, token) {
  expect(probe.origin, 'the preview is an opaque origin').toBe('null');
  for (const key of [
    'localStorage',
    'sessionStorage',
    'cookie',
    'parentLocalStorage',
    'parentCookie',
    'parentDocument',
    'topDocument'
  ]) {
    expect(probe[key], `${key} must be unreachable`).toBe('threw:SecurityError');
  }
  expect(probe.windowOpen, 'a sandbox without allow-popups opens no window').toBe('null');
  expect(probe.hasOpener).toBe('no');
  for (const key of ['apiAsViewer', 'apiWithBearer', 'sendFetch', 'sendFetchNoCors']) {
    expect(probe[key], `${key} must fail before any request`).toMatch(/^threw:/);
  }
  expect(carries(probe, token), 'the viewer token is somewhere in what the page saw').toBe(false);
  // Each channel to the attacker was refused by the page's own CSP, before the network.
  const refused = probe.violations.join('\n');
  for (const channel of [
    'steal-fetch',
    'steal-no-cors',
    'steal-image',
    'steal-sse',
    'steal-import.js'
  ]) {
    expect(refused, `the CSP report of ${channel}`).toContain(`https://canary.invalid/${channel}`);
  }
}

/** Open the first artifact of a shared page and hand back its preview frame. */
async function openPreview(page, shareId) {
  await page.goto(`/share/${shareId}`);
  await page.waitForLoadState('networkidle');
  const open = page.getByTestId('generated-file-open').filter({ visible: true }).first();
  if (await open.count()) await open.click();
  const iframe = page.locator('[data-testid="artifact-viewer"] iframe');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts', { timeout: 20_000 });
  return { iframe, frame: await (await iframe.elementHandle()).contentFrame() };
}

async function readProbe(frame) {
  await expect
    .poll(() => frame.evaluate(() => window.__done === true).catch(() => false), {
      message: 'the artifact finished its attempts',
      timeout: 20_000
    })
    .toBe(true);
  return frame.evaluate(() => window.__probe);
}

test('the hostile artifacts exist, so their absence below means something', async () => {
  for (const hostile of HOSTILE_ARTIFACTS) {
    const { artifact } = entryOf(hostile.id);
    // Whatever the name was made into, it is stored as text and served as such.
    expect(artifact.mimeType, `${hostile.id}: media type it is stored under`).toMatch(
      INERT_MEDIA_TYPE
    );
  }
});

test.describe('opened in the app by the admin it was shared with', () => {
  let page;
  let token;
  let hits;
  let foreign;
  let turns;

  test.beforeEach(async ({ page: fresh }) => {
    page = fresh;
    token = await signInVictimPage(page, ADMIN);
    hits = await recordBrowserRequests(page);
    foreign = recordForeignRequests(page);
    turns = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/apps\/[^/]+\/chat\//.test(request.url())) {
        turns.push(request.url());
      }
    });
  });

  for (const hostile of htmlStealing) {
    for (const [via, pick] of [
      ['a shared chat', entry => entry.chatShare],
      ['a shared artifact', entry => entry.artifactShare]
    ]) {
      test(`${hostile.id} in ${via} runs sandboxed, reads nothing and sends nothing`, async () => {
        const entry = entryOf(hostile.id);
        const { iframe, frame } = await openPreview(page, pick(entry).id);
        const probe = await readProbe(frame);
        await page.waitForTimeout(1_000);

        expectNothingReachable(probe, token);
        expect(hits, 'requests the artifact made the browser send to the attacker').toEqual([]);
        expect(foreign.filter(notAttacker), 'requests to a host that is not the attacker').toEqual(
          []
        );
        expect(turns, 'a chat turn the artifact started').toEqual([]);
        expect(carries(await iframe.getAttribute('srcdoc'), token)).toBe(false);
        // Not navigated away: the artifact's attempt on the top page is refused too.
        expect(new URL(page.url()).pathname).toBe(`/share/${pick(entry).id}`);
      });
    }
  }

  test('an SVG artifact is drawn as an image: its script never runs and nothing is loaded', async () => {
    const entry = entryOf('steal-svg');
    await page.goto(`/share/${entry.chatShare.id}`);
    await page.waitForLoadState('networkidle');
    await page.getByTestId('generated-file-open').filter({ visible: true }).first().click();
    const viewer = page.getByTestId('artifact-viewer');
    await expect(viewer.locator('img')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2_000);

    await expect(viewer.locator('iframe')).toHaveCount(0);
    expect(await page.evaluate(() => window.__svgOnload ?? null)).toBeNull();
    expect(hits, 'requests the SVG made the browser send to the attacker').toEqual([]);
    expect(foreign.filter(notAttacker)).toEqual([]);
  });

  test('a prompt the artifact posts to its host is not sent from a shared link', async () => {
    const entry = entryOf('steal-html');
    const { frame } = await openPreview(page, entry.chatShare.id);
    expect((await readProbe(frame)).askHostToSend).toBe('posted');
    await page.waitForTimeout(1_000);

    await expect(page.getByText(PLANTED_PROMPT)).toHaveCount(0);
    expect(turns, 'a chat turn the artifact started').toEqual([]);
  });

  // KNOWN LIMITATION. A frame can navigate itself: `location`, `<meta http-equiv=refresh>`
  // or a clicked link leave the preview for any URL, and the preview's CSP cannot stop it
  // (`navigate-to` is not implemented by browsers). What leaves is what the artifact
  // itself holds, for example what a viewer types into a fake form in it; every
  // credential of iHub's is behind the opaque origin. If a mitigation closes this, the
  // `toBeGreaterThan(0)` below fails: flip it to `toEqual([])`, and drop this comment.
  for (const hostile of navigating) {
    test(`known limitation: ${hostile.id} can only navigate its own frame away, with no credential`, async () => {
      const entry = entryOf(hostile.id);
      await openPreview(page, entry.chatShare.id);
      await expect
        .poll(() => hits.length, { message: 'the frame navigated away', timeout: 15_000 })
        .toBeGreaterThan(0);

      expect(hits.every(url => /\/steal-(navigate|meta-refresh|link-click)\b/.test(url))).toBe(
        true
      );
      expect(carries(hits, token), 'the viewer token is in what left').toBe(false);
      expect(foreign.filter(notAttacker), 'any other request to a host but iHub').toEqual([]);
      if (hostile.stealing) {
        // What it carried: its probe, in which every credential read had failed.
        const sent = new URL(hits[0]).searchParams.get('d');
        const probe = JSON.parse(sent);
        for (const key of ['localStorage', 'sessionStorage', 'cookie', 'parentLocalStorage']) {
          expect(probe[key], key).toBe('threw:SecurityError');
        }
      }
      // The top page stayed where it was: only the preview frame moved.
      expect(new URL(page.url()).pathname).toBe(`/share/${entry.chatShare.id}`);
    });
  }
});

test.describe('opened by its URL', () => {
  for (const hostile of HOSTILE_ARTIFACTS) {
    test(`${hostile.id} is served as inert text, inline and as a download`, async ({ page }) => {
      const { chatShare, artifact } = entryOf(hostile.id);
      const token = await signInVictimPage(page, ADMIN);
      const hits = await recordBrowserRequests(page);
      const foreign = recordForeignRequests(page);
      const path = `/api/shares/${chatShare.id}/artifacts/${artifact.id}`;

      for (const [how, query] of [
        ['inline', ''],
        ['download', '?download=1']
      ]) {
        const res = await adminApi.get(`${path}${query}`);
        expect(res.status(), `${how}: ${await res.text().then(text => text.slice(0, 80))}`).toBe(
          200
        );
        const headers = res.headers();
        expect(headers['content-type'], `${how}: media type`).toMatch(INERT_MEDIA_TYPE);
        expect(headers['x-content-type-options'], `${how}: nosniff`).toBe('nosniff');
        expect(
          headers['set-cookie'],
          `${how}: a cookie the name made the server set`
        ).toBeUndefined();
        expect(Object.keys(headers).filter(name => /injected/i.test(name))).toEqual([]);
        if (query) {
          expect(headers['content-disposition'], 'download header').toMatch(
            /^attachment; filename="[^"\r\n\\]*"; filename\*=UTF-8''[^\s\r\n"]*$/
          );
        } else {
          expect(headers['content-disposition']).toBe('inline');
        }
      }

      // In a browser that is signed in as the admin, with the token in localStorage too.
      const response = await page.goto(`${API_ORIGIN}${path}`);
      expect(response.status()).toBe(200);
      await page.waitForTimeout(1_000);
      const state = await page.evaluate(() => ({
        contentType: document.contentType,
        ran: Boolean(window.__probe || window.__svgOnload)
      }));
      expect(state.contentType).toBe('text/plain');
      expect(state.ran, 'a script of the artifact ran on iHub’s origin').toBe(false);
      expect(hits, 'requests the page made to the attacker').toEqual([]);
      expect(foreign).toEqual([]);
      expect((await page.context().cookies()).map(cookie => cookie.name)).not.toContain('injected');
      expect(carries(await page.content(), token)).toBe(false);
    });
  }
});

test.describe('embedded in another site', () => {
  const embeds = new Map();

  test.beforeAll(async () => {
    for (const hostile of [byIdOrFail('steal-html'), byIdOrFail('steal-svg')]) {
      const { chatId, artifact } = entryOf(hostile.id);
      embeds.set(
        hostile.id,
        await createShare(bob, chatId, {
          artifactId: artifact.id,
          mode: 'public',
          embeddable: true
        })
      );
    }
  });

  function byIdOrFail(id) {
    const found = HOSTILE_ARTIFACTS.find(artifact => artifact.id === id);
    if (!found) throw new Error(`no hostile artifact ${id}`);
    return found;
  }

  for (const id of ['steal-html', 'steal-svg']) {
    test(`the embed page of ${id} shows it in a sandbox that reaches nothing`, async ({ page }) => {
      const share = embeds.get(id);
      const token = await signInVictimPage(page, ADMIN);
      const hits = await recordBrowserRequests(page);
      const foreign = recordForeignRequests(page);

      const response = await page.goto(`${API_ORIGIN}/share/${share.id}/embed`);
      expect(response.status()).toBe(200);
      const headers = response.headers();
      const csp = headers['content-security-policy'] || '';
      const ancestors = /frame-ancestors([^;]*)/.exec(csp)?.[1].trim().split(/\s+/);
      expect(
        ancestors,
        'frame-ancestors names iHub itself and the one partner, nothing else'
      ).toEqual(["'self'", EMBED_PARTNER_ORIGIN]);
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('no-referrer');

      const iframe = page.locator('iframe');
      await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
      const frame = await (await iframe.elementHandle()).contentFrame();
      if (id === 'steal-html') {
        expectNothingReachable(await readProbe(frame), token);
      }
      await page.waitForTimeout(1_500);
      expect(hits, 'requests the embedded artifact made to the attacker').toEqual([]);
      expect(foreign.filter(notAttacker), 'requests to a host that is not the attacker').toEqual(
        []
      );
      expect(new URL(page.url()).pathname).toBe(`/share/${share.id}/embed`);
    });
  }

  test('only the partner site may frame the embed page', async () => {
    const share = embeds.get('steal-html');
    const embedUrl = `${API_ORIGIN}/share/${share.id}/embed`;
    // Chrome refuses a public page (the partner's) a frame on a loopback address, which is
    // where this suite's server is; without the flag the positive control below could not
    // pass. A browser of its own, so the flag stays out of every other test.
    const browser = await chromium.launch({
      ...(process.env.PW_CHROMIUM_PATH && { executablePath: process.env.PW_CHROMIUM_PATH }),
      args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks']
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      for (const origin of [EMBED_PARTNER_ORIGIN, 'https://evil.example']) {
        await context.route(`${origin}/`, route =>
          route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><iframe id="f" src="${embedUrl}" width="400" height="300"></iframe>`
          })
        );
      }
      const embedded = async origin => {
        await page.goto(`${origin}/`);
        await page.waitForTimeout(2_000);
        return page.frames().find(frame => frame.url().startsWith(`${API_ORIGIN}/share/`));
      };

      // The positive control: the allowed site does get the page, so the refusal below means something.
      expect(
        await embedded(EMBED_PARTNER_ORIGIN),
        'the partner site frames the embed page'
      ).toBeTruthy();
      expect(
        await embedded('https://evil.example'),
        'another site frames the embed page'
      ).toBeFalsy();
    } finally {
      await browser.close();
    }
  });

  test('a link that is not public and embeddable is not an embed page, and frames nothing', async () => {
    const api = await playwrightRequest.newContext({ baseURL: API_ORIGIN });
    try {
      for (const [what, share] of [
        ['an authenticated artifact share', entryOf('steal-html').artifactShare],
        ['a shared chat', entryOf('steal-html').chatShare]
      ]) {
        const res = await api.get(`/share/${share.id}/embed`);
        expect(res.status(), what).toBe(404);
        expect(res.headers()['content-security-policy'] || '', what).not.toContain(
          EMBED_PARTNER_ORIGIN
        );
        expect(await res.text(), what).not.toContain('<iframe');
      }
    } finally {
      await api.dispose();
    }
  });
});

test.describe('in the owner’s own chat', () => {
  test('a prompt the artifact posts is shown for confirmation and nothing is sent unasked', async ({
    page
  }) => {
    await signInPage(page, BOB);
    const turns = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/apps\/[^/]+\/chat\//.test(request.url())) {
        turns.push(request.url());
      }
    });
    await sendInUi(page, APPS.artifactLab, 'Publish the vendor file [inj-artifact-steal-html]');
    await page
      .getByTestId('generated-file-open')
      .filter({ visible: true })
      .first()
      .click({ timeout: 30_000 });
    // The artifact asks; the person decides.
    await expect(page.getByText(PLANTED_PROMPT)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(3_000);
    expect(turns, 'only the turn the person sent, not the one the artifact asked for').toHaveLength(
      1
    );
  });
});

test.describe('a whole shared chat', () => {
  test('the answer’s active HTML makes the viewer’s browser load nothing', async ({ page }) => {
    const turn = await chatTurn(
      bob,
      APPS.kb,
      'Summarise the Northwind onboarding [inj-render-blocked]'
    );
    expect(turn.status).toBe(200);
    const share = await createShare(bob, turn.chatId);

    const token = await signInVictimPage(page, ADMIN);
    const hits = await recordBrowserRequests(page);
    const foreign = recordForeignRequests(page);
    await page.goto(`${BASE_URL}/share/${share.id}`);
    await expect(page.getByText('End of summary.')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2_000);

    expect(hits, 'requests the shared answer made the browser send to the attacker').toEqual([]);
    expect(foreign, 'requests to any host but iHub').toEqual([]);
    const column = page.getByTestId('workspace-chat-column');
    const kept = await column.evaluate(root =>
      [
        ...root.querySelectorAll(
          'iframe[src], object, embed, script, link, meta, base, form, style, video, audio, source, picture'
        )
      ]
        .filter(element => !element.closest('[data-testid="artifact-viewer"]'))
        .map(element => element.outerHTML.slice(0, 120))
    );
    expect(kept, 'active elements the shared answer kept').toEqual([]);
    expect(carries(hits, token)).toBe(false);
  });
});
