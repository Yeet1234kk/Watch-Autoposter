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

        const typed = await typeCaption(page, session.caption);
        if (!typed) throw new Error('Could not type caption into composer');
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
  const clicked = await page.evaluate(() => {
    const textMatches = [
      /^(write something|write something\.\.\.)$/i,
      /^what.s on your mind/i,
      /^create post$/i,
      /^เขียนอะไร/i,
      /^คุณคิดอะไรอยู่/i,
      /^คุณกำลังคิดอะไร/i,
      /^สร้างโพสต์$/
    ];

    const candidates = [...document.querySelectorAll('[role="button"], button, [aria-label]')]
      .filter(el => {
        const rect = el.getBoundingClientRect();
        const text = el.textContent || el.getAttribute('aria-label') || '';
        const cleanText = text.replace(/\s+/g, ' ').trim();
        return (
          rect.width > 40 &&
          rect.height > 10 &&
          cleanText.length > 0 &&
          cleanText.length < 180 &&
          textMatches.some(rx => rx.test(cleanText))
        );
      });

    const target = candidates
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      })[0];

    if (target) {
      target.click();
      return (target.textContent || target.getAttribute('aria-label') || '').slice(0, 80);
    }

    return null;
  });

  if (clicked) {
    console.log(`Opened composer with text: ${clicked}`);
    await sleep(2500);
    const hasDialogTextbox = await page.evaluate(() =>
      Boolean((document.querySelector('[role="dialog"]') || document).querySelector('[role="textbox"], div[contenteditable="true"], div[data-lexical-editor="true"]'))
    );
    if (hasDialogTextbox) return true;
    console.log('Composer click did not open a dialog textbox');
  }

  const textboxClicked = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('[role="textbox"], div[contenteditable="true"], div[data-lexical-editor="true"]')]
      .filter(el => {
        const rect = el.getBoundingClientRect();
        const text = (el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        return rect.width > 160 && rect.height > 20 && text.length < 180;
      });

    const box = boxes[0];
    if (!box) return null;
    box.click();
    return (box.textContent || box.getAttribute('aria-label') || '').slice(0, 80);
  });

  if (textboxClicked !== null) {
    console.log(`Opened composer with textbox: ${textboxClicked}`);
    await sleep(2500);
    return true;
  }

  const ariaSelectors = [
    '[aria-label*="Write something"]',
    '[aria-label*="Create a public post"]',
    '[aria-label*="เขียนอะไร"]',
    '[aria-label*="สร้างโพสต์"]'
  ];

  for (const selector of ariaSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 4000 });
      await page.click(selector);
      console.log(`Opened composer with ${selector}`);
      await sleep(2500);
      return true;
    } catch {}
  }

  return false;
}

async function typeCaption(page, caption) {
  const typedInDialog = await page.evaluate((text) => {
    const dialog = document.querySelector('[role="dialog"]') || document;
    const boxes = [...dialog.querySelectorAll('[role="textbox"], div[contenteditable="true"], div[data-lexical-editor="true"]')]
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 80 && rect.height > 10;
      });

    const box = boxes[boxes.length - 1];
    if (!box) return false;

    box.focus();
    document.execCommand('insertText', false, text);
    box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return true;
  }, caption);

  if (typedInDialog) return true;

  try {
    await page.keyboard.type(caption, { delay: rand(30, 80) });
    return true;
  } catch {
    return false;
  }
}

async function uploadImages(page, imagePaths) {
  const validPaths = imagePaths.filter(filePath => fs.existsSync(filePath));
  if (!validPaths.length) return;

  let input = await page.$('[role="dialog"] input[type="file"], input[type="file"][accept*="image"]');
  if (!input) {
    await page.evaluate(() => {
      const root = document.querySelector('[role="dialog"]') || document;
      const button = [...root.querySelectorAll('[role="button"], button, [aria-label], div, span')]
        .find(el => /photo|video|รูปภาพ|วิดีโอ/i.test(el.textContent || el.getAttribute('aria-label') || ''));
      if (button) button.click();
    });
    await sleep(2000);
    input = await page.$('[role="dialog"] input[type="file"], input[type="file"]');
  }

  if (!input) throw new Error('Could not find image upload input');
  await input.uploadFile(...validPaths);
  console.log(`${validPaths.length} image(s) uploaded`);
}

async function clickPost(page) {
  const clickByText = async labels => page.evaluate((wantedLabels) => {
    const normalize = text => (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const wanted = wantedLabels.map(normalize);
    const root = document.querySelector('[role="dialog"]') || document;
    const buttons = [...root.querySelectorAll('[role="button"], button, [aria-label]')];

    for (const button of buttons) {
      const text = normalize(button.textContent || button.getAttribute('aria-label') || '');
      const disabled = button.disabled || button.getAttribute('aria-disabled') === 'true';
      if (!disabled && (wanted.includes(text) || wanted.some(label => text.includes(label)))) {
        button.click();
        return text;
      }
    }

    return null;
  }, labels);

  const finalLabels = [
    'Post',
    'โพสต์',
    'Publish',
    'เผยแพร่',
    'List',
    'ลงประกาศ',
    'Create listing',
    'สร้างประกาศ'
  ];

  const nextLabels = [
    'Next',
    'ถัดไป',
    'Continue',
    'ดำเนินการต่อ'
  ];

  for (let attempt = 0; attempt < 4; attempt++) {
    const finalClicked = await clickByText(finalLabels);
    if (finalClicked) {
      console.log(`Clicked final button: ${finalClicked}`);
      return true;
    }

    const nextClicked = await clickByText(nextLabels);
    if (nextClicked) {
      console.log(`Clicked step button: ${nextClicked}`);
      await sleep(2500);
      continue;
    }

    await sleep(1000);
  }

  const visibleButtons = await page.evaluate(() =>
    [...(document.querySelector('[role="dialog"]') || document).querySelectorAll('[role="button"], button, [aria-label]')]
      .map(el => ({
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
        aria: el.getAttribute('aria-label'),
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true'
      }))
      .filter(item => (item.text || item.aria) && !item.disabled)
      .slice(0, 40)
  );

  console.log('Visible enabled buttons:', JSON.stringify(visibleButtons));
  return false;
}

app.listen(PORT, () => {
  console.log(`Watch Auto-Poster running on port ${PORT}`);
});
