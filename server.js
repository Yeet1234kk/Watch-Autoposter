/**
 * Watch Auto-Poster — Railway Server (Fixed Version)
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

// ─── In-memory session store ───
let currentSession = null;
let posterRunning = false;

// ─── Multer: store uploaded images in /tmp ───
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

// ─── START ───
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

    res.json({ ok: true, sessionId: currentSession.id, groups: parsedGroups.length, images: imagePaths.length });

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

// ─── HELPERS ───
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function loadCookies() {
  const cookiePath = '/tmp/fb-cookies.json';
  if (!fs.existsSync(cookiePath)) return [];
  const raw = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
  return raw.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain || '.facebook.com',
    path: c.path || '/',
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: 'None'
  }));
}

function launchBrowser() {
  const puppeteer = require('puppeteer');
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ]
  });
}

async function uploadImages(page, imagePaths) {
  const validPaths = imagePaths.filter(p => fs.existsSync(p));
  if (!validPaths.length) return;

  console.log(`  📸 Preparing to upload ${validPaths.length} watch image(s)...`);

  for (let i = 0; i < validPaths.length; i++) {
    const currentPath = validPaths[i];
    
    // Find the file input field again on each iteration as the DOM might refresh
    let input = await page.$('input[type="file"][accept*="image"]');
    if (!input) {
      await page.evaluate(() => {
        for (const b of document.querySelectorAll('[role="button"]')) {
          if (/photo|video|รูปภาพ|วิดีโอ/i.test(b.textContent)) { b.click(); return; }
        }
      });
      await sleep(2000);
      input = await page.$('input[type="file"]');
    }

    if (input) {
      // Upload one file at a time to prevent the "multiple" attribute error
      await input.uploadFile(currentPath);
      console.log(`    📎 Image [${i + 1}/${validPaths.length}] attached successfully.`);
      
      // Short delay between uploads so Facebook's UI can process the file sequential addition
      await sleep(2500); 
    } else {
      console.error(`    ❌ Could not find the file input element for image ${i + 1}`);
    }
  }
  
  console.log(`  ✅ All ${validPaths.length} image(s) uploaded successfully!`);
}

  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 5000 });
      if (el) {
        await el.evaluate(e => e.scrollIntoView());
        await sleep(500);
        await el.click();
        await sleep(1000);
        console.log(`  🖊 Composer opened via: ${sel}`);
        return true;
      }
    } catch {}
  }

  // Fallback: find by placeholder text or button text
  const found = await page.evaluate(() => {
    const patterns = [
      /write something/i,
      /what.s on your mind/i,
      /create a post/i,
      /เขียนอะไรบางอย่าง/i,
    ];
    const candidates = [
      ...document.querySelectorAll('[role="button"]'),
      ...document.querySelectorAll('div[tabindex]'),
      ...document.querySelectorAll('[placeholder]')
    ];
    for (const el of candidates) {
      const text = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.textContent || '';
      if (patterns.some(p => p.test(text))) {
        el.click();
        return true;
      }
    }
    return false;
  });

  if (found) {
    await sleep(2000);
    console.log('  🖊 Composer opened via fallback');
    return true;
  }

  // Save debug screenshot
  await page.screenshot({ path: '/tmp/composer-debug.png' });
  console.log('  📸 Debug screenshot saved: /tmp/composer-debug.png');
  return false;
}

async function uploadImages(page, imagePaths) {
  const validPaths = imagePaths.filter(p => fs.existsSync(p));
  if (!validPaths.length) return;

  let input = await page.$('input[type="file"][accept*="image"]');
  if (!input) {
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('[role="button"]')) {
        if (/photo|video/i.test(b.textContent)) { b.click(); return; }
      }
    });
    await sleep(2000);
    input = await page.$('input[type="file"]');
  }
  if (input) {
    await input.uploadFile(...validPaths);
    console.log(`  📎 ${validPaths.length} image(s) uploaded`);
  }
}

async function clickPost(page) {
  console.log('  Looking for Post button...');
  
  // 1. Try technical CSS Selectors used across different Facebook layouts
  const selectors = [
    'div[aria-label="Post"]',
    'div[aria-label="โพสต์"]',
    'button[type="submit"]',
    '[data-testid="react-composer-post-button"]',
    'div[role="button"][tabindex="0"]'
  ];

  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        const isCorrectButton = await btn.evaluate(el => {
          const text = (el.innerText || el.textContent || '').trim();
          // Verify it's either explicitly the post button or match common text labels
          return el.getAttribute('aria-label') === 'Post' || 
                 el.getAttribute('aria-label') === 'โพสต์' || 
                 text === 'Post' || text === 'โพสต์';
        });

        if (isCorrectButton) {
          const disabled = await btn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');
          if (!disabled) {
            await btn.click();
            console.log(`   ✓ Clicked Post button via selector: ${sel}`);
            return true;
          }
        }
      }
    } catch (e) {}
  }

  // 2. Fallback strategy: Scan all active text structures on the interface
  const clickedViaText = await page.evaluate(() => {
    const targets = ["โพสต์", "Post", "ลงประกาศ", "แชร์", "Publish"];
    const elements = Array.from(document.querySelectorAll('div[role="button"], button, span, div'));
    
    for (const el of elements) {
      const text = (el.innerText || el.textContent || "").trim();
      if (targets.includes(text)) {
        // Double check it's not disabled
        if (!el.disabled && el.getAttribute('aria-disabled') !== 'true') {
          el.click();
          return text;
        }
      }
    }
    return null;
  });

  if (clickedViaText) {
    console.log(`   ✓ Clicked Post button via text matching: "${clickedViaText}"`);
    return true;
  }

  // 3. Ultimate Fallback: Emulate the Keyboard Hotkey sequence (Ctrl + Enter submits forms on Facebook)
  console.log('   ⚠️ Visual buttons missed. Firing global keyboard hotkey fallback (Ctrl + Enter)...');
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  
  // Give it an extra moment to process the submit
  await sleep(4000);
  return true; 
}

// ─── BACKGROUND POSTER ───
async function runPoster() {
  posterRunning = true;
  const session = currentSession;
  console.log(`\n🚀 Auto-poster started: ${session.groups.length} groups`);

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.setViewport({ width: 1280, height: 800 });

    const cookies = loadCookies();
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log(`🍪 ${cookies.length} cookies loaded`);
    } else {
      console.error('❌ No cookies found at /tmp/fb-cookies.json');
    }

    await page.goto('https://www.facebook.com', { waitUntil: 'networkidle2' });
    await sleep(3000);

    const pageTitle = await page.title();
    const pageUrl = page.url();
    console.log(`📄 ${pageTitle} | ${pageUrl}`);

    const isLoggedIn = await page.evaluate(() =>
      !document.querySelector('[data-testid="royal_login_form"]') &&
      !document.querySelector('#loginform')
    );

    if (!isLoggedIn) {
      console.error('❌ Not logged into Facebook — cookies not working');
      session.groups.forEach(g => g.postStatus = 'failed');
      session.error = 'Not logged into Facebook. Re-send cookies via /save-cookies.';
      posterRunning = false;
      await browser.close();
      return;
    }

    console.log('✅ Logged into Facebook');

    const pending = session.groups.filter(g => g.postStatus === 'pending' && g.link);

    for (let i = 0; i < pending.length; i++) {
      if (session.stopped) { console.log('⛔ Stopped by user'); break; }

      const group = pending[i];
      console.log(`\n[${i+1}/${pending.length}] → ${group.name}`);

      try {
        await page.goto(group.link, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(4000 + rand(0, 2000));

        // Log page after navigation
        const gTitle = await page.title();
        const gUrl = page.url();
        console.log(`  📄 ${gTitle} | ${gUrl}`);

        const composerOpened = await openComposer(page);
        if (!composerOpened) throw new Error('Could not open post composer');
        await sleep(2000);

        await page.keyboard.type(session.caption, { delay: rand(30, 80) });
        await sleep(1500);

        if (session.imagePaths.length > 0) {
          await uploadImages(page, session.imagePaths);
          await sleep(5000); // Increased wait time to let watch images fully encode/render
        }

        const posted = await clickPost(page);
        if (!posted) throw new Error('Could not click Post button');

        await sleep(5000);
        group.postStatus = 'done';
        session.progress.done++;
        console.log(`  ✅ Posted!`);

        // Refresh cookies after successful post
        const updatedCookies = await page.cookies();
        fs.writeFileSync('/tmp/fb-cookies.json', JSON.stringify(updatedCookies));

        if (i < pending.length - 1) {
          const wait = 1 * 60 * 1000 + rand(0, 60000);
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

// ─── SAVE COOKIES ───
app.post('/save-cookies', (req, res) => {
  const { cookies, secret } = req.body;
  if (secret !== process.env.SECRET_KEY) return res.status(403).json({ error: 'Forbidden' });
  fs.writeFileSync('/tmp/fb-cookies.json', JSON.stringify(cookies));
  res.json({ ok: true, count: cookies.length });
});

// ─── DEBUG: Check login status ───
app.get('/check-login', async (req, res) => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const cookies = loadCookies();
    if (cookies.length > 0) await page.setCookie(...cookies);

    await page.goto('https://www.facebook.com', { waitUntil: 'networkidle2' });
    await sleep(3000);

    const result = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      hasLoginForm: !!document.querySelector('#loginform') || !!document.querySelector('[data-testid=\"royal_login_form\"]'),
      hasProfileLink: !!document.querySelector('[aria-label=\"Your profile\"]'),
      cookieNames: document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean)
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`\n🟢 Watch Auto-Poster running on port ${PORT}`);
  console.log(`   Set SECRET_KEY env var to protect your /save-cookies endpoint\n`);
});
