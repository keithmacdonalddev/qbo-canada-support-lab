'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const failures = [];
const requiredFiles = [
  'DESIGN.md',
  'DESIGN.HTML',
  'frontend/src/styles/rebuild-tokens.css',
  'docs/design/research-decision-record.md',
  'docs/design/component-state-matrix.md',
  'docs/design/prototype-screen-briefs.md',
  'docs/design/rendered-review.md',
  'artifacts/rebuild/design-evidence/browser-review.json',
  'scripts/audit-rebuild-design.js',
  'prototypes/rebuild/index.html',
  'prototypes/rebuild/prototype.css',
  'prototypes/rebuild/prototype.js',
  'prototypes/rebuild/overview.html',
  'prototypes/rebuild/blueprint.html',
  'prototypes/rebuild/coverage.html',
  'prototypes/rebuild/operation.html',
  'prototypes/rebuild/records.html',
  'prototypes/rebuild/close.html'
];
const renderedNames = ['overview', 'blueprint', 'coverage', 'operation', 'records', 'close', 'design-guide'];
const expectedSourceHashFiles = [
  'DESIGN.HTML',
  'frontend/src/styles/rebuild-tokens.css',
  'prototypes/rebuild/prototype.css',
  'prototypes/rebuild/prototype.js',
  'prototypes/rebuild/overview.html',
  'prototypes/rebuild/blueprint.html',
  'prototypes/rebuild/coverage.html',
  'prototypes/rebuild/operation.html',
  'prototypes/rebuild/records.html',
  'prototypes/rebuild/close.html',
  'scripts/audit-rebuild-design.js'
].sort();
const renderedFiles = ['light', 'dark'].flatMap((theme) => [
  ...renderedNames.map((name) => ({
    file: `artifacts/rebuild/design-evidence/${name}${theme === 'dark' ? '-dark' : ''}-1440x1000.png`,
    width: 1440,
    height: 1000
  })),
  ...renderedNames.map((name) => ({
    file: `artifacts/rebuild/design-evidence/${name}${theme === 'dark' ? '-dark' : ''}-390x844.png`,
    width: 390,
    height: 844
  }))
]);
requiredFiles.push(...renderedFiles.map(({ file }) => file));
const workflowFiles = requiredFiles.filter((file) => /^prototypes\/rebuild\/(overview|blueprint|coverage|operation|records|close)\.html$/.test(file));

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) {
    failures.push(`${relativePath}: required file is missing`);
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function requirePattern(content, pattern, message) {
  if (!pattern.test(content)) failures.push(message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

requiredFiles.forEach(read);

const designMarkdown = read('DESIGN.md');
for (const heading of ['Product design contract', 'Semantic tokens', 'Component contracts', 'Accessibility contract', 'Critical workflow briefs', 'Migration map', 'Governance and evidence']) {
  requirePattern(designMarkdown, new RegExp(`^## .*${heading}`, 'm'), `DESIGN.md: missing ${heading} section`);
}
for (const state of ['Manual only', 'Unknown', 'Stale', 'QBO upstream error', 'Completed with exceptions']) {
  if (!designMarkdown.includes(state)) failures.push(`DESIGN.md: missing required state ${state}`);
}

const visualGuide = read('DESIGN.HTML');
requirePattern(visualGuide, /<main\b[^>]*id="content"/i, 'DESIGN.HTML: missing main content landmark');
requirePattern(visualGuide, /href="#content"/i, 'DESIGN.HTML: missing skip link');
requirePattern(visualGuide, /prefers-reduced-motion:\s*reduce/i, 'DESIGN.HTML: missing reduced-motion handling');
requirePattern(visualGuide, /data-tdl-theme="dark"/i, 'DESIGN.HTML: missing dark-theme contract');

const tokenCss = read('frontend/src/styles/rebuild-tokens.css');
for (const token of ['--tdl-canvas', '--tdl-text-primary', '--tdl-accent', '--tdl-danger', '--tdl-production', '--tdl-control-touch', '--tdl-duration-navigation']) {
  if (!tokenCss.includes(token)) failures.push(`rebuild-tokens.css: missing ${token}`);
}
requirePattern(tokenCss, /prefers-reduced-motion:\s*reduce/i, 'rebuild-tokens.css: missing reduced-motion handling');

const prototypeCss = read('prototypes/rebuild/prototype.css');
requirePattern(prototypeCss, /@media\(max-width:760px\)/, 'prototype.css: missing narrow layout breakpoint');
requirePattern(prototypeCss, /@media\(max-width:390px\)/, 'prototype.css: missing 390px layout refinement');
requirePattern(prototypeCss, /prefers-reduced-motion:\s*reduce/, 'prototype.css: missing reduced-motion handling');
requirePattern(prototypeCss, /forced-colors:\s*active/, 'prototype.css: missing forced-colour handling');
requirePattern(prototypeCss, /min-height:44px/, 'prototype.css: missing narrow/coarse 44px control target');
requirePattern(prototypeCss, /\.btn:disabled\{[^}]*opacity:1[^}]*--disabled/s, 'prototype.css: disabled controls must use explicit contrast tokens without parent opacity');
requirePattern(prototypeCss, /\.rail\.is-open/, 'prototype.css: missing narrow navigation open state');

const prototypeScript = read('prototypes/rebuild/prototype.js');
requirePattern(prototypeScript, /aria-expanded/, 'prototype.js: mobile navigation must expose expanded state');
requirePattern(prototypeScript, /event\.key === 'Escape'/, 'prototype.js: mobile navigation must close with Escape');
requirePattern(prototypeScript, /rail\.inert/, 'prototype.js: hidden narrow navigation must leave the tab order');

for (const { file, width, height } of renderedFiles) {
  const image = fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file)) : Buffer.alloc(0);
  const isPng = image.length >= 45 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!isPng) {
    failures.push(`${file}: missing or invalid PNG`);
    continue;
  }
  const actualWidth = image.readUInt32BE(16);
  const actualHeight = image.readUInt32BE(20);
  if (actualWidth !== width || actualHeight !== height) {
    failures.push(`${file}: expected ${width}x${height}, found ${actualWidth}x${actualHeight}`);
  }
  if (!image.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) {
    failures.push(`${file}: PNG stream does not end with a valid IEND chunk`);
  }
}

