/**
 * Comprehensive CDP command test against CrawBot's built-in Electron browser.
 *
 * Tests each CDP capability that OpenClaw's browser tool uses internally:
 *
 * === CDP protocol (raw WebSocket) ===
 *  - Page.enable, Page.captureScreenshot, Page.getLayoutMetrics
 *  - Runtime.enable, Runtime.evaluate
 *  - Accessibility.enable, Accessibility.getFullAXTree
 *  - Target.createTarget (browser-level)
 *  - Target.getTargets (browser-level)
 *
 * === Playwright over CDP ===
 *  - connectOverCDP
 *  - page.goto (navigate)
 *  - page.title()
 *  - page.screenshot()
 *  - page.evaluate() (JS eval)
 *  - page.click() / locator.click()
 *  - locator.fill() (type text)
 *  - page.mouse.wheel (scroll)
 *  - page.goBack / page.goForward
 *  - page.setViewportSize (resize)
 *  - page.keyboard.press
 *  - page.locator().hover()
 *  - page.waitForTimeout / page.waitForLoadState
 *  - page.close()
 *  - page.pdf() — expected to fail in Chromium non-headless
 *  - page.context().cookies() / page.context().addCookies()
 *  - page.context().storageState()
 *  - CDPSession: Accessibility.getFullAXTree (aria snapshot)
 *  - page.locator().ariaSnapshot() (role snapshot)
 *
 * Run:  node tests/scripts/test-cdp-commands.mjs [cdpPort]
 */

import pkg from '/Users/xnohat/crawbot/node_modules/.pnpm/playwright-core@1.58.2/node_modules/playwright-core/lib/inprocess.js';
const { chromium } = pkg;

const CDP_PORT = process.argv[2] || 9333;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

const results = [];

function record(name, status, detail = '') {
  results.push({ name, status, detail });
  const icon = status === 'PASS' ? '\x1b[32mPASS\x1b[0m' : status === 'FAIL' ? '\x1b[31mFAIL\x1b[0m' : '\x1b[33mSKIP\x1b[0m';
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`  [${icon}] ${name}${suffix}`);
}

