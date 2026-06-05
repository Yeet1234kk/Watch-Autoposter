/**
 * Watch Auto-Poster — Railway Server
 * Updated: supports auto-comments (2 slots, each with images + text)
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

let currentSession = null;
let posterRunning = false;

// ─── Multer: store all uploaded images in /tmp ───
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
      done: currentSession.progress.done,
      total: currentSession.progress.total,
      groups: currentSession.groups.map(g => ({
        id: g.id, name: g.name, status: g.postStatus
      }))
    } : null
  });
});

// ─── START POSTER ───
// Accepts: images[], comment1Images[], comment2Images[], caption, title, comment1Text, comment2Text, groups
app.post('/start-poster', upload.fields([
  { name: 'images', maxCount: 20 },
  { name: 'comment1Images', maxCount: 10 },
  { name: 'comment2Images', maxCount: 10 }
]), async (req, res) => {
  try {
    if (posterRunning) return res.status(409).json({ error: 'Already running. Stop first.' });

    const { caption, title, groups, comment1Text, comment2Text } = req.body;
    if (!caption && !(req.files['images'] && req.files['images'].length))
      return res.status(400).json({ error: 'Caption or images required' });

    const parsedGroups = JSON.parse(groups);
    const imagePaths      = (req.files['images']         || []).map(f => f.path);
    const comment1Images  = (req.files['comment1Images'] || []).map(f => f.path);
    const comment2Images  = (req.files['comment2Images'] || []).map(f => f.path);

    currentSession = {
      id: Date.now(),
      title:         title        || '',
      caption:       caption      || '',
      imagePaths,
      comment1: { text: comment1Text || '', images: comment1Images },
      comment2: { text: comment2Text || '', images: comment2Images },
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
    console.error('/start-poster error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── STOP ───
app.post('/stop-poster', (req, res) => {
  if (currentSession) currentSession.stopped = true;
  res.json({ ok: true });
});

// ─── HELPERS ───
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function loadCookies() {
  const cookiePath = '/tmp/fb-cookies.json';
  if (!fs.existsSync(cookiePath)) return [];
  const raw = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
  return raw.map(c => ({
    name: c.name, value: c.value,
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
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process']
  });
}

async function openComposer(page) {
  await sleep(3000);
  const selectors = [
    '[aria-label="Write something to the group…"]',
    '[aria-label="Write something to the group..."]',
    '[aria-label="Write something..."]',
    '[aria-label="Create a public post…"]',
    '[aria-label="Create a public post..."]',
    '[aria-label="What\'s on your mind?"]',
    '[data-testid="status-attachment-mentions-input"]',
    'div[contenteditable="true"]',
    '[role="textbox"]'
  ];
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 5000 });
      if (el) { await el.evaluate(e => e.scrollIntoView()); await sleep(500); await el.click(); await sleep(1000); return true; }
    } catch {}
  }
  const found = await page.evaluate(() => {
    const patterns = [/write something/i, /what.s on your mind/i, /create a post/i, /เขียนอะไรบางอย่าง/i];
    for (const el of [...document.querySelectorAll('[role="button"]'), ...document.querySelectorAll('div[tabindex]'), ...document.querySelectorAll('[placeholder]')]) {
      const text = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.textContent || '';
      if (patterns.some(p => p.test(text))) { el.click(); return true; }
    }
    return false;
  });
  if (found) { await sleep(2000); return true; }
  await page.screenshot({ path: '/tmp/composer-debug.png' });
  return false;
}

async function uploadImages(page, imagePaths) {
  const validPaths = imagePaths.filter(p => fs.existsSync(p));
  if (!validPaths.length) return;
  console.log(`  📸 Uploading ${validPaths.length} image(s)...`);

  // Click the photo/video button to reveal the file input
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

  if (!input) {
    console.error('    ❌ No file input found');
    return;
  }

  // Upload ALL images in one call — preserves exact order
  await input.uploadFile(...validPaths);
  console.log(`    📎 All ${validPaths.length} image(s) queued in order`);
  await sleep(4000); // wait for Facebook to process all uploads
  console.log(`  ✅ All ${validPaths.length} image(s) uploaded`);
}

async function clickPost(page) {
  const selectors = [
    'div[aria-label="Post"]','div[aria-label="โพสต์"]','button[type="submit"]',
    '[data-testid="react-composer-post-button"]','div[role="button"][tabindex="0"]'
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        const isOk = await btn.evaluate(el => {
          const text = (el.innerText || el.textContent || '').trim();
          return el.getAttribute('aria-label') === 'Post' || el.getAttribute('aria-label') === 'โพสต์' || text === 'Post' || text === 'โพสต์';
        });
        if (isOk) {
          const disabled = await btn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');
          if (!disabled) { await btn.click(); return true; }
        }
      }
    } catch {}
  }
  const clicked = await page.evaluate(() => {
    for (const el of document.querySelectorAll('div[role="button"], button, span, div')) {
      const text = (el.innerText || el.textContent || '').trim();
      if (['โพสต์','Post','ลงประกาศ','แชร์','Publish'].includes(text) && !el.disabled && el.getAttribute('aria-disabled') !== 'true') {
        el.click(); return text;
      }
    }
    return null;
  });
  if (clicked) return true;
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  await sleep(4000);
  return true;
}

// ─── POST A COMMENT (text + images) ───
async function postComment(page, commentText, commentImages, label) {
  console.log(`  💬 Posting ${label}...`);
  try {
    await sleep(4000);

    // Scroll to the bottom of the page to find the newly posted item
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);

    // Try to find the most recent post's comment box (last one on page)
    const commentSelectors = [
      '[aria-label="Write a comment…"]',
      '[aria-label="Write a comment..."]',
      '[aria-label="แสดงความคิดเห็น…"]',
      '[aria-label="แสดงความคิดเห็น..."]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'form[role="presentation"] div[contenteditable="true"]',
    ];

    let commentBox = null;

    // Try to get the LAST matching comment box (most recent post)
    for (const sel of commentSelectors) {
      try {
        const all = await page.$$(sel);
        if (all && all.length > 0) {
          commentBox = all[all.length - 1]; // last = newest post
          await commentBox.evaluate(el => el.scrollIntoView({ block: 'center' }));
          await sleep(500);
          await commentBox.click();
          await sleep(800);
          console.log(`    ✅ Comment box found via: ${sel}`);
          break;
        }
      } catch {}
    }

    // Fallback: find by placeholder/aria text
    if (!commentBox) {
      const found = await page.evaluate(() => {
        const patterns = [/write a comment/i, /แสดงความคิดเห็น/i, /comment/i];
        const all = [...document.querySelectorAll('[contenteditable="true"], [placeholder]')];
        for (let i = all.length - 1; i >= 0; i--) {
          const el = all[i];
          const txt = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
          if (patterns.some(p => p.test(txt))) { el.scrollIntoView({ block: 'center' }); el.click(); return true; }
        }
        return false;
      });
      if (!found) { console.error(`  ❌ ${label}: Could not find comment box`); return false; }
      await sleep(800);
    }

    // Upload images to the comment if any
    if (commentImages && commentImages.length > 0) {
      const validImages = commentImages.filter(p => fs.existsSync(p));
      if (validImages.length > 0) {
        const attachClicked = await page.evaluate(() => {
          const patterns = [/photo/i, /รูปภาพ/i, /image/i, /attach/i];
          for (const el of document.querySelectorAll('[role="button"], button, label')) {
            const txt = el.getAttribute('aria-label') || el.textContent || '';
            if (patterns.some(p => p.test(txt))) { el.click(); return true; }
          }
          return false;
        });

        if (attachClicked) {
          await sleep(1500);
          const imgInput = await page.$('input[type="file"]');
          if (imgInput) {
            // Upload all comment images in one call
            await imgInput.uploadFile(...validImages);
            await sleep(2000);
            console.log(`    📎 ${label} ${validImages.length} image(s) attached`);
          }
        } else {
          console.log(`  ⚠️ ${label}: No attach button found, skipping images`);
        }
        await sleep(1500);
      }
    }

    // Type comment text
    if (commentText && commentText.trim()) {
      await page.keyboard.type(commentText.trim(), { delay: rand(20, 60) });
      await sleep(800);
    }

    // Submit: try Enter first, then Ctrl+Enter as fallback
    await page.keyboard.press('Enter');
    await sleep(2000);

    // Check if the box still has content (Enter didn't submit) → try Ctrl+Enter
    const stillHasContent = await page.evaluate(() => {
      const el = document.activeElement;
      return el && el.textContent && el.textContent.trim().length > 0;
    });
    if (stillHasContent) {
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await sleep(2000);
    }

    console.log(`  ✅ ${label} posted!`);
    return true;

  } catch (err) {
    console.error(`  ❌ ${label} failed: ${err.message}`);
    return false;
  }
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

    const isLoggedIn = await page.evaluate(() =>
      !document.querySelector('[data-testid="royal_login_form"]') &&
      !document.querySelector('#loginform')
    );

    if (!isLoggedIn) {
      console.error('❌ Not logged into Facebook — cookies not working');
      session.groups.forEach(g => g.postStatus = 'failed');
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

        // ── Open composer & post ──
        const composerOpened = await openComposer(page);
        if (!composerOpened) throw new Error('Could not open post composer');
        await sleep(2000);

        // Re-click the contenteditable to guarantee focus before typing
        const focused = await page.evaluate(() => {
          const el = document.querySelector('[contenteditable="true"]');
          if (el) { el.focus(); el.click(); return true; }
          return false;
        });
        if (!focused) throw new Error('Could not focus composer');
        await sleep(500);

        await page.keyboard.type(session.caption, { delay: rand(30, 80) });
        await sleep(1500);

        if (session.imagePaths.length > 0) {
          await uploadImages(page, session.imagePaths);
          await sleep(5000);
        }

        const posted = await clickPost(page);
        if (!posted) throw new Error('Could not click Post button');

        await sleep(6000); // let post render before commenting
        group.postStatus = 'done';
        session.progress.done++;
        console.log(`  ✅ Post submitted!`);

        // ── Comment 1 ──
        const hasComment1 = session.comment1.text.trim() || session.comment1.images.length > 0;
        if (hasComment1) {
          await postComment(page, session.comment1.text, session.comment1.images, 'Comment 1');
          await sleep(2000);
        }

        // ── Comment 2 ──
        const hasComment2 = session.comment2.text.trim() || session.comment2.images.length > 0;
        if (hasComment2) {
          await postComment(page, session.comment2.text, session.comment2.images, 'Comment 2');
          await sleep(2000);
        }

        // Save refreshed cookies
        const updatedCookies = await page.cookies();
        fs.writeFileSync('/tmp/fb-cookies.json', JSON.stringify(updatedCookies));

        // Wait between groups (skip wait on last)
        if (i < pending.length - 1) {
          const wait = 1 * 60 * 1000 + rand(0, 60000);
          console.log(`  ⏳ Waiting ${Math.round(wait/60000)} min before next group...`);
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

// ─── DEBUG: Check login ───
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
      url: location.href, title: document.title,
      hasLoginForm: !!document.querySelector('#loginform') || !!document.querySelector('[data-testid="royal_login_form"]'),
      hasProfileLink: !!document.querySelector('[aria-label="Your profile"]'),
      cookieNames: document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean)
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { await browser.close(); }
});

app.listen(PORT, () => {
  console.log(`\n🟢 Watch Auto-Poster running on port ${PORT}`);
  console.log(`   Set SECRET_KEY env var to protect /save-cookies\n`);
});