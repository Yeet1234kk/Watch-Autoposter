/**
 * Watch Auto-Poster - Railway Server
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const COOKIE_PATH = '/tmp/fb-cookies.json';

let currentSession = null;
let posterRunning = false;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = '/tmp/watch-images';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`);
  }
});

const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function normalizeCookie(cookie) {
  const clean = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || '.facebook.com',
    path: cookie.path || '/',
    httpOnly: Boolean(cookie.httpOnly),
    secure: cookie.secure !== false
  };

  if (cookie.expires && cookie.expires > 0) clean.expires = Math.floor(cookie.expires);
  if (cookie.expirationDate && cookie.expirationDate > 0) clean.expires = Math.floor(cookie.expirationDate);

  if (cookie.sameSite) {
    const sameSiteMap = {
      strict: 'Strict',
      lax: 'Lax',
      none: 'None',
      no_restriction: 'None',
      unspecified: undefined
    };
    clean.sameSite = sameSiteMap[String(cookie.sameSite).toLowerCase()] || cookie.sameSite;
    if (!['Strict', 'Lax', 'None'].includes(clean.sameSite)) delete clean.sameSite;
  }

  return clean;
}

function saveCookies(cookies) {
  const cleaned = (cookies || [])
    .filter(cookie => cookie && cookie.name && typeof cookie.value === 'string')
    .map(normalizeCookie);

  fs.writeFileSync(COOKIE_PATH, JSON.stringify(cleaned, null, 2));
  return cleaned;
}

function loadCookies() {
  if (!fs.existsSync(COOKIE_PATH)) return [];
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
    return Array.isArray(cookies) ? cookies.map(normalizeCookie) : [];
  } catch (err) {
    console.error('Could not load cookies:', err.message);
    return [];
  }
}

async function launchBrowser() {
  const puppeteer = require('puppeteer');
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
}

async function applyCookies(page) {
  const cookies = loadCookies();
  if (cookies.length) {
    await page.setCookie(...cookies);
    console.log(`Cookies loaded: ${cookies.map(cookie => cookie.name).join(', ')}`);
  }
  return cookies;
}

app.get('/status', (req, res) => {
  res.json({
    online: true,
    running: posterRunning,
    session: currentSession ? {
      id: currentSession.id,
      progress: currentSession.progress,
      groups: currentSession.groups.map(group => ({
        id: group.id,
        name: group.name,
        status: group.postStatus
      }))
    } : null
  });
});

app.post('/save-cookies', (req, res) => {
  const { cookies, secret } = req.body;
  if (secret !== process.env.SECRET_KEY) return res.status(403).json({ error: 'Forbidden' });

  const saved = saveCookies(cookies);
  res.json({
    ok: true,
    count: saved.length,
    savedCookieNames: saved.map(cookie => cookie.name)
  });
});

app.get('/check-login', async (req, res) => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.setViewport({ width: 1280, height: 800 });

    const savedCookies = await applyCookies(page);
    await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
    await sleep(4000);

    const result = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      hasLoginForm: Boolean(document.querySelector('#loginform, [data-testid="royal_login_form"]')),
      bodyText: document.body.innerText.slice(0, 500),
      ariaLabels: [...document.querySelectorAll('[aria-label]')]
        .map(el => el.getAttribute('aria-label'))
        .filter(Boolean)
        .slice(0, 25)
    }));

    const browserCookies = await page.cookies('https://www.facebook.com/');
    res.json({
      ...result,
      savedCookieNames: savedCookies.map(cookie => cookie.name),
      browserCookieNames: browserCookies.map(cookie => cookie.name)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
});

app.get('/check-group', async (req, res) => {
  const groupUrl = req.query.url;
  if (!groupUrl) return res.status(400).json({ error: 'Pass ?url=https://facebook.com/groups/...' });

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.setViewport({ width: 1280, height: 800 });

    await applyCookies(page);
    await page.goto(groupUrl, { waitUntil: 'networkidle2' });
    await sleep(5000);

    const result = await page.evaluate(() => {
      const checks = [
        '[aria-label="Write something to the group..."]',
        '[aria-label="Write something..."]',
        '[aria-label*="Write something"]',
        '[aria-label*="Create a public post"]',
        '[role="textbox"]',
        'div[contenteditable="true"]',
        'div[data-lexical-editor="true"]'
      ];

      return {
        url: location.href,
        title: document.title,
        matchedSelectors: checks.filter(selector => document.querySelector(selector)),
        ariaLabels: [...document.querySelectorAll('[aria-label]')]
          .map(el => el.getAttribute('aria-label'))
          .filter(label => label && label.length < 80)
          .filter((value, index, array) => array.indexOf(value) === index)
          .slice(0, 50),
        bodyText: document.body.innerText.slice(0, 800)
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
});

app.post('/start', upload.array('images', 20), async (req, res) => {
  try {
    if (posterRunning) return res.status(409).json({ error: 'Already running. Stop first.' });

    const { caption, groups } = req.body;
    if (!caption) return res.status(400).json({ error: 'Caption required' });

    const parsedGroups = JSON.parse(groups);
    const imagePaths = (req.files || []).map(file => file.path);

    currentSession = {
      id: Date.now(),
      caption,
      imagePaths,
      groups: parsedGroups.map(group => ({ ...group, postStatus: 'pending' })),
      progress: { done: 0, total: parsedGroups.length },
      stopped: false,
      startedAt: new Date().toISOString()
    };

    res.json({
      ok: true,
      sessionId: currentSession.id,
      groups: parsedGroups.length,
      images: imagePaths.length
    });

    runPoster().catch(err => {
      console.error('Poster error:', err);
      posterRunning = false;
    });
  } catch (err) {
    console.error('/start error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/stop', (req, res) => {
  if (currentSession) currentSession.stopped = true;
  res.json({ ok: true });
});

async function runPoster() {
  posterRunning = true;
  const session = currentSession;
  console.log(`Auto-poster started: ${session.groups.length} groups`);

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.setViewport({ width: 1280, height: 800 });

    const cookies = await applyCookies(page);
    const cookieNames = cookies.map(cookie => cookie.name);
    if (!cookieNames.includes('c_user') || !cookieNames.includes('xs')) {
      throw new Error('Missing Facebook login cookies. Need c_user and xs.');
    }

    await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
    await sleep(4000);

    const isLoginPage = await page.evaluate(() =>
      Boolean(document.querySelector('#loginform, [data-testid="royal_login_form"]')) ||
      /log in|create new account/i.test(document.body.innerText.slice(0, 300))
    );

    if (isLoginPage) {
      throw new Error('Facebook opened login page. Cookies are expired or incomplete.');
    }

    const pending = session.groups.filter(group => group.postStatus === 'pending' && group.link);

    for (let i = 0; i < pending.length; i++) {
      if (session.stopped) break;

      const group = pending[i];
      console.log(`[${i + 1}/${pending.length}] ${group.name}`);

      try {
        await page.goto(group.link, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(5000 + rand(0, 2000));
        console.log(`Group URL after load: ${page.url()}`);

        const composerOpened = await openComposer(page);
        if (!composerOpened) throw new Error('Could not open post composer');
        await sleep(2000);

        await page.keyboard.type(session.caption, { delay: rand(30, 80) });
        await sleep(1500);

        if (session.imagePaths.length > 0) {
          await uploadImages(page, session.imagePaths);
          await sleep(4000);
        }

        const posted = await clickPost(page);
        if (!posted) throw new Error('Could not click Post button');

        await sleep(4000);
        group.postStatus = 'done';
        session.progress.done++;
        console.log('Posted');

        const freshCookies = await page.cookies('https://www.facebook.com/');
        saveCookies(freshCookies.length ? freshCookies : cookies);

        if (i < pending.length - 1) {
          const wait = 60 * 1000 + rand(0, 30000);
          console.log(`Waiting ${Math.round(wait / 1000)} seconds`);
          await sleep(wait);
        }
      } catch (err) {
        console.error(`Failed: ${err.message}`);
        group.postStatus = 'failed';
        await sleep(3000);
      }
    }
  } catch (err) {
    console.error(`Session failed: ${err.message}`);
    if (session) {
      session.error = err.message;
      session.groups.forEach(group => {
        if (group.postStatus === 'pending') group.postStatus = 'failed';
      });
    }
  } finally {
    await browser.close();
    posterRunning = false;
    console.log('Posting session complete');
  }
}

async function openComposer(page) {
  const selectors = [
    '[aria-label="Write something to the group..."]',
    '[aria-label="Write something..."]',
    '[aria-label*="Write something"]',
    '[aria-label*="Create a public post"]',
    '[role="textbox"]',
    'div[contenteditable="true"]',
    'div[data-lexical-editor="true"]'
  ];

  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      await page.click(selector);
      console.log(`Opened composer with ${selector}`);
      return true;
    } catch {}
  }

  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('[role="button"], div, span')];
    const button = buttons.find(el => /write something|what.s on your mind|create post/i.test(el.textContent || ''));
    if (button) {
      button.click();
      return true;
    }
    return false;
  });
}

async function uploadImages(page, imagePaths) {
  const validPaths = imagePaths.filter(filePath => fs.existsSync(filePath));
  if (!validPaths.length) return;

  let input = await page.$('input[type="file"][accept*="image"]');
  if (!input) {
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('[role="button"], div, span')]
        .find(el => /photo|video/i.test(el.textContent || ''));
      if (button) button.click();
    });
    await sleep(2000);
    input = await page.$('input[type="file"]');
  }

  if (!input) throw new Error('Could not find image upload input');
  await input.uploadFile(...validPaths);
  console.log(`${validPaths.length} image(s) uploaded`);
}

async function clickPost(page) {
  const selectors = [
    '[aria-label="Post"]',
    '[aria-label="โพสต์"]',
    '[data-testid="react-composer-post-button"]'
  ];

  for (const selector of selectors) {
    try {
      const button = await page.$(selector);
      if (!button) continue;
      const disabled = await button.evaluate(el =>
        el.disabled || el.getAttribute('aria-disabled') === 'true'
      );
      if (!disabled) {
        await button.click();
        return true;
      }
    } catch {}
  }

  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('[role="button"], button')];
    const button = buttons.find(el => /^(post|โพสต์)$/i.test((el.textContent || '').trim()));
    if (button && button.getAttribute('aria-disabled') !== 'true') {
      button.click();
      return true;
    }
    return false;
  });
}

app.listen(PORT, () => {
  console.log(`Watch Auto-Poster running on port ${PORT}`);
});