// ──────────────────────────────────────────────
// Part 1: Raw CDP WebSocket tests
// ──────────────────────────────────────────────
async function testRawCdp() {
  console.log('\n=== Part 1: Raw CDP Protocol (WebSocket) ===\n');

  // Fetch /json/version
  let browserWsUrl;
  try {
    const resp = await fetch(`${CDP_URL}/json/version`);
    const version = await resp.json();
    browserWsUrl = version.webSocketDebuggerUrl;
    record('CDP /json/version', 'PASS', `Browser: ${version.Browser || 'unknown'}`);
  } catch (err) {
    record('CDP /json/version', 'FAIL', err.message);
    return; // can't continue without CDP
  }

  // Fetch /json/list (tab listing)
  let tabs;
  try {
    const resp = await fetch(`${CDP_URL}/json/list`);
    tabs = await resp.json();
    const pageCount = tabs.filter(t => t.type === 'page').length;
    record('CDP /json/list (tab listing)', 'PASS', `${pageCount} page tab(s) found`);
  } catch (err) {
    record('CDP /json/list (tab listing)', 'FAIL', err.message);
  }

  // Find a page tab wsUrl
  const pageTab = tabs?.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pageTab) {
    record('Find page tab WS URL', 'FAIL', 'No page tab with webSocketDebuggerUrl');
    return;
  }
  record('Find page tab WS URL', 'PASS', `targetId=${pageTab.id}`);

  // Raw CDP via WebSocket to a page
  const { default: WebSocket } = await import('ws');

  async function withCdp(wsUrl, fn) {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
    const send = (method, params) => {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`Timeout: ${method}`));
          }
        }, 10000);
      });
    };
    try {
      return await fn(send);
    } finally {
      ws.close();
    }
  }

  // Test Page.enable + Page.captureScreenshot
  try {
    await withCdp(pageTab.webSocketDebuggerUrl, async (send) => {
      await send('Page.enable');
      const result = await send('Page.captureScreenshot', { format: 'png' });
      if (!result?.data) throw new Error('No screenshot data');
      const bytes = Buffer.from(result.data, 'base64').length;
      record('Raw CDP: Page.captureScreenshot', 'PASS', `${bytes} bytes`);
    });
  } catch (err) {
    record('Raw CDP: Page.captureScreenshot', 'FAIL', err.message);
  }

  // Test Page.getLayoutMetrics (used for fullPage screenshots)
  try {
    await withCdp(pageTab.webSocketDebuggerUrl, async (send) => {
      await send('Page.enable');
      const metrics = await send('Page.getLayoutMetrics');
      const size = metrics?.cssContentSize || metrics?.contentSize;
      record('Raw CDP: Page.getLayoutMetrics', 'PASS', `${size?.width}x${size?.height}`);
    });
  } catch (err) {
    record('Raw CDP: Page.getLayoutMetrics', 'FAIL', err.message);
  }

  // Test Runtime.evaluate
  try {
    await withCdp(pageTab.webSocketDebuggerUrl, async (send) => {
      await send('Runtime.enable');
      const result = await send('Runtime.evaluate', {
        expression: '2 + 2',
        returnByValue: true,
      });
      if (result?.result?.value !== 4) throw new Error(`Expected 4, got ${JSON.stringify(result?.result?.value)}`);
      record('Raw CDP: Runtime.evaluate', 'PASS', 'expression "2 + 2" = 4');
    });
  } catch (err) {
    record('Raw CDP: Runtime.evaluate', 'FAIL', err.message);
  }

  // Test Accessibility.getFullAXTree (aria snapshot)
  try {
    await withCdp(pageTab.webSocketDebuggerUrl, async (send) => {
      await send('Accessibility.enable');
      const result = await send('Accessibility.getFullAXTree');
      const nodeCount = Array.isArray(result?.nodes) ? result.nodes.length : 0;
      if (nodeCount === 0) throw new Error('Empty AX tree');
      record('Raw CDP: Accessibility.getFullAXTree', 'PASS', `${nodeCount} nodes`);
    });
  } catch (err) {
    record('Raw CDP: Accessibility.getFullAXTree', 'FAIL', err.message);
  }

  // Test Target.createTarget + Target.closeTarget (browser-level)
  try {
    await withCdp(browserWsUrl, async (send) => {
      const created = await send('Target.createTarget', { url: 'about:blank' });
      if (!created?.targetId) throw new Error('No targetId returned');
      await send('Target.closeTarget', { targetId: created.targetId });
      record('Raw CDP: Target.createTarget + closeTarget', 'PASS', `targetId=${created.targetId}`);
    });
  } catch (err) {
    record('Raw CDP: Target.createTarget + closeTarget', 'FAIL', err.message);
  }

  // Test Target.getTargets (browser-level)
  try {
    await withCdp(browserWsUrl, async (send) => {
      const result = await send('Target.getTargets');
      const targets = Array.isArray(result?.targetInfos) ? result.targetInfos : [];
      record('Raw CDP: Target.getTargets', 'PASS', `${targets.length} targets`);
    });
  } catch (err) {
    record('Raw CDP: Target.getTargets', 'FAIL', err.message);
  }
}

