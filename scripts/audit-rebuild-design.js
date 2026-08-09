'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');
const playwrightVersion = require('playwright-core/package.json').version;

const root = path.resolve(__dirname, '..');
const evidenceDir = path.join(root, 'artifacts', 'rebuild', 'design-evidence');
const pages = [
  { slug: 'overview', file: 'prototypes/rebuild/overview.html', scoped: true },
  { slug: 'blueprint', file: 'prototypes/rebuild/blueprint.html', scoped: true },
  { slug: 'coverage', file: 'prototypes/rebuild/coverage.html', scoped: true },
  { slug: 'operation', file: 'prototypes/rebuild/operation.html', scoped: true },
  { slug: 'records', file: 'prototypes/rebuild/records.html', scoped: true },
  { slug: 'close', file: 'prototypes/rebuild/close.html', scoped: true },
  { slug: 'design-guide', file: 'DESIGN.HTML', scoped: false }
];
const viewports = [
  { name: 'desktop-1440', width: 1440, height: 1000, minTarget: 24, capture: true },
  { name: 'laptop-1280', width: 1280, height: 720, minTarget: 24 },
  { name: 'tablet-768', width: 768, height: 1024, minTarget: 24 },
  { name: 'mobile-390', width: 390, height: 844, minTarget: 44, capture: true, menuTest: true },
  { name: 'mobile-320', width: 320, height: 800, minTarget: 44, menuTest: true }
];
const themes = ['light', 'dark'];
const sourceFiles = [
  'DESIGN.HTML',
  'frontend/src/styles/rebuild-tokens.css',
  'prototypes/rebuild/prototype.css',
  'prototypes/rebuild/prototype.js',
  ...pages.filter((page) => page.slug !== 'design-guide').map((page) => page.file),
  'scripts/audit-rebuild-design.js'
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  }[extension] || 'application/octet-stream';
}

function startFixtureServer() {
  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'prototypes/rebuild/index.html';
      const absolute = path.resolve(root, relative);
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': contentType(absolute),
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'"
      });
      fs.createReadStream(absolute).pipe(response);
    } catch (error) {
      response.writeHead(500).end('Fixture server error');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error('Chrome was not found. Set CHROME_PATH to a compatible local Chrome executable.');
  return executable;
}

function screenshotName(slug, theme, viewport) {
  const dimensions = `${viewport.width}x${viewport.height}`;
  return theme === 'light' ? `${slug}-${dimensions}.png` : `${slug}-dark-${dimensions}.png`;
}

async function inspectPage(page, { minTarget, scoped, theme }) {
  return page.evaluate(({ targetMinimum, shouldHaveScope, expectedTheme }) => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const hasLabel = (element) => Boolean((element.labels && element.labels.length) || element.closest('label'));
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    const controls = [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"]')].filter(visible);
    const unnamedControls = controls.filter((element) => !(
      element.getAttribute('aria-label') ||
      element.getAttribute('aria-labelledby') ||
      element.getAttribute('title') ||
      hasLabel(element) ||
      (element.innerText || element.value || element.getAttribute('alt') || '').trim()
    )).map((element) => element.outerHTML.slice(0, 180));
    const unlabelledInputs = [...document.querySelectorAll('input,select,textarea')]
      .filter(visible)
      .filter((element) => !(element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || hasLabel(element)))
      .map((element) => element.outerHTML.slice(0, 180));
    const smallTargets = controls.filter((element) => {
      const rect = element.getBoundingClientRect();
      return !element.disabled && (rect.width < targetMinimum || rect.height < targetMinimum);
    }).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        name: (element.innerText || element.getAttribute('aria-label') || element.value || element.tagName).trim().slice(0, 80),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    });
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible).map((element) => Number(element.tagName.slice(1)));
    const headingJumps = headings.slice(1).map((level, index) => ({ from: headings[index], to: level })).filter(({ from, to }) => to > from + 1);
    const skip = document.querySelector('a[href^="#"]');
    const skipTarget = skip ? document.querySelector(skip.getAttribute('href')) : null;
    const activeWork = document.querySelector('.scope-item.active-work');
    const role = document.querySelector('.scope-item.role');
    const scope = shouldHaveScope ? {
      activeWorkVisible: visible(activeWork),
      activeWorkLabel: activeWork?.querySelector('.scope-label')?.textContent.trim() || null,
      roleVisible: visible(role),
      roleLabel: role?.querySelector('.scope-label')?.textContent.trim() || null
    } : null;
    return {
      title: document.title,
      lang: document.documentElement.lang,
      theme: document.documentElement.dataset.tdlTheme || 'light',
      expectedTheme,
      innerWidth,
      innerHeight,
      mainCount: document.querySelectorAll('main').length,
      h1Count: document.querySelectorAll('h1').length,
      duplicateIds,
      unnamedControls,
      unlabelledInputs,
      smallTargets,
      headingJumps,
      skipLink: skip ? { text: (skip.innerText || '').trim(), href: skip.getAttribute('href'), targetExists: Boolean(skipTarget) } : null,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      scope
    };
  }, { targetMinimum: minTarget, shouldHaveScope: scoped, expectedTheme: theme });
}

