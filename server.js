
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
  const clickByText = async labels => page.evaluate((wantedLabels) => {
    const normalize = text => (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const wanted = wantedLabels.map(normalize);
    const buttons = [...document.querySelectorAll('[role="button"], button, [aria-label]')];

    for (const button of buttons) {
      const text = normalize(button.textContent || button.getAttribute('aria-label') || '');
      const disabled = button.disabled || button.getAttribute('aria-disabled') === 'true';
      if (!disabled && wanted.includes(text)) {
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
    [...document.querySelectorAll('[role="button"], button, [aria-label]')]
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
