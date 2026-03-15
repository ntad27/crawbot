/**
 * Test full-page screenshot with auto-scroll and clip trimming.
 */

import pkg from '/Users/xnohat/crawbot/node_modules/.pnpm/playwright-core@1.58.2/node_modules/playwright-core/lib/inprocess.js';
import { writeFileSync } from 'node:fs';
const { chromium } = pkg;

const CDP_PORT = process.argv[2] || 9333;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

async function main() {
  console.log(`Connecting to CDP at ${CDP_URL}...`);

  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
  const context = browser.contexts()[0];
  const pages = context.pages();

  let page = pages.find(p => p.url().includes('crawbot.net')) || pages[0];
  if (!page) {
    page = await context.newPage();
  }

  console.log('Navigating to crawbot.net...');
  await page.goto('https://crawbot.net/', { timeout: 30000, waitUntil: 'networkidle' });
  console.log(`Page loaded: ${page.url()}, title: ${await page.title()}`);
  await page.waitForTimeout(2000);

  // Measure using the SAME content tags as the proxy code (without footer)
  const measurements = await page.evaluate(() => {
    const body = document.body;
    const html = document.documentElement;
    const docHeight = Math.max(body.scrollHeight, html.scrollHeight, html.clientHeight);
    const docWidth = Math.max(body.scrollWidth, html.scrollWidth, html.clientWidth);

    const contentTags = 'p,h1,h2,h3,h4,h5,h6,span,a,li,td,th,img,svg,video,canvas,input,button,textarea,select,label,figcaption,blockquote,pre,code';
    const allEls = document.querySelectorAll(contentTags);
    let maxBottom = 0, maxRight = 0, count = 0;
    let bottomEl = '';
    // Track the bottom 5 elements
    const bottomEls = [];
    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const absBottom = rect.bottom + window.scrollY;
      const absRight = rect.right + window.scrollX;
      bottomEls.push({
        tag: el.tagName,
        absBottom: Math.round(absBottom),
        text: (el.textContent || '').substring(0, 40).trim()
      });
      if (absBottom > maxBottom) {
        maxBottom = absBottom;
        bottomEl = el.tagName + ' absBottom=' + Math.round(absBottom) + ' text=' + (el.textContent || '').substring(0, 40);
      }
      if (absRight > maxRight) maxRight = absRight;
      count++;
    }

    // Sort by absBottom desc and take top 10
    bottomEls.sort((a, b) => b.absBottom - a.absBottom);
    const top10 = bottomEls.slice(0, 10);

    return { docHeight, docWidth, maxBottom: Math.round(maxBottom), maxRight: Math.round(maxRight), count, bottomEl, top10 };
  });
  console.log('Page measurements:', JSON.stringify(measurements, null, 2));

  // Take full-page screenshot
  console.log('\nTaking full-page screenshot...');
  const startTime = Date.now();
  const buf = await page.screenshot({
    type: 'png',
    fullPage: true,
    timeout: 60000
  });
  const elapsed = Date.now() - startTime;

  const outPath = '/tmp/crawbot-fullpage-screenshot.png';
  writeFileSync(outPath, buf);

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  console.log(`Full page: ${outPath} — ${width}x${height} CSS≈${Math.round(width/2)}x${Math.round(height/2)} (${Math.round(buf.length / 1024)}KB, ${elapsed}ms)`);

  browser.close().catch(() => {});
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
