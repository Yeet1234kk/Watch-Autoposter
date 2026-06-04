/**
 * Watch Auto-Poster - Railway Server
 * 
 * Simplified approach: Use persistent profile to maintain browser state.
 * Don't rely on exported cookies — let the profile handle authentication naturally.
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

// ─── SETUP ───
function ensureProfileDir() {
  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    console.log(`📁 Created Chrome profile directory: ${PROFILE_DIR}`);
  }
}

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
  console.log(`💾 Saved ${cleaned.length} cookies`);
  return cleaned;
}

function loadCookies() {
  if (!fs.existsSync(COOKIE_PATH)) {
    return [];
  }

  try {
    const raw = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    console.error('❌ Failed to parse cookies:', err.message);
    return [];
  }
}

async function launchBrowser() {
  const puppeteer = require('puppeteer');
  ensureProfileDir();

  console.log(`🌐 Launching Chrome with profile: ${PROFILE_DIR}`);
  
  return puppeteer.launch({
    headless: 'new',
    userDataDir: PROFILE_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
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

  res.json({
    ok: true,
    count: saved.length,
    savedCookieNames: names,
    message: '✅ Cookies stored. They will be imported into the Chrome profile on first use.'
  });
});

app.get('/check-login', async (req, res) => {
  console.log('\n📋 /check-login: Testing Chrome profile...');
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Try to import saved cookies into the profile
    const cookies = loadCookies();
    if (cookies.length > 0) {
      console.log(`📋 Importing ${cookies.length} cookies into profile`);
      try {
        await page.setCookie(...cookies);
      } catch (err) {
        console.warn('⚠️ Could not set all cookies:', err.message);
      }
    }

    console.log('📋 Loading facebook.com...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
    await sleep(3000);

    // Get all cookies that are now in the browser (including profile defaults + imported)
    const allCookies = await page.cookies();
    const browserCookieNames = allCookies.map(c => c.name);

    const result = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      hasLoginForm: !!document.querySelector('#loginform') || !!document.querySelector('[data-testid="royal_login_form"]'),
      hasProfileLink: !!document.querySelector('[aria-label="Your profile"]')
    }));

    res.json({
      ...result,
      savedCookieNames: cookies.map(c => c.name),
      browserCookieNames: browserCookieNames,
      readyToPost: !result.hasLoginForm,
      status: !result.hasLoginForm ? '✅ Logged in' : '❌ Not logged in'
    });

  } catch (err) {
    console.error('❌ Error:', err.message);
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
  console.log(`\n🎬 Posting session: ${session.groups.length} groups`);

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.setViewport({ width: 1280, height: 800 });

    // Import cookies into profile
    const cookies = loadCookies();
    if (cookies.length > 0) {
      console.log(`🍪 Importing ${cookies.length} cookies`);
      try {
        await page.setCookie(...cookies);
      } catch (err) {
        console.warn('⚠️ Some cookies failed:', err.message);
      }
    }

    console.log('📄 Loading facebook.com...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'networkidle2' });
    await sleep(4000);

    const pageTitle = await page.title();
    console.log(`   Title: ${pageTitle}`);

    // Check for login page
    const isLoginPage = await page.evaluate(() =>
      !!document.querySelector('#loginform') ||
      !!document.querySelector('[data-testid="royal_login_form"]')
    );

    if (isLoginPage) {
      throw new Error('Detected login page. Not authenticated.');
    }

    console.log('✅ Authenticated');

    const pending = session.groups.filter(g => g.postStatus === 'pending' && g.link);

    for (let i = 0; i < pending.length; i++) {
      if (session.stopped) break;

      const group = pending[i];
      console.log(`\n[${i + 1}/${pending.length}] → ${group.name}`);

      try {
        await page.goto(group.link, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(5000 + rand(0, 2000));

        const composerOpened = await openComposer(page);
        if (!composerOpened) throw new Error('Composer not found');
        await sleep(2000);

        await page.keyboard.type(session.caption, { delay: rand(30, 80) });
        await sleep(1500);

        if (session.imagePaths.length > 0) {
          await uploadImages(page, session.imagePaths);
          await sleep(4000);
        }

        const posted = await clickPost(page);
        if (!posted) throw new Error('Post button not found');

        await sleep(3000);
        group.postStatus = 'done';
        session.progress.done++;
        console.log(`   ✅ Posted`);

        if (i < pending.length - 1) {
          const wait = 60 * 1000 + rand(0, 30000);
          console.log(`   ⏳ Waiting ${Math.round(wait/60000)} min`);
          await sleep(wait);
        }

      } catch (err) {
        console.error(`   ❌ ${err.message}`);
        group.postStatus = 'failed';
        await sleep(2000);
      }
    }

  } catch (err) {
    console.error(`💥 ${err.message}`);
    session.groups.forEach(g => {
      if (g.postStatus === 'pending') g.postStatus = 'failed';
    });
  } finally {
    await browser.close();
    posterRunning = false;
    console.log('\n🎉 Complete\n');
  }
}

async function openComposer(page) {
  console.log('   Looking for post composer...');

  // Try multiple selectors for different Facebook layouts
  const selectors = [
    '[aria-label="Write something to the group..."]',
    '[aria-label="Write something to the group…"]',
    '[aria-label="Write something..."]',
    '[aria-label*="Write something"]',
    '[placeholder*="What"]',
    '[placeholder*="เขียน"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[data-lexical-editor="true"]'
  ];

  // Try each selector
  for (const sel of selectors) {
    try {
      const elements = await page.$$(sel);
      if (elements.length > 0) {
        // Click the first matching element
        await page.evaluate((selector) => {
          const el = document.querySelector(selector);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.click();
          }
        }, sel);
        
        await sleep(1500);
        console.log(`   ✓ Opened with: ${sel}`);
        return true;
      }
    } catch {}
  }

  // Fallback: Try clicking a button that says "Write" or similar
  try {
    const foundButton = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, [role="button"], div[role="button"]');
      for (const btn of buttons) {
        const text = btn.textContent.toLowerCase();
        if (text.includes('write') || text.includes('post') || text.includes('เขียน')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (foundButton) {
      await sleep(1500);
      console.log(`   ✓ Opened by clicking button text`);
      return true;
    }
  } catch {}

  // Last resort: Take a screenshot for debugging
  try {
    await page.screenshot({ path: '/tmp/composer-not-found.png' });
    console.log('   📸 Screenshot saved: /tmp/composer-not-found.png');
  } catch {}

  return false;
}

async function uploadImages(page, imagePaths) {
  const valid = imagePaths.filter(p => fs.existsSync(p));
  if (!valid.length) return;

  console.log(`   Uploading ${valid.length} image(s)...`);

  let input = await page.$('input[type="file"]');
  if (input) {
    await input.uploadFile(...valid);
    console.log(`   ✓ Uploaded`);
    return;
  }

  // Try finding by accept attribute
  input = await page.$('input[type="file"][accept*="image"]');
  if (input) {
    await input.uploadFile(...valid);
    console.log(`   ✓ Uploaded`);
    return;
  }

  console.log('   ⚠️ Could not find file input');
}

async function clickPost(page) {
  console.log('   Looking for Post button...');

  // Wait a moment for the Post button to become available
  await sleep(2000);

  // Log all visible buttons for debugging
  const allButtons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, [role="button"]'))
      .slice(0, 50)  // Limit to first 50
      .map(btn => ({
        text: btn.textContent.trim().slice(0, 30),
        aria: btn.getAttribute('aria-label'),
        disabled: btn.disabled || btn.getAttribute('aria-disabled') === 'true'
      }));
  });

  console.log(`   Found ${allButtons.length} buttons:`);
  allButtons.slice(0, 10).forEach(b => {
    console.log(`     - "${b.text}" | aria: "${b.aria}" | disabled: ${b.disabled}`);
  });

  // Try specific selectors first
  const selectors = [
    '[aria-label="Post"]',
    'button[aria-label*="Post"]',
    'button:contains("Post")',
    'button:contains("โพสต์")'
  ];

  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        const disabled = await page.evaluate(el => el.disabled, btn);
        if (!disabled) {
          await btn.click();
          console.log(`   ✓ Clicked: ${sel}`);
          return true;
        }
      }
    } catch {}
  }

  // Smarter fallback: Find any button that looks like a Post button
  try {
    const found = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, [role="button"]');
      
      // First, try exact text matches
      for (const btn of buttons) {
        const text = btn.textContent.trim().toLowerCase();
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        
        if (text === 'post' || aria === 'post' || 
            text === 'โพสต์' || aria === 'โพสต์' ||
            text === 'list' || aria === 'list' ||
            text === 'ลงประกาศ' || aria === 'ลงประกาศ') {
          
          const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
          if (!disabled) {
            btn.click();
            return true;
          }
        }
      }
      
      // Second, try partial matches on enabled buttons
      for (const btn of buttons) {
        const text = btn.textContent.trim().toLowerCase();
        const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
        
        if (!disabled && (text.includes('post') || text.includes('โพสต์') || text.includes('ลง'))) {
          btn.click();
          return true;
        }
      }
      
      return false;
    });

    if (found) {
      console.log(`   ✓ Clicked Post button`);
      return true;
    }
  } catch (err) {
    console.log(`   ⚠️ Error finding Post button: ${err.message}`);
  }

  return false;
}

ensureProfileDir();
app.listen(PORT, () => {
  console.log(`✅ Watch Auto-Poster ready on port ${PORT}\n`);
});