try {
  const browserReview = JSON.parse(read('artifacts/rebuild/design-evidence/browser-review.json'));
  if (browserReview.result !== 'pass') failures.push('browser-review.json: result must be pass');
  if (browserReview.command !== 'npm run verify:design:browser') failures.push('browser-review.json: missing reproducible command');
  if (!Array.isArray(browserReview.checks) || browserReview.checks.length !== 70) failures.push('browser-review.json: expected 70 light/dark responsive checks');
  if (!Array.isArray(browserReview.failures) || browserReview.failures.length !== 0) failures.push('browser-review.json: failures must be empty');
  if (!browserReview.environment?.node || !browserReview.environment?.playwrightCore || !browserReview.environment?.browser) failures.push('browser-review.json: missing browser environment versions');

  const expectedCombinations = new Set();
  for (const name of renderedNames) {
    for (const theme of ['light', 'dark']) {
      for (const viewport of ['desktop-1440', 'laptop-1280', 'tablet-768', 'mobile-390', 'mobile-320']) {
        expectedCombinations.add(`${name}|${theme}|${viewport}`);
      }
    }
  }
  for (const check of browserReview.checks || []) {
    const key = `${check.page}|${check.expectedTheme}|${check.viewport}`;
    if (!expectedCombinations.delete(key)) failures.push(`browser-review.json: unexpected or duplicate check ${key}`);
    if (check.innerWidth !== check.expected?.width || check.innerHeight !== check.expected?.height) failures.push(`browser-review.json: wrong viewport for ${key}`);
    if (check.theme !== check.expectedTheme) failures.push(`browser-review.json: wrong theme for ${key}`);
    if (check.mainCount !== 1 || check.h1Count !== 1) failures.push(`browser-review.json: landmark/heading failure for ${key}`);
    if (check.duplicateIds?.length || check.unnamedControls?.length || check.unlabelledInputs?.length || check.smallTargets?.length || check.headingJumps?.length) failures.push(`browser-review.json: structural failure for ${key}`);
    if (!check.skipLink?.targetExists || !check.firstTab?.isSkipLink || !check.firstTab?.visible) failures.push(`browser-review.json: skip-link failure for ${key}`);
    if (check.horizontalOverflow || check.externalRequests?.length || check.consoleErrors?.length || check.pageErrors?.length) failures.push(`browser-review.json: overflow/network/runtime failure for ${key}`);
    if (check.scope && (!check.scope.activeWorkVisible || check.scope.activeWorkLabel !== 'Active work' || !check.scope.roleVisible || check.scope.roleLabel !== 'Role')) failures.push(`browser-review.json: hidden or mislabelled scope fact for ${key}`);
    if (check.disabledContrast?.some((item) => item.effectiveOpacity !== 1 || item.ratio < 4.5)) failures.push(`browser-review.json: disabled contrast failure for ${key}`);
    if (check.menu && (!check.menu.opened || !check.menu.focusMovedIntoNavigation || !check.menu.closedWithEscape || !check.menu.focusReturned)) failures.push(`browser-review.json: mobile menu failure for ${key}`);
  }
  if (expectedCombinations.size) failures.push(`browser-review.json: missing ${expectedCombinations.size} page/theme/viewport checks`);

  const sourceHashEntries = Object.entries(browserReview.sourceHashes || {}).sort(([left], [right]) => left.localeCompare(right));
  const recordedSourceFiles = sourceHashEntries.map(([file]) => file);
  if (JSON.stringify(recordedSourceFiles) !== JSON.stringify(expectedSourceHashFiles)) failures.push('browser-review.json: source hash manifest is incomplete or has unexpected entries');
  for (const [file, recordedHash] of sourceHashEntries) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute) || sha256(fs.readFileSync(absolute)) !== recordedHash) failures.push(`browser-review.json: stale source hash for ${file}`);
  }
  const calculatedTreeHash = sha256(sourceHashEntries.map(([file, hash]) => `${file}:${hash}`).join('\n'));
  if (calculatedTreeHash !== browserReview.environment?.sourceTreeHash) failures.push('browser-review.json: source tree hash does not match');
  for (const { file } of renderedFiles) {
    const name = path.basename(file);
    const recordedHash = browserReview.screenshotHashes?.[name];
    if (!recordedHash || sha256(fs.readFileSync(path.join(root, file))) !== recordedHash) failures.push(`browser-review.json: stale or missing screenshot hash for ${name}`);
  }
} catch (error) {
  failures.push(`browser-review.json: invalid JSON (${error.message})`);
}

