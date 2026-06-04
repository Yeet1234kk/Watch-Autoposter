/**
 * Cookie Extractor — run this ONCE on your PC
 * It opens Chrome, you log into Facebook, then it sends
 * your cookies to Railway so the server can post as you.
 *
 * Usage:
 *   1. npm install puppeteer node-fetch
 *   2. node extract-cookies.js
 *   3. Log into Facebook in the Chrome window that opens
 *   4. Press Enter in terminal when done
 */

const puppeteer = require('puppeteer');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const readline = require('readline');

const RAILWAY_URL = process.env.RAILWAY_URL || 'YOUR_RAILWAY_URL_HERE';
const SECRET_KEY  = process.env.SECRET_KEY  || 'YOUR_SECRET_KEY_HERE';

async function main() {
  console.log('\n🍪 Facebook Cookie Extractor');
  console.log('─────────────────────────────');
  console.log('Chrome will open. Log into Facebook, then come back and press Enter.\n');

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
  });

  const page = await browser.newPage();
  await page.goto('https://www.facebook.com', { waitUntil: 'networkidle2' });

  // Wait for user to log in
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => {
    rl.question('Press Enter after you have logged into Facebook... ', () => {
      rl.close();
      resolve();
    });
  });

  const cookies = await page.cookies('https://www.facebook.com');
  console.log(`\n✅ Got ${cookies.length} cookies`);

  await browser.close();

  // Send cookies to Railway server
  console.log(`📡 Sending to Railway server...`);
  try {
    const res = await fetch(`${RAILWAY_URL}/save-cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies, secret: SECRET_KEY })
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`✅ Cookies saved to Railway! (${data.count} cookies)`);
      console.log('\nYou are all set. Your Railway server can now post to Facebook.\n');
    } else {
      console.error('❌ Server error:', data.error);
    }
  } catch (err) {
    console.error('❌ Could not reach Railway:', err.message);
    console.log('\nCookies saved locally to fb-cookies.json as backup:');
    require('fs').writeFileSync('fb-cookies.json', JSON.stringify(cookies, null, 2));
  }
}

main().catch(console.error);