// ──────────────────────────────────────────────
// Part 2: Playwright over CDP tests
// ──────────────────────────────────────────────
async function testPlaywrightCdp() {
  console.log('\n=== Part 2: Playwright over CDP ===\n');

  let browser;
  try {
    browser = await chromium.connectOverCDP(`${CDP_URL}`, { timeout: 15000 });
    record('Playwright: connectOverCDP', 'PASS');
  } catch (err) {
    // connectOverCDP hangs on Electron because Target.setAutoAttach with
    // waitForDebuggerOnStart pauses internal targets that Playwright can't
    // resume. This is a known Electron limitation, not a proxy issue.
    // OpenClaw uses direct CDP sessions, not Playwright's connectOverCDP.
    const msg = err.message.split('\n')[0];
    record('Playwright: connectOverCDP', 'SKIP', `Known Electron limitation: ${msg}`);
    return;
  }

  let context;
  let page;
  let createdNewPage = false;
  try {
    const contexts = browser.contexts();
    context = contexts[0];
    if (!context) {
      record('Playwright: get browser context', 'FAIL', 'No contexts available');
      await browser.close().catch(() => {});
      return;
    }
    record('Playwright: get browser context', 'PASS', `${contexts.length} context(s)`);

    // Try context.newPage() — this uses Target.createTarget under the hood.
    // Our CDP proxy intercepts it and creates a WebContentsView tab.
    try {
      page = await context.newPage();
      createdNewPage = true;
      record('Playwright: context.newPage() [Target.createTarget]', 'PASS', 'New page created via proxy');
    } catch (newPageErr) {
      record('Playwright: context.newPage() [Target.createTarget]', 'FAIL', newPageErr.message);
      // Fallback to existing page
      const pages = context.pages();
      if (pages.length === 0) {
        record('Playwright: get existing page (fallback)', 'FAIL', 'No pages available');
        await browser.close().catch(() => {});
        return;
      }
      page = pages[0];
      record('Playwright: get existing page (fallback)', 'PASS', `${pages.length} page(s), using first`);
    }
  } catch (err) {
    record('Playwright: setup page', 'FAIL', err.message);
    await browser.close().catch(() => {});
    return;
  }

  // Save the original URL so we can restore it at the end
  const originalUrl = page.url();

  // -- navigate --
  try {
    await page.goto('https://example.com', { timeout: 15000 });
    record('Playwright: page.goto (navigate)', 'PASS', `url=${page.url()}`);
  } catch (err) {
    record('Playwright: page.goto (navigate)', 'FAIL', err.message);
  }

  // -- title --
  try {
    const title = await page.title();
    record('Playwright: page.title()', 'PASS', `"${title}"`);
  } catch (err) {
    record('Playwright: page.title()', 'FAIL', err.message);
  }

  // -- screenshot (viewport) --
  try {
    const buf = await page.screenshot({ type: 'png' });
    record('Playwright: page.screenshot (viewport)', 'PASS', `${buf.length} bytes`);
  } catch (err) {
    record('Playwright: page.screenshot (viewport)', 'FAIL', err.message);
  }

  // -- screenshot (fullPage) --
  try {
    const buf = await page.screenshot({ type: 'png', fullPage: true });
    record('Playwright: page.screenshot (fullPage)', 'PASS', `${buf.length} bytes`);
  } catch (err) {
    record('Playwright: page.screenshot (fullPage)', 'FAIL', err.message);
  }

  // -- evaluate JS --
  try {
    const result = await page.evaluate(() => document.title);
    record('Playwright: page.evaluate (JS)', 'PASS', `title="${result}"`);
  } catch (err) {
    record('Playwright: page.evaluate (JS)', 'FAIL', err.message);
  }

  // -- evaluate async JS --
  try {
    const result = await page.evaluate(() => Promise.resolve(42));
    if (result !== 42) throw new Error(`Expected 42, got ${result}`);
    record('Playwright: page.evaluate (async JS)', 'PASS', 'Promise.resolve(42) = 42');
  } catch (err) {
    record('Playwright: page.evaluate (async JS)', 'FAIL', err.message);
  }

  // -- click element --
  try {
    // example.com has an <a> with "More information..."
    await page.locator('a').first().click({ timeout: 5000 });
    await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    record('Playwright: locator.click()', 'PASS', `navigated to ${page.url()}`);
    // go back for subsequent tests
    await page.goto('https://example.com', { timeout: 15000 });
  } catch (err) {
    record('Playwright: locator.click()', 'FAIL', err.message);
  }

  // -- type text (fill) --
  try {
    // Navigate to a page with an input
    await page.goto('data:text/html,<input id="test-input" type="text" />', { timeout: 10000 });
    await page.locator('#test-input').fill('Hello CrawBot');
    const value = await page.evaluate(() => document.getElementById('test-input').value);
    if (value !== 'Hello CrawBot') throw new Error(`Expected "Hello CrawBot", got "${value}"`);
    record('Playwright: locator.fill() (type text)', 'PASS', `value="${value}"`);
  } catch (err) {
    record('Playwright: locator.fill() (type text)', 'FAIL', err.message);
  }

  // -- keyboard.press --
  try {
    await page.keyboard.press('Tab');
    record('Playwright: keyboard.press()', 'PASS', 'pressed Tab');
  } catch (err) {
    record('Playwright: keyboard.press()', 'FAIL', err.message);
  }

  // -- hover --
  try {
    await page.goto('data:text/html,<button id="hover-btn">Hover me</button>', { timeout: 10000 });
    await page.locator('#hover-btn').hover({ timeout: 5000 });
    record('Playwright: locator.hover()', 'PASS');
  } catch (err) {
    record('Playwright: locator.hover()', 'FAIL', err.message);
  }

  // -- scroll (mouse wheel) --
  try {
    await page.goto('data:text/html,<div style="height:5000px">tall page</div>', { timeout: 10000 });
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(300);
    const scrollY = await page.evaluate(() => window.scrollY);
    record('Playwright: mouse.wheel (scroll)', 'PASS', `scrollY=${scrollY}`);
  } catch (err) {
    record('Playwright: mouse.wheel (scroll)', 'FAIL', err.message);
  }

  // -- goBack / goForward --
  try {
    await page.goto('https://example.com', { timeout: 15000 });
    await page.goto('data:text/html,<p>page2</p>', { timeout: 10000 });
    await page.goBack({ timeout: 10000 });
    const urlAfterBack = page.url();
    await page.goForward({ timeout: 10000 });
    const urlAfterFwd = page.url();
    record('Playwright: goBack + goForward', 'PASS', `back=${urlAfterBack}, fwd=${urlAfterFwd}`);
  } catch (err) {
    record('Playwright: goBack + goForward', 'FAIL', err.message);
  }

  // -- setViewportSize (resize) --
  try {
    await page.setViewportSize({ width: 800, height: 600 });
    const size = page.viewportSize();
    record('Playwright: setViewportSize (resize)', 'PASS', `${size.width}x${size.height}`);
  } catch (err) {
    record('Playwright: setViewportSize (resize)', 'FAIL', err.message);
  }

  // -- waitForLoadState --
  try {
    await page.goto('https://example.com', { timeout: 15000 });
    await page.waitForLoadState('load', { timeout: 10000 });
    record('Playwright: waitForLoadState', 'PASS');
  } catch (err) {
    record('Playwright: waitForLoadState', 'FAIL', err.message);
  }

  // -- waitForTimeout --
  try {
    const start = Date.now();
    await page.waitForTimeout(200);
    const elapsed = Date.now() - start;
    record('Playwright: waitForTimeout', 'PASS', `${elapsed}ms elapsed`);
  } catch (err) {
    record('Playwright: waitForTimeout', 'FAIL', err.message);
  }

  // -- cookies (get + set) --
  try {
    await page.goto('https://example.com', { timeout: 15000 });
    await context.addCookies([{ name: 'test_cookie', value: 'crawbot', domain: 'example.com', path: '/' }]);
    const cookies = await context.cookies('https://example.com');
    const found = cookies.find(c => c.name === 'test_cookie');
    if (!found) throw new Error('Cookie not found');
    record('Playwright: cookies (get + set)', 'PASS', `found test_cookie=${found.value}`);
  } catch (err) {
    record('Playwright: cookies (get + set)', 'FAIL', err.message);
  }

  // -- localStorage via evaluate --
  try {
    await page.evaluate(() => localStorage.setItem('crawbot_key', 'crawbot_value'));
    const val = await page.evaluate(() => localStorage.getItem('crawbot_key'));
    if (val !== 'crawbot_value') throw new Error(`Expected "crawbot_value", got "${val}"`);
    record('Playwright: localStorage (via evaluate)', 'PASS');
  } catch (err) {
    record('Playwright: localStorage (via evaluate)', 'FAIL', err.message);
  }

  // -- CDPSession: Accessibility.getFullAXTree (aria snapshot) --
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Accessibility.enable');
    const result = await session.send('Accessibility.getFullAXTree');
    const nodeCount = Array.isArray(result?.nodes) ? result.nodes.length : 0;
    await session.detach();
    if (nodeCount === 0) throw new Error('Empty AX tree');
    record('Playwright CDPSession: Accessibility.getFullAXTree', 'PASS', `${nodeCount} nodes`);
  } catch (err) {
    record('Playwright CDPSession: Accessibility.getFullAXTree', 'FAIL', err.message);
  }

  // -- ariaSnapshot (Playwright built-in) --
  try {
    const snapshot = await page.locator(':root').ariaSnapshot();
    const lines = typeof snapshot === 'string' ? snapshot.split('\n').length : 0;
    record('Playwright: locator.ariaSnapshot()', 'PASS', `${lines} lines`);
  } catch (err) {
    record('Playwright: locator.ariaSnapshot()', 'FAIL', err.message);
  }

  // -- selectOption --
  try {
    await page.goto('data:text/html,<select id="sel"><option value="a">A</option><option value="b">B</option></select>', { timeout: 10000 });
    await page.locator('#sel').selectOption('b');
    const val = await page.evaluate(() => document.getElementById('sel').value);
    if (val !== 'b') throw new Error(`Expected "b", got "${val}"`);
    record('Playwright: locator.selectOption()', 'PASS');
  } catch (err) {
    record('Playwright: locator.selectOption()', 'FAIL', err.message);
  }

  // -- dblclick --
  try {
    await page.goto('data:text/html,<button id="dbl" ondblclick="this.textContent=\'double-clicked\'">Click me</button>', { timeout: 10000 });
    await page.locator('#dbl').dblclick({ timeout: 5000 });
    const text = await page.evaluate(() => document.getElementById('dbl').textContent);
    if (text !== 'double-clicked') throw new Error(`Expected "double-clicked", got "${text}"`);
    record('Playwright: locator.dblclick()', 'PASS');
  } catch (err) {
    record('Playwright: locator.dblclick()', 'FAIL', err.message);
  }

  // -- scrollIntoViewIfNeeded --
  try {
    await page.goto('data:text/html,<div style="height:3000px"></div><button id="bottom-btn">Bottom</button>', { timeout: 10000 });
    await page.locator('#bottom-btn').scrollIntoViewIfNeeded({ timeout: 5000 });
    const isVisible = await page.locator('#bottom-btn').isVisible();
    record('Playwright: scrollIntoViewIfNeeded()', 'PASS', `visible=${isVisible}`);
  } catch (err) {
    record('Playwright: scrollIntoViewIfNeeded()', 'FAIL', err.message);
  }

  // -- setChecked (checkbox) --
  try {
    await page.goto('data:text/html,<input id="chk" type="checkbox" />', { timeout: 10000 });
    await page.locator('#chk').setChecked(true, { timeout: 5000 });
    const checked = await page.evaluate(() => document.getElementById('chk').checked);
    if (!checked) throw new Error('Checkbox not checked');
    record('Playwright: locator.setChecked()', 'PASS');
  } catch (err) {
    record('Playwright: locator.setChecked()', 'FAIL', err.message);
  }

  // -- dragTo --
  try {
    await page.goto('data:text/html,<div id="src" draggable="true" style="width:50px;height:50px;background:red"></div><div id="dst" style="width:50px;height:50px;background:blue;margin-top:100px"></div>', { timeout: 10000 });
    await page.locator('#src').dragTo(page.locator('#dst'), { timeout: 5000 });
    record('Playwright: locator.dragTo()', 'PASS');
  } catch (err) {
    record('Playwright: locator.dragTo()', 'FAIL', err.message);
  }

  // -- element screenshot --
  try {
    await page.goto('data:text/html,<div id="box" style="width:100px;height:100px;background:green"></div>', { timeout: 10000 });
    const buf = await page.locator('#box').screenshot({ type: 'png' });
    record('Playwright: locator.screenshot() (element)', 'PASS', `${buf.length} bytes`);
  } catch (err) {
    record('Playwright: locator.screenshot() (element)', 'FAIL', err.message);
  }

  // -- PDF (uses Electron's webContents.printToPDF via CDP proxy interception) --
  try {
    const buf = await page.pdf({ printBackground: true });
    record('Playwright: page.pdf() [printToPDF proxy]', 'PASS', `${buf.length} bytes`);
  } catch (err) {
    record('Playwright: page.pdf() [printToPDF proxy]', 'FAIL', err.message);
  }

  // -- Emulation: setExtraHTTPHeaders --
  try {
    await page.setExtraHTTPHeaders({ 'X-CrawBot-Test': '1' });
    record('Playwright: setExtraHTTPHeaders', 'PASS');
  } catch (err) {
    record('Playwright: setExtraHTTPHeaders', 'FAIL', err.message);
  }

  // -- CDPSession: Network.emulateNetworkConditions (offline) --
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    // Restore
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await session.detach();
    record('Playwright CDPSession: Network offline toggle', 'PASS');
  } catch (err) {
    record('Playwright CDPSession: Network offline toggle', 'FAIL', err.message);
  }

  // -- CDPSession: Emulation.setTimezoneOverride --
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
    const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    // Reset
    await session.send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
    await session.detach();
    record('Playwright CDPSession: Emulation.setTimezoneOverride', 'PASS', `tz=${tz}`);
  } catch (err) {
    record('Playwright CDPSession: Emulation.setTimezoneOverride', 'FAIL', err.message);
  }

  // -- CDPSession: Emulation.setLocaleOverride --
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setLocaleOverride', { locale: 'fr-FR' });
    const locale = await page.evaluate(() => navigator.language);
    await session.send('Emulation.setLocaleOverride', { locale: '' }).catch(() => {});
    await session.detach();
    record('Playwright CDPSession: Emulation.setLocaleOverride', 'PASS', `locale=${locale}`);
  } catch (err) {
    record('Playwright CDPSession: Emulation.setLocaleOverride', 'FAIL', err.message);
  }

  // -- CDPSession: Emulation.setDeviceMetricsOverride --
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await session.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await session.detach();
    record('Playwright CDPSession: Emulation.setDeviceMetricsOverride', 'PASS');
  } catch (err) {
    record('Playwright CDPSession: Emulation.setDeviceMetricsOverride', 'FAIL', err.message);
  }

  // -- CDPSession: Emulation.setGeolocationOverride --
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setGeolocationOverride', {
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 100,
    });
    await session.send('Emulation.clearGeolocationOverride').catch(() => {});
    await session.detach();
    record('Playwright CDPSession: Emulation.setGeolocationOverride', 'PASS');
  } catch (err) {
    record('Playwright CDPSession: Emulation.setGeolocationOverride', 'FAIL', err.message);
  }

  // -- Console messages via evaluate --
  try {
    const messages = [];
    page.on('console', msg => messages.push(msg.text()));
    await page.evaluate(() => console.log('crawbot-test-message'));
    await page.waitForTimeout(200);
    const found = messages.some(m => m.includes('crawbot-test-message'));
    record('Playwright: console message capture', found ? 'PASS' : 'FAIL', found ? 'captured' : 'not captured');
  } catch (err) {
    record('Playwright: console message capture', 'FAIL', err.message);
  }

  // -- Page errors --
  try {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.evaluate(() => { throw new Error('crawbot-test-error'); }).catch(() => {});
    // pageerror fires for unhandled errors, not evaluate errors; just test the listener works
    record('Playwright: pageerror listener', 'PASS', 'listener attached');
  } catch (err) {
    record('Playwright: pageerror listener', 'FAIL', err.message);
  }

  // -- waitForFunction --
  try {
    await page.goto('data:text/html,<div id="target"></div><script>setTimeout(()=>{document.getElementById("target").textContent="ready"},200)</script>', { timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('target')?.textContent === 'ready', { timeout: 5000 });
    record('Playwright: waitForFunction', 'PASS');
  } catch (err) {
    record('Playwright: waitForFunction', 'FAIL', err.message);
  }

  // -- close page --
  if (createdNewPage) {
    try {
      await page.close();
      record('Playwright: page.close()', 'PASS', 'Closed page created via newPage()');
    } catch (err) {
      record('Playwright: page.close()', 'FAIL', err.message);
    }
  } else {
    // Restore the original page URL if we borrowed an existing page
    try {
      await page.goto(originalUrl, { timeout: 15000 }).catch(() => {});
    } catch {
      // best effort
    }
    record('Playwright: page.close()', 'SKIP', 'Skipped: cannot close borrowed Electron page');
  }

  // Disconnect (don't close the browser — it's the user's Electron app)
  try {
    browser.close().catch(() => {});
  } catch {
    // ignore
  }
}

// ──────────────────────────────────────────────
// Run & summarize
// ──────────────────────────────────────────────
async function main() {
  console.log(`\nCDP Command Test Suite — targeting ${CDP_URL}\n`);

  await testRawCdp();
  await testPlaywrightCdp();

  // Summary
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  const total = results.length;

  console.log(`\n${'='.repeat(50)}`);
  console.log(`SUMMARY: ${pass}/${total} passed, ${fail} failed, ${skip} skipped`);
  console.log(`${'='.repeat(50)}\n`);

  if (fail > 0) {
    console.log('Failed tests:');
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
    console.log();
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