const runtimeFiles = [...workflowFiles, 'prototypes/rebuild/index.html', 'prototypes/rebuild/prototype.css', 'prototypes/rebuild/prototype.js', 'DESIGN.HTML'];
for (const relativePath of runtimeFiles) {
  const content = read(relativePath);
  if (/(?:src|href)=["']https?:\/\//i.test(content) || /url\(\s*["']?https?:\/\//i.test(content)) failures.push(`${relativePath}: external runtime dependency is not allowed`);
  if (/(fetch\s*\(|XMLHttpRequest|WebSocket\s*\(|EventSource\s*\(|sendBeacon\s*\()/i.test(content)) failures.push(`${relativePath}: network-capable fixture code is not allowed`);
}

for (const relativePath of workflowFiles) {
  const content = read(relativePath);
  requirePattern(content, /<!doctype html>/i, `${relativePath}: missing doctype`);
  requirePattern(content, /<meta\s+name="viewport"/i, `${relativePath}: missing viewport metadata`);
  requirePattern(content, /class="skip"[^>]+href="#main"/i, `${relativePath}: missing skip link`);
  requirePattern(content, /<aside\b[^>]*aria-label="Primary navigation"/i, `${relativePath}: missing named primary navigation`);
  requirePattern(content, /<main\b[^>]*id="main"/i, `${relativePath}: missing main landmark target`);
  requirePattern(content, /Production/i, `${relativePath}: missing environment scope`);
  requirePattern(content, /Harbour &amp; Pine Operations Inc\./i, `${relativePath}: missing flagship-company scope`);
  requirePattern(content, /prototype\.css/i, `${relativePath}: missing local prototype stylesheet`);
  requirePattern(content, /prototype\.js/i, `${relativePath}: missing local fixture script`);
  for (const match of content.matchAll(/\s(?:src|href)="([^"]+)"/gi)) {
    const target = match[1];
    if (target.startsWith('#') || target.startsWith('http') || target.startsWith('mailto:')) continue;
    const cleanTarget = target.split(/[?#]/)[0];
    if (!cleanTarget) continue;
    const absoluteTarget = path.resolve(path.dirname(path.join(root, relativePath)), cleanTarget);
    if (!fs.existsSync(absoluteTarget)) failures.push(`${relativePath}: broken local reference ${target}`);
  }
}

const operation = read('prototypes/rebuild/operation.html');
for (const phrase of ['Production confirmation is unavailable', 'Stop after current safe step', 'No blind retry', 'Recoverable']) {
  if (!operation.includes(phrase)) failures.push(`operation.html: missing safety language ${phrase}`);
}

if (failures.length) {
  console.error(`Rebuild design validation failed (${failures.length}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Rebuild design validation passed: ${requiredFiles.length} required artifacts, ${workflowFiles.length} workflow prototypes.`);
console.log('Scope check: the complete fixture runtime graph is local-only, and browser verification rejects external requests.');
