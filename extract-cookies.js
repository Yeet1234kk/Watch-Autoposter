/**
 * Facebook Cookie Extractor - fixed version
 *
 * Run this on your PC from the project folder:
 *   npm install
 *   node extract-cookies-fixed.js
 *
 * It uses a persistent Chrome profile at ./chrome-fb-profile.
 * That means Facebook sees the same browser next time instead of a brand-new
 * temporary browser every run.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const puppeteer = require('puppeteer');

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://watch-autoposter-production.up.railway.app';
const SECRET_KEY = process.env.SECRET_KEY || 'mywatch2024';
const PROFILE_DIR = path.join(__dirname, 'chrome-fb-profile');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

function normalizeCookie(cookie) {
  const clean = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || '.facebook.com',
    path: cookie.path || '/',
    secure: cookie.secure !== false,
    httpOnly: Boolean(cookie.httpOnly)
  };

  if (cookie.expires && cookie.expires > 0) clean.expires = Math.floor(cookie.expires);
  if (cookie.sameSite && ['Strict', 'Lax', 'None'].includes(cookie.sameSite)) {
    clean.sameSite = cookie.sameSite;
  }

  return clean;
}

async function collectFacebookCookies(page) {
  const client = await page.target().createCDPSession();
  const all = await client.send('Network.getAllCookies');
  const facebookCookies = all.cookies
    .filter(cookie => /(^|\.)facebook\.com$/i.test(cookie.domain.replace(/^\./, '.')))
    .map(normalizeCookie);

  const byNameAndDomain = new Map();
  for (const cookie of facebookCookies) {
    byNameAndDomain.set(`${cookie.name}|${cookie.domain}|${cookie.path}`, cookie);
  }

  return [...byNameAndDomain.values()];
}

async function main() {
  console.log('\nFacebook Cookie Extractor - fixed');
  console.log('---------------------------------');
  console.log(`Railway URL: ${RAILWAY_URL}`);
  console.log(`Chrome profile: ${PROFILE_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    userDataDir: PROFILE_DIR,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
  });

  const page = await browser.newPage();
  await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });

  console.log('In the Chrome window:');
  console.log('1. Log into Facebook.');
  console.log('2. Open one Facebook group you post to.');
  console.log('3. Wait until the group page fully loads.');
  console.log('4. Come back here and press Enter.\n');

  await ask('Press Enter when Facebook is fully logged in and a group page is open... ');

  await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
  await new Promise(resolve => setTimeout(resolve, 3000));

  const cookies = await collectFacebookCookies(page);
  const names = cookies.map(cookie => cookie.name).sort();

  fs.writeFileSync(path.join(__dirname, 'fb-cookies.json'), JSON.stringify(cookies, null, 2));

  console.log(`\nGot ${cookies.length} Facebook cookies`);
  console.log(`Important cookies: c_user=${names.includes('c_user')}, xs=${names.includes('xs')}, datr=${names.includes('datr')}`);

  if (!names.includes('c_user') || !names.includes('xs')) {
    console.log('\nMissing c_user or xs. Facebook is not fully logged in in this Chrome window.');
    console.log('Do not send yet. Log in again, open a group, then run this file again.');
    await browser.close();
    return;
  }

  console.log('\nSending cookies to Railway...');
  const request = globalThis.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));
  const res = await request(`${RAILWAY_URL}/save-cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies, secret: SECRET_KEY })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Railway returned HTTP ${res.status}`);
  }

  console.log(`Cookies saved to Railway. Count: ${data.count}`);
  console.log('Now open /check-login on Railway to confirm it works.');

  await browser.close();
}

main().catch(err => {
  console.error('\nFailed:', err.message);
  process.exitCode = 1;
});
