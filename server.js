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

        // Re-click the post composer to guarantee focus before typing.
        const focused = await focusComposerEditor(page);
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
          await postComment(page, session.comment1.text, session.comment1.images, 'Comment 1', session.caption);
          await sleep(2000);
        }

        // ── Comment 2 ──
        const hasComment2 = session.comment2.text.trim() || session.comment2.images.length > 0;
        if (hasComment2) {
          await postComment(page, session.comment2.text, session.comment2.images, 'Comment 2', session.caption);
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
