/**
 * Watch Auto-Poster — Railway Server
 * Runs 24/7 on Railway. Controls Puppeteer in the background.
 * Your Vercel app talks to this server from anywhere.
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── In-memory session store (Railway has persistent disk too) ───
let currentSession = null;
let posterRunning = false;

// ─── Multer: store uploaded images in /tmp (Railway's writable dir) ───
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = '/tmp/watch-images';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `img_${Date.now()}_${Math.random().toString(36).slice(2,7)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── STATUS ───
app.get('/status', (req, res) => {
  res.json({
    online: true,
    running: posterRunning,
    session: currentSession ? {
      id: currentSession.id,
      progress: currentSession.progress,
      groups: currentSession.groups.map(g => ({
        id: g.id, name: g.name, status: g.postStatus
      }))
    } : null
  });
});

// ─── START: receive caption + images + groups, kick off background poster ───
app.post('/start', upload.array('images', 20), async (req, res) => {
  try {
    if (posterRunning) return res.status(409).json({ error: 'Already running. Stop first.' });

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

    // Respond immediately, then start posting in background
    res.json({ ok: true, sessionId: currentSession.id, groups: parsedGroups.length, images: imagePaths.length });

    // Kick off background posting (don't await — runs independently)
    runPoster().catch(err => {
      console.error('Poster error:', err);
      posterRunning = false;
    });

  } catch (e) {
    console.error('/start error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── STOP ───
app.post('/stop', (req, res) => {
  if (currentSession) currentSession.stopped = true;
  res.json({ ok: true });
});

// ─── BACKGROUND POSTER ───
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

async function runPoster() {
  const puppeteer = require('puppeteer');
  posterRunning = true;
  const session = currentSession;

  console.log(`\n🚀 Auto-poster started: ${session.groups.length} groups`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ]
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.setViewport({ width: 1280, height: 800 });

    // ── Log into Facebook using saved cookies ──
    const cookiePath = '/tmp/fb-cookies.json';
   if (fs.existsSync(cookiePath)) {
  const raw = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
  const cookies = raw.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain || '.facebook.com',
    path: c.path || '/',
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: 'None'
  }));
  await page.setCookie(...cookies);
  console.log(`🍪 ${cookies.length} cookies loaded`);
}

    await page.goto('https://www.facebook.com', { waitUntil: 'networkidle2' });
    await sleep(3000);

    // Check if logged in
    const isLoggedIn = await page.evaluate(() =>
      !document.querySelector('[data-testid="royal_login_form"]') &&
      !document.querySelector('#loginform')
    );

    if (!isLoggedIn) {
      console.error('❌ Not logged into Facebook. Use /login endpoint first.');
      session.groups.forEach(g => g.postStatus = 'failed');
      session.error = 'Not logged into Facebook. Set up cookies first via /login.';
      posterRunning = false;
      await browser.close();
      return;
    }

    console.log('✅ Logged into Facebook');

    // ── Post to each group ──
    const pending = session.groups.filter(g => g.postStatus === 'pending' && g.link);

    for (let i = 0; i < pending.length; i++) {
      if (session.stopped) { console.log('⛔ Stopped by user'); break; }

      const group = pending[i];
      console.log(`\n[${i+1}/${pending.length}] → ${group.name}`);

      try {
        await page.goto(group.link, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(4000 + rand(0, 2000));

        // Click composer
        const composerOpened = await openComposer(page);
        if (!composerOpened) throw new Error('Could not open post composer');
        await sleep(2000);

        // Type caption with human-like delays
        await page.keyboard.type(session.caption, { delay: rand(30, 80) });
        await sleep(1500);

        // Upload images
        if (session.imagePaths.length > 0) {
          await uploadImages(page, session.imagePaths);
          await sleep(4000);
        }

        // Click Post
        const posted = await clickPost(page);
        if (!posted) throw new Error('Could not click Post button');

        await sleep(4000);
        group.postStatus = 'done';
        session.progress.done++;
        console.log(`  ✅ Posted!`);

        // Save cookies after successful post
        const cookies = await page.cookies();
        fs.writeFileSync(cookiePath, JSON.stringify(cookies));

        // Wait between groups
        if (i < pending.length - 1) {
          const wait = 1 * 60 * 1000 + rand(0, 60000); // 4-5 min random
          console.log(`  ⏳ Waiting ${Math.round(wait/60000)} min...`);
          await sleep(wait);
        }

      } catch (err) {
        console.error(`  ❌ Failed: ${err.message}`);
        group.postStatus = 'failed';
        await sleep(3000);
      }
    }

  } finally {
    await browser.close();
    posterRunning = false;
    console.log('\n🎉 Posting session complete!');
  }
}

// ─── HELPERS ───
async function openComposer(page) {
  const selectors = [
    '[aria-label="Write something..."]',
    '[aria-label="Create a public post…"]',
    '[data-testid="status-attachment-mentions-input"]',
    '[role="textbox"]'
  ];
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 4000 });
      await page.click(sel);
      return true;
    } catch {}
  }
  // Fallback: find by text
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('[role="button"]')) {
      if (/write something|what.s on your mind/i.test(el.textContent)) {
        el.click(); return true;
      }
    }
    return false;
  });
}

async function uploadImages(page, imagePaths) {
  const validPaths = imagePaths.filter(p => fs.existsSync(p));
  if (!validPaths.length) return;

  // Try direct file input
  let input = await page.$('input[type="file"][accept*="image"]');
  if (!input) {
    // Click photo button first
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('[role="button"]')) {
        if (/photo|video/i.test(b.textContent)) { b.click(); return; }
      }
    });
    await new Promise(r => setTimeout(r, 2000));
    input = await page.$('input[type="file"]');
  }
  if (input) {
    await input.uploadFile(...validPaths);
    console.log(`  📎 ${validPaths.length} image(s) uploaded`);
  }
}

async function clickPost(page) {
  for (const sel of ['[aria-label="Post"]', '[data-testid="react-composer-post-button"]']) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        const disabled = await btn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');
        if (!disabled) { await btn.click(); return true; }
      }
    } catch {}
  }
  return page.evaluate(() => {
    for (const b of document.querySelectorAll('[role="button"]')) {
      if (b.textContent.trim() === 'Post' && !b.disabled) { b.click(); return true; }
    }
    return false;
  });
}

// ─── COOKIE LOGIN SETUP ───
// POST /save-cookies with { cookies: [...] } to save your FB session
app.post('/save-cookies', (req, res) => {
  const { cookies, secret } = req.body;
  if (secret !== process.env.SECRET_KEY) return res.status(403).json({ error: 'Forbidden' });
  fs.writeFileSync('/tmp/fb-cookies.json', JSON.stringify(cookies));
  res.json({ ok: true, count: cookies.length });
});

app.listen(PORT, () => {
  console.log(`\n🟢 Watch Auto-Poster running on port ${PORT}`);
  console.log(`   Set SECRET_KEY env var to protect your /save-cookies endpoint\n`);
});
// ─── DEBUG: Check login status ───
app.get('/check-login', async (req, res) => {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const cookiePath = '/tmp/fb-cookies.json';
    if (fs.existsSync(cookiePath)) {
      const raw = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
      const cookies = raw.map(c => ({
        name: c.name, value: c.value,
        domain: c.domain || '.facebook.com',
        path: c.path || '/', httpOnly: c.httpOnly || false,
        secure: c.secure || false, sameSite: 'None'
      }));
      await page.setCookie(...cookies);
    }

    await page.goto('https://www.facebook.com', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 3000));

    const result = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      hasLoginForm: !!document.querySelector('#loginform') || !!document.querySelector('[data-testid="royal_login_form"]'),
      hasProfileLink: !!document.querySelector('[aria-label="Your profile"]'),
      cookieNames: document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean)
    }));

    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  } finally {
    await browser.close();
  }
});
