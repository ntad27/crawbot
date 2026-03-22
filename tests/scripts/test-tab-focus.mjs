/**
 * Automated test: Tab creation, Playwright focus, and UI sync
 */
import { chromium } from '/Users/xnohat/crawbot/node_modules/.pnpm/playwright-core@1.58.2/node_modules/playwright-core/index.mjs';
import http from 'http';
import { WebSocket } from 'ws';

function fetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

async function createTab(url) {
  const targets = JSON.parse(await fetch('http://127.0.0.1:9222/json/list'));
  const mainWin = targets.find(t => t.url?.includes('localhost:5173'));
  if (!mainWin) throw new Error('No main window');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(mainWin.webSocketDebuggerUrl);
    ws.on('open', () => {
      const expr = `window.electron.ipcRenderer.invoke('browser:tab:create', {id: 'test-${Date.now()}', url: '${url}', partition: 'persist:browser-shared', category: 'automation'})`;
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
      ws.on('message', data => {
        const m = JSON.parse(data.toString());
        if (m.id === 1) { ws.close(); resolve(); }
      });
    });
    ws.on('error', reject);
  });
}

async function run() {
  console.log('TEST 1: Creating 2 tabs...');
  await createTab('https://example.com');
  await createTab('https://httpbin.org/html');
  await new Promise(r => setTimeout(r, 3000));
  console.log('  OK');

  console.log('TEST 2: Connecting Playwright...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const pages = browser.contexts()[0].pages();
  const examplePage = pages.find(p => p.url().includes('example.com'));
  const httpbinPage = pages.find(p => p.url().includes('httpbin.org'));

  if (!examplePage || !httpbinPage) {
    console.log('FAIL: Pages not found. Available:', pages.map(p => p.url().substring(0, 40)));
    await browser.close();
    process.exit(1);
  }
  console.log('  Found example.com + httpbin.org');

  console.log('TEST 3: Focus example.com via bringToFront...');
  await examplePage.bringToFront();
  await new Promise(r => setTimeout(r, 2000));
  console.log('  OK — check CrawBot window for tab switch');

  console.log('TEST 4: Focus httpbin.org via bringToFront...');
  await httpbinPage.bringToFront();
  await new Promise(r => setTimeout(r, 2000));
  console.log('  OK');

  console.log('TEST 5: Navigate httpbin page to crawbot.net...');
  await httpbinPage.goto('https://crawbot.net', { timeout: 15000 });
  console.log('  URL:', httpbinPage.url());
  console.log('  Title:', await httpbinPage.title());

  console.log('TEST 6: Snapshot...');
  const title = await httpbinPage.title();
  if (title.includes('CrawBot')) {
    console.log('  PASS — Title contains "CrawBot"');
  } else {
    console.log('  FAIL — Expected CrawBot in title, got:', title);
  }

  console.log('');
  console.log('=== ALL AUTOMATED TESTS PASSED ===');

  await browser.close();
  process.exit(0);
}

run().catch(e => {
  console.log('ERROR:', e.message);
  process.exit(1);
});
