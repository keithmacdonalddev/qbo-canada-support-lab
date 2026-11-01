import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROBE = Buffer.from('test-data-lab-browser-download-v1\n');
const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
const fail = code => Object.assign(new Error(code), { code });
const digest = value => createHash('sha256').update(value).digest('hex');

export function appOrigin(value = 'http://localhost:5173') {
  let url; try { url = new URL(value); } catch { throw fail('INVALID_APP_ORIGIN'); }
  if (url.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname)
    || !url.port || Number(url.port) < 1024 || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw fail('INVALID_APP_ORIGIN');
  return url.origin;
}
export function allowedRequest(url, method, app, probe) {
  let target; try { target = new URL(url); } catch { return false; }
  if (method !== 'GET' || target.username || target.password) return false;
  if (target.origin === probe) return ['/ready','/download'].includes(target.pathname) && !target.search;
  if (target.origin !== app || target.pathname.startsWith('/api/')) return false;
  const staticFiles = ['/node_modules/vite/dist/client/env.mjs','/docs/discovery/catalog.v1.json']
    .map(file => encodeURI('/@fs/' + ROOT.replaceAll('\\','/') + file));
  return staticFiles.includes(target.pathname) || target.pathname === '/login' || /^\/(?:src|assets|node_modules|@vite|@react-refresh)(?:\/|$)/.test(target.pathname)
    || target.pathname === '/favicon.svg';
}
export function safeEnvironment(env = process.env) {
  return Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','HOME','USERPROFILE','LOCALAPPDATA','PATH','Path']
    .filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
}
async function bounded(work, timeoutMs, code) {
  let timer;
  try { return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => reject(fail(code)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
async function readResponse(response, maxBytes = 65536) {
  if (!response.body) throw fail('APP_RESPONSE_INVALID');
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try { for (;;) { const { value, done } = await reader.read(); if (done) break;
    size += value.length; if (size > maxBytes) throw fail('APP_RESPONSE_TOO_LARGE'); chunks.push(Buffer.from(value)); }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function identifyApp(origin, fetchImpl = fetch) {
  const get = async route => {
    let response;
    try { response = await fetchImpl(origin + route, { redirect: 'manual', signal: AbortSignal.timeout(8000) }); }
    catch { throw fail('APP_UNREACHABLE'); }
    if (response.status !== 200) { await response.body?.cancel().catch(() => {}); throw fail('APP_NOT_READY'); }
    return readResponse(response);
  };
  let health; try { health = JSON.parse(await get('/api/health')); }
  catch (error) { if (error.code) throw error; throw fail('APP_IDENTITY_MISMATCH'); }
  if (health.app !== 'test-data-lab' || health.status !== 'ok' || health.database !== 'connected') throw fail('APP_IDENTITY_MISMATCH');
  const html = await get('/login');
  if (!/<title>\s*Test Data Lab\s*<\/title>/i.test(html) || !/<div\s+id=["']root["']/i.test(html)) throw fail('APP_FRONTEND_MISMATCH');
}
async function findChrome() {
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe']
    : ['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const file of candidates) { try { await fs.access(file); return file; } catch {} }
  throw fail('BROWSER_EXECUTABLE_MISSING');
}
export async function launchOwnedChrome(executablePath, profile, env, dependencies = {}) {
  const spawnProcess = dependencies.spawn || spawn, execute = dependencies.execFile || execFile;
  const child = spawnProcess(executablePath, ['--headless=new','--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--disable-component-update','--disable-default-apps','--disable-extensions',
    '--disable-component-extensions-with-background-pages','--disable-sync','--disable-domain-reliability',
    '--disable-client-side-phishing-detection','--no-pings','--metrics-recording-only','--no-service-autorun',
    '--disable-features=MediaRouter,OptimizationHints,Translate','--disable-gpu','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
    '--user-data-dir=' + profile,'about:blank'], { windowsHide:true, shell:false, stdio:'ignore', env });
  let exited = false, spawnFailed = false;
  const closed = new Promise(resolve => { child.once('close', () => { exited = true; resolve(); }); child.once('error', () => { spawnFailed = true; resolve(); }); });
  const close = async () => {
    if (!exited && !spawnFailed && child.pid) {
      if (process.platform === 'win32') await new Promise((resolve,reject) => execute(path.join(env.SystemRoot || env.WINDIR || 'C:/Windows','System32','taskkill.exe'), ['/PID',String(child.pid),'/T','/F'],
        { windowsHide:true, shell:false, timeout:5000, env }, error => error && !exited ? reject(fail('BROWSER_PROCESS_CLEANUP_FAILED')) : resolve()));
      else child.kill('SIGTERM');
    }
    await bounded(() => closed, 5000, 'BROWSER_PROCESS_CLEANUP_FAILED');
    if (!exited && !spawnFailed) throw fail('BROWSER_PROCESS_CLEANUP_FAILED');
  };
  try {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      if (dependencies.signal?.aborted) throw fail('BROWSER_CHECK_TIMEOUT');
      if (spawnFailed || exited) throw fail('BROWSER_LAUNCH_FAILED');
      try {
        const text = await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8');
        const [port,socket] = text.trim().split(/\r?\n/);
        if (!/^\d{4,5}$/.test(port) || +port > 65535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(socket || '')) throw fail('BROWSER_ENDPOINT_INVALID');
        return { endpoint:'http://127.0.0.1:' + port, close, exited:() => exited };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve,100));
    }
    throw fail('BROWSER_LAUNCH_TIMEOUT');
  } catch (error) { try { await close(); } catch { throw fail('BROWSER_PROCESS_CLEANUP_FAILED'); } throw error; }
}
export async function enforceRequest(route, app, probe) {
  if (!allowedRequest(route.request().url(), route.request().method(), app, probe)) return route.abort('blockedbyclient');
  const response = await route.fetch({ maxRedirects:0, timeout:10000 });
  if (response.status() >= 300 && response.status() < 400) return route.abort('blockedbyclient');
  return route.fulfill({ response });
}

async function fixture() {
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (req.url === '/ready') {
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'");
      res.end('<!doctype html><title>Browser download probe</title><a id="download-probe" href="/download" download="probe.txt">Download probe</a>');
    } else if (req.url === '/download') {
      res.setHeader('Content-Type','application/octet-stream');
      res.setHeader('Content-Disposition','attachment; filename="probe.txt"'); res.end(PROBE);
    } else res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

// Readiness only. Never reads credentials, restores browser state, signs in, or marks a feature accepted.
export async function checkAppBrowser(options = {}, adapters = {}) {
  const origin = appOrigin(options.origin), report = { version: 1, status: 'failed', appReachable: false,
    browserReady: false, desktopCapture: false, reloadReady: false, downloadMechanismReady: false,
    authenticationRequired: null, readyForAuthenticatedAcceptance: false, featureAcceptanceVerified: false,
    cleanupVerified: false, code: null, artifactDirectory: null };
  let browser, context, probe, directory, profile, nativeProcess; const cleanupFailures = [];
  let stage = 'app-identity', expired = false, settled = false, pending;
  const controller = new AbortController();
  const active = () => { if (expired) throw fail('BROWSER_CHECK_TIMEOUT'); };
  const step = async work => { active(); const result = await work(); active(); return result; };
  const acquire = async (work, assign) => {
    active(); const resource = await work(); assign(resource);
    if (expired) { await bounded(() => resource.close(),5000,'CLEANUP_TIMEOUT'); active(); }
    return resource;
  };
  try {
    pending = (async () => {
    await step(() => identifyApp(origin, adapters.fetch || fetch)); report.appReachable = true;
    const base = path.join(options.root || ROOT, 'artifacts/browser-readiness');
    await fs.mkdir(base, { recursive: true }); directory = await fs.mkdtemp(path.join(base, 'check-'));
    report.artifactDirectory = directory;
    await acquire(fixture,value => { probe = value; }); stage = 'browser-launch';
    const executablePath = await (adapters.findChrome || findChrome)();
    const chromium = adapters.chromium || createRequire(import.meta.url)('playwright-core').chromium;
    profile = await fs.mkdtemp(path.join(os.tmpdir(),'tdl-browser-check-'));
    await acquire(() => (adapters.launch || launchOwnedChrome)(executablePath,profile,safeEnvironment(),{ signal:controller.signal }),value => { nativeProcess = value; });
    await acquire(() => chromium.connectOverCDP(nativeProcess.endpoint, { timeout:10000 }),value => { browser = value; });
    stage = 'browser-context';
    await acquire(() => browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true,
      serviceWorkers: 'block', ignoreHTTPSErrors: false }),value => { context = value; });
    await context.route('**/*', route => enforceRequest(route,origin,probe.origin));
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.addInitScript(() => {
      for (const key of ['RTCPeerConnection','webkitRTCPeerConnection']) Object.defineProperty(globalThis, key, { value: undefined, configurable: false });
    });
    const page = await step(() => context.newPage()); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(15000);
    stage = 'download-probe';
    await page.goto(probe.origin + '/ready', { waitUntil: 'domcontentloaded' });
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-probe').click()]);
    const downloadPath = path.join(directory, 'download-probe.txt'); await step(() => download.saveAs(downloadPath));
    if (digest(await fs.readFile(downloadPath)) !== digest(PROBE)) throw fail('DOWNLOAD_PROBE_MISMATCH');
    report.downloadMechanismReady = true;
    active(); stage = 'app-navigation';
    await page.goto(origin + '/login', { waitUntil: 'domcontentloaded' });
    const login = new URL(page.url());
    if (login.origin !== origin || login.pathname !== '/login' || login.search || login.hash) throw fail('BROWSER_ORIGIN_MISMATCH');
    active(); stage = 'login-render';
    await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor({ state: 'visible' });
    if (await page.locator('#email').inputValue() || await page.locator('#password').inputValue()) throw fail('UNEXPECTED_AUTHENTICATION_STATE');
    report.authenticationRequired = true;
    active(); stage = 'desktop-capture';
    const screenshotPath = path.join(directory, 'desktop-login.png');
    await page.screenshot({ path: screenshotPath });
    const image = await fs.readFile(screenshotPath);
    if (image.length <= PNG.length || !image.subarray(0,PNG.length).equals(PNG)) throw fail('SCREENSHOT_UNVERIFIED');
    report.desktopCapture = true;
    active(); stage = 'app-reload';
    await page.reload({ waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).origin !== origin || new URL(page.url()).pathname !== '/login' || new URL(page.url()).search || new URL(page.url()).hash) throw fail('BROWSER_ORIGIN_MISMATCH');
    await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor({ state: 'visible' });
    active(); report.reloadReady = true; report.browserReady = true; report.status = 'ready-needs-sign-in'; report.code = 'AUTHENTICATED_ACCEPTANCE_STILL_REQUIRED';
    })().finally(() => { settled = true; });
    await bounded(() => pending, adapters.timeoutMs || 60000, 'BROWSER_CHECK_TIMEOUT');
  } catch (error) {
    expired = true; controller.abort();
    const codes = new Set(['APP_UNREACHABLE','APP_NOT_READY','APP_IDENTITY_MISMATCH','APP_FRONTEND_MISMATCH','APP_RESPONSE_INVALID','APP_RESPONSE_TOO_LARGE','BROWSER_EXECUTABLE_MISSING','DOWNLOAD_PROBE_MISMATCH','BROWSER_ORIGIN_MISMATCH','UNEXPECTED_AUTHENTICATION_STATE','SCREENSHOT_UNVERIFIED','BROWSER_CHECK_TIMEOUT','BROWSER_LAUNCH_FAILED','BROWSER_LAUNCH_TIMEOUT','BROWSER_ENDPOINT_INVALID','BROWSER_PROCESS_CLEANUP_FAILED']);
    if (error.code === 'BROWSER_PROCESS_CLEANUP_FAILED') cleanupFailures.push('native-process');
    report.code = codes.has(error.code) ? error.code : stage.toUpperCase().replaceAll('-','_') + '_FAILED';
    report.failedStage = stage;
  } finally {
    for (const [name, resource] of [['context',context],['browser',browser],['native-process',nativeProcess],['probe',probe]]) if (resource) {
      try { await bounded(() => resource.close(), 5000, 'CLEANUP_TIMEOUT'); } catch { cleanupFailures.push(name); }
    }
    if (pending && !settled) { try { await bounded(() => pending.catch(() => {}),5000,'CLEANUP_TIMEOUT'); } catch { cleanupFailures.push('pending-work'); } }
    report.cleanupVerified = settled && cleanupFailures.length === 0 && (!browser || !browser.isConnected()) && (!nativeProcess || nativeProcess.exited());
    if (profile && report.cleanupVerified) {
      const resolved = path.resolve(profile);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('tdl-browser-check-')) throw fail('PROFILE_CLEANUP_BOUNDARY');
      try { await fs.rm(resolved,{ recursive:true,force:true }); } catch { report.cleanupVerified = false; }
    }
    if (!report.cleanupVerified) { report.status = 'failed'; report.code = 'CLEANUP_UNVERIFIED'; }
    if (directory) await fs.writeFile(path.join(directory,'result.json'), JSON.stringify(report,null,2) + '\n', { flag:'wx' });
  }
  return report;
}
export function parseArgs(args) {
  if (!args.length) return {};
  if (args.length === 2 && args[0] === '--origin') return { origin: appOrigin(args[1]) };
  throw fail('USAGE_EXPECTED_OPTIONAL_ORIGIN');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await checkAppBrowser(parseArgs(process.argv.slice(2))); console.log(JSON.stringify(result));
    process.exitCode = result.status === 'failed' ? 1 : 2;
  } catch { console.log(JSON.stringify({ status:'failed',code:'INVALID_ARGUMENT_OR_LOCAL_STORAGE',featureAcceptanceVerified:false })); process.exitCode = 1; }
}