async function inspectDisabledContrast(page) {
  return page.locator('button:disabled').evaluateAll((buttons) => {
    const parse = (value) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const luminance = (value) => {
      const channels = parse(value).map((channel) => channel / 255).map((channel) => (
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      ));
      return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
    };
    const ratio = (foreground, background) => {
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    return buttons.map((button) => {
      const style = getComputedStyle(button);
      let effectiveOpacity = Number(style.opacity);
      for (let parent = button.parentElement; parent; parent = parent.parentElement) effectiveOpacity *= Number(getComputedStyle(parent).opacity);
      return {
        name: (button.innerText || button.getAttribute('aria-label') || 'disabled button').trim(),
        foreground: style.color,
        background: style.backgroundColor,
        effectiveOpacity,
        ratio: ratio(style.color, style.backgroundColor)
      };
    });
  });
}

function failuresFor(check) {
  const failures = [];
  if (!check.lang) failures.push('missing document language');
  if (check.innerWidth !== check.expected.width || check.innerHeight !== check.expected.height) failures.push('unexpected viewport');
  if (check.theme !== check.expectedTheme) failures.push('requested theme not applied');
  if (check.mainCount !== 1) failures.push(`main landmark count ${check.mainCount}`);
  if (check.h1Count !== 1) failures.push(`h1 count ${check.h1Count}`);
  if (check.duplicateIds.length) failures.push('duplicate ids');
  if (check.unnamedControls.length) failures.push('unnamed controls');
  if (check.unlabelledInputs.length) failures.push('unlabelled inputs');
  if (check.smallTargets.length) failures.push('undersized targets');
  if (check.headingJumps.length) failures.push('heading jumps');
  if (!check.skipLink || !check.skipLink.targetExists) failures.push('invalid skip link');
  if (!check.firstTab?.isSkipLink || !check.firstTab?.visible) failures.push('first Tab does not reveal the skip link');
  if (check.horizontalOverflow) failures.push('page horizontal overflow');
  if (check.scope && (!check.scope.activeWorkVisible || check.scope.activeWorkLabel !== 'Active work' || !check.scope.roleVisible || check.scope.roleLabel !== 'Role')) failures.push('required scope facts are hidden or mislabelled');
  if (check.externalRequests.length) failures.push('external request attempted');
  if (check.consoleErrors.length) failures.push('browser console error');
  if (check.pageErrors.length) failures.push('uncaught page error');
  if (check.disabledContrast.some((item) => item.effectiveOpacity !== 1 || item.ratio < 4.5)) failures.push('disabled control contrast below 4.5:1 or inherited opacity');
  if (check.menu && (!check.menu.opened || !check.menu.focusMovedIntoNavigation || !check.menu.closedWithEscape || !check.menu.focusReturned)) failures.push('mobile navigation interaction failed');
  return failures;
}

async function main() {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const server = await startFixtureServer();
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  let browser;
  const checks = [];
  const failures = [];
  const captured = [];
  try {
    browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true });
    for (const theme of themes) {
      for (const viewport of viewports) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: theme });
        const externalRequests = [];
        await context.route('**/*', async (route) => {
          const requestUrl = route.request().url();
          if (new URL(requestUrl).origin !== origin) {
            externalRequests.push(requestUrl);
            await route.abort();
          } else {
            await route.continue();
          }
        });
        const page = await context.newPage();
        for (const descriptor of pages) {
          const consoleErrors = [];
          const pageErrors = [];
          const onConsole = (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); };
          const onPageError = (error) => pageErrors.push(error.message);
          page.on('console', onConsole);
          page.on('pageerror', onPageError);
          const externalStart = externalRequests.length;
          const url = `${origin}/${descriptor.file}?theme=${theme}&audit=1`;
          await page.goto(url, { waitUntil: 'networkidle' });
          const detail = await inspectPage(page, { minTarget: viewport.minTarget, scoped: descriptor.scoped, theme });
          const disabledContrast = await inspectDisabledContrast(page);
          await page.keyboard.press('Tab');
          const firstTab = await page.evaluate(() => {
            const active = document.activeElement;
            const style = active ? getComputedStyle(active) : null;
            const rect = active ? active.getBoundingClientRect() : null;
            return {
              isSkipLink: Boolean(active?.classList.contains('skip')),
              visible: Boolean(style && rect && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0),
              outline: style?.outlineStyle || null,
              boxShadow: style?.boxShadow || null
            };
          });
          let menu = null;
          if (viewport.menuTest && descriptor.scoped) {
            const menuButton = page.locator('.menu-btn');
            await menuButton.click();
            await page.waitForTimeout(30);
            const opened = await menuButton.getAttribute('aria-expanded') === 'true';
            const focusMovedIntoNavigation = await page.evaluate(() => Boolean(document.activeElement?.closest('.rail')));
            await page.keyboard.press('Escape');
            const closedWithEscape = await menuButton.getAttribute('aria-expanded') === 'false';
            const focusReturned = await page.evaluate(() => document.activeElement?.classList.contains('menu-btn'));
            menu = { opened, focusMovedIntoNavigation, closedWithEscape, focusReturned };
          }
          if (viewport.capture) {
            const file = screenshotName(descriptor.slug, theme, viewport);
            await page.screenshot({ path: path.join(evidenceDir, file), fullPage: false });
            captured.push(file);
          }
          const check = {
            page: descriptor.slug,
            viewport: viewport.name,
            expected: { width: viewport.width, height: viewport.height },
            minTarget: viewport.minTarget,
            ...detail,
            firstTab,
            disabledContrast,
            menu,
            externalRequests: externalRequests.slice(externalStart),
            consoleErrors,
            pageErrors
          };
          checks.push(check);
          failures.push(...failuresFor(check).map((problem) => ({ page: descriptor.slug, theme, viewport: viewport.name, problem })));
          page.off('console', onConsole);
          page.off('pageerror', onPageError);
        }
        await context.close();
      }
    }
    const sourceHashes = Object.fromEntries(sourceFiles.sort().map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))]));
    const screenshotHashes = Object.fromEntries([...new Set(captured)].sort().map((file) => [file, sha256(fs.readFileSync(path.join(evidenceDir, file)))]));
    const sourceTreeHash = sha256(Object.entries(sourceHashes).map(([file, hash]) => `${file}:${hash}`).join('\n'));
    const payload = {
      schemaVersion: '2.0.0',
      generatedAt: new Date().toISOString(),
      command: 'npm run verify:design:browser',
      scope: 'Fixture-only deterministic browser audit; not NVDA, forced-colours, or live React acceptance.',
      environment: {
        node: process.version,
        playwrightCore: playwrightVersion,
        browser: browser.version(),
        platform: `${process.platform}-${process.arch}`,
        gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        sourceTreeHash
      },
      sourceHashes,
      screenshotHashes,
      pages: pages.map(({ slug }) => slug),
      themes,
      viewports: viewports.map(({ name, width, height, minTarget }) => ({ name, width, height, minTarget })),
      assertions: [
        'one language, main landmark, and h1',
        'unique ids and sequential headings',
        'named controls and labelled form fields',
        '24px desktop/tablet and 44px narrow target size',
        'first Tab reveals visible skip link',
        'no page horizontal overflow',
        'role and active-work scope visible at every workflow viewport',
        'narrow menu opens, moves focus, closes with Escape, and restores focus',
        'disabled controls use effective opacity 1 and at least 4.5:1 contrast',
        'requested light/dark theme applied',
        'no external request, console error, or page error'
      ],
      result: failures.length ? 'fail' : 'pass',
      checks,
      failures
    };
    fs.writeFileSync(path.join(evidenceDir, 'browser-review.json'), `${JSON.stringify(payload, null, 2)}\n`);
    if (failures.length) throw new Error(`Rebuild browser audit failed (${failures.length}); inspect browser-review.json.`);
    console.log(`Rebuild browser audit passed: ${checks.length} page/theme/viewport checks and ${Object.keys(screenshotHashes).length} exact-viewport screenshots.`);
    console.log(`Source tree SHA-256: ${sourceTreeHash}`);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
