/**
 * Watch Auto-Poster - Railway Server
 * 
 * Uses persistent Chrome profile to maintain Facebook login across sessions.
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const COOKIE_PATH = '/tmp/fb-cookies.json';
const PROFILE_DIR = '/tmp/chrome-profile';

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

// ─── COOKIE HANDLING ───
function saveCookies(cookies) {
  const cleaned = (cookies || [])
    .filter(c => c && c.name && c.value)
    .map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.facebook.com',
      path: c.path || '/',
      secure: c.secure !== false,
      httpOnly: Boolean(c.httpOnly),
      ...(c.expires && { expires: c.expires }),
      ...(c.sameSite && { sameSite: c.sameSite })
    }));

  fs.writeFileSync(COOKIE_PATH, JSON.stringify(cleaned, null, 2));
  console.log(`💾 Saved ${cleaned.length} cookies to disk`);
  return cleaned;
}

function loadCookies() {
  if (!fs.existsSync(COOKIE_PATH)) {
    console.log('⚠️ No cookies file found at', COOKIE_PATH);
    return [];
  }

  try {
    const raw = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
    const cookies = Array.isArray(raw) ? raw : [];
    console.log(`📖 Loaded ${cookies.length} cookies from disk`);
    return cookies;
  } catch (err) {
    console.error('❌ Failed to parse cookies:', err.message);
    return [];
  }
}

async function launchBrowser() {
  const puppeteer = require('puppeteer');
  
  // Ensure profile directory exists
  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    console.log(`📁 Created Chrome profile directory: ${PROFILE_DIR}`);
  }

  console.log(`🌐 Launching Chrome with persistent profile: ${PROFILE_DIR}`);
  
  return puppeteer.launch({
    headless: 'new',
    userDataDir: PROFILE_DIR,  // ← KEY: Use persistent profile
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled'
    ]
  });
}

// ─── ENDPOINTS ───
app.get('/status', (req, res) => {
  res.json({
    online: true,
    running: posterRunning,
    session: currentSession ? {
      id: currentSession.id,
      progress: currentSession.progress,
      groups: currentSession.groups.map(g => ({
        id: g.id,
        name: g.name,
        status: g.postStatus
      }))
    } : null
  });
});

app.post('/save-cookies', (req, res) => {
  const { cookies, secret } = req.body;

  if (!cookies || !Array.isArray(cookies)) {
    return res.status(400).json({ error: 'Cookies must be an array' });
  }

  if (secret !== process.env.SECRET_KEY) {
    return res.status(403).json({ error: 'Invalid secret' });
  }

  const saved = saveCookies(cookies);
  const names = saved.map(c => c.name);
  const hasCritical = names.includes('c_user') && (names.includes('xs') || names.includes('datr'));

  res.json({
    ok: true,
    count: saved.length,
    savedCookieNames: names,
    hasCritical: hasCritical,
    message: hasCritical ? '✅ Cookies saved! Profile will import them on first posting session.' : '⚠️ Missing critical cookies'
  });
});

app.get('/check-login', async (req, res) => {
  console.log('\n📋 /check-login: Testing Facebook access with persistent profile...');
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Load saved cookies and apply them
    const cookies = loadCookies();
    if (cookies.length > 0) {
      console.log(`📋 Applying ${cookies.length} saved cookies to persistent profile`);
      try {
        await page.setCookie(...cookies);
      } catch (err) {
        console.warn('⚠️ Some cookies could not be set:', err.message);
      }
    }

    console.log('📋 Navigating to facebook.com...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
    await sleep(4000);

    const result = await page.evaluate(() => {
      const cookies = document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean);
      return {
        url: location.href,
        title: document.title,
        hasLoginForm: !!document.querySelector('#loginform') || !!document.querySelector('[data-testid="royal_login_form"]'),
        hasProfileLink: !!document.querySelector('[aria-label="Your profile"]'),
        browserCookieNames: cookies
      };
    });

    const browserNames = result.browserCookieNames;
    const hasCritical = browserNames.includes('c_user') && (browserNames.includes('xs') || browserNames.includes('datr'));

    res.json({
      ...result,
      savedCookieNames: cookies.map(c => c.name),
      browserCookieNames: browserNames,
      hasCritical: hasCritical,
      readyToPost: !result.hasLoginForm && hasCritical,
      status: !result.hasLoginForm ? '✅ Logged in' : '❌ Not logged in',
      note: 'Profile will persist login across sessions'
    });

  } catch (err) {
    console.error('❌ /check-login error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
});

app.post('/start', upload.array('images', 20), async (req, res) => {
  try {
    if (posterRunning) {
      return res.status(409).json({ error: 'Already running' });
    }

    const { caption, groups } = req.body;
    if (!caption) return res.status(400).json({ error: 'Caption required' });

    const parsedGroups = JSON.parse(groups);
    const imagePaths = (req.files || []).map(f => f.path);

    currentSession = {
      id: Date.now(),
      caption,
      imagePaths,
      groups: parsedGroups.map(g => ({ ...g, postStatus: 'pending' })),
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

// ─── POSTER ───
async function runPoster() {
  posterRunning = true;
  const session = currentSession;
  console.log(`\n🎬 Starting posting session: ${session.groups.length} groups`);

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.setViewport({ width: 1280, height: 800 });

    // Load and apply cookies to the persistent profile
    const cookies = loadCookies();
    if (cookies.length > 0) {
      console.log(`🍪 Applying ${cookies.length} cookies to persistent profile`);
      try {
        await page.setCookie(...cookies);
      } catch (err) {
        console.warn('⚠️ Some cookies failed to set:', err.message);
      }
    }

    // Navigate to Facebook
    console.log('📄 Loading facebook.com...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
    await sleep(5000);

    // Check if logged in
    const pageTitle = await page.title();
    const pageUrl = page.url();
    console.log(`   Title: ${pageTitle}`);
    console.log(`   URL: ${pageUrl}`);

    const isLoginPage = await page.evaluate(() =>
      !!document.querySelector('#loginform') ||
      !!document.querySelector('[data-testid="royal_login_form"]') ||
      /log in/i.test(document.body.innerText.slice(0, 300))
    );

    if (isLoginPage) {
      throw new Error('Facebook login page detected. Cookies may be expired.');
    }

    console.log('✅ Logged into Facebook');

    // Proceed with posting
    const pending = session.groups.filter(g => g.postStatus === 'pending' && g.link);

    for (let i = 0; i < pending.length; i++) {
      if (session.stopped) {
        console.log('⛔ Stopped by user');
        break;
      }

      const group = pending[i];
      console.log(`\n[${i + 1}/${pending.length}] → ${group.name}`);

      try {
        await page.goto(group.link, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(5000 + rand(0, 2000));

        const gTitle = await page.title();
        console.log(`   Loaded: ${gTitle}`);

        // Try to open composer
        const composerOpened = await openComposer(page);
        if (!composerOpened) {
          throw new Error('Could not open post composer');
        }
        await sleep(2000);

        // Type caption
        await page.keyboard.type(session.caption, { delay: rand(30, 80) });
        await sleep(1500);

        // Upload images
        if (session.imagePaths.length > 0) {
          await uploadImages(page, session.imagePaths);
          await sleep(4000);
        }

        // Click post
        const posted = await clickPost(page);
        if (!posted) {
          throw new Error('Could not click Post button');
        }

        await sleep(4000);
        group.postStatus = 'done';
        session.progress.done++;
        console.log(`   ✅ Posted!`);

        // Refresh cookies from persistent profile
        const updatedCookies = await page.cookies();
        saveCookies(updatedCookies);

        // Wait before next group
        if (i < pending.length - 1) {
          const waitMs = 60 * 1000 + rand(0, 60000);
          console.log(`   ⏳ Waiting ${Math.round(waitMs / 60000)} min...`);
          await sleep(waitMs);
        }

      } catch (err) {
        console.error(`   ❌ Failed: ${err.message}`);
        group.postStatus = 'failed';
        await sleep(3000);
      }
    }

  } catch (err) {
    console.error(`💥 Session error: ${err.message}`);
    if (session) {
      session.error = err.message;
      session.groups.forEach(g => {
        if (g.postStatus === 'pending') g.postStatus = 'failed';
      });
    }
  } finally {
    await browser.close();
    posterRunning = false;
    console.log('\n🎉 Session complete!\n');
  }
}

async function openComposer(page) {
  const selectors = [
    '[aria-label="Write something to the group..."]',
    '[aria-label="Write something..."]',
    '[aria-label="Create a public post…"]',
    '[data-testid="status-attachment-mentions-input"]',
    'div[contenteditable="true"]',
    '[role="textbox"]'
  ];

  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 3000 });
      await page.click(sel);
      console.log(`   Opened composer with: ${sel}`);
      return true;
    } catch {}
  }

  return false;
}

async function uploadImages(page, imagePaths) {
  const valid = imagePaths.filter(p => fs.existsSync(p));
  if (!valid.length) return;

  let input = await page.$('input[type="file"][accept*="image"]');
  if (!input) {
    input = await page.$('input[type="file"]');
  }

  if (input) {
    await input.uploadFile(...valid);
    console.log(`   ${valid.length} image(s) uploaded`);
  }
}

async function clickPost(page) {
  const buttons = [
    '[aria-label="Post"]',
    '[data-testid="react-composer-post-button"]'
  ];

  for (const sel of buttons) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        console.log(`   Clicked Post button`);
        return true;
      }
    } catch {}
  }

  return false;
}

app.listen(PORT, () => {
  console.log(`✅ Watch Auto-Poster running on port ${PORT}`);
  console.log(`   Using persistent Chrome profile: ${PROFILE_DIR}\n`);
});
