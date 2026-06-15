const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { TOTP, Secret } = require('otpauth');
const fs   = require('fs');
const path = require('path');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function genTotp(key) {
  if (!key) return null;
  try {
    return new TOTP({ secret: Secret.fromBase32(key.toUpperCase().replace(/\s/g,'')), digits: 6, period: 30 }).generate();
  } catch (_) {
    try { return new TOTP({ secret: key, digits: 6, period: 30 }).generate(); } catch (__) { return null; }
  }
}

function dedup(list) {
  const seen = new Set();
  return list.filter(p => {
    const k = (p.title + p.value).toLowerCase().replace(/\s/g, '');
    return seen.has(k) ? false : seen.add(k);
  });
}

// Scrape les promos depuis le DOM de la page promotions
async function scrapePromosDom(page) {
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();
    const discountRe = /[-−]\s*\d+[.,]?\d*\s*€|\d+[.,]?\d*\s*€\s*(de\s*(r[ée]duction|remise))/i;
    const dateRe = /(\d{1,2}\s+\w+\s+\d{4})/;
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length > 0) return;
      const text = (el.textContent || '').trim();
      if (text.length < 2 || text.length > 60) return;
      const m = text.match(discountRe);
      if (!m) return;
      const key = text.toLowerCase().replace(/\s/g, '');
      if (seen.has(key)) return; seen.add(key);
      const card = el.closest('[role="dialog"],article,li,section') || el.parentElement?.parentElement;
      const full = card ? (card.textContent || '').trim() : text;
      const dateM = full.match(dateRe);
      results.push({ type: 'offer', title: text, value: m[0].trim(), expiresAt: dateM ? dateM[1] : '' });
    });
    return results;
  });
}

async function checkAccount(email, password, totpKey, cookies) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
    timeout: 60000
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });

  const capturedPromos = [];
  const capturedEps    = [];

  // Intercepter les réponses API pour capturer les promos
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!url.includes('/_p/api/')) return;
    try {
      const body = await resp.json().catch(() => null);
      if (!body?.data) return;
      const ep = url.split('/_p/api/')[1]?.split('?')[0] || '';
      capturedEps.push(ep);
      const d = body.data;
      // Log structure pour diagnostic
      const dKeys = Object.keys(d || {});
      if (dKeys.length) console.log(`  [${ep}] keys: ${dKeys.slice(0,8).join(', ')}`);
      const fields = ['offers','activeOffers','vouchers','coupons','promotions','items',
                      'rewards','userOffers','eatsOffers','discounts','userRewards',
                      'promos','deals','incentives','eatsPromotions','userPromotions',
                      'eaterOffers','eaterPromotions','memberOffers','specialOffers',
                      'promotionFeed','offerFeed','incentiveFeed','userIncentives'];
      for (const f of fields) {
        if (!Array.isArray(d[f]) || !d[f].length) continue;
        for (const it of d[f]) {
          const title = it.title || it.name || it.heading || it.code || it.headerText;
          if (!title) continue;
          capturedPromos.push({
            type: 'offer', title,
            value: it.discount?.formattedValue || it.subtitleText || it.formattedDiscount
                   || it.formattedAmount || it.description || '',
            expiresAt: it.expiresAt || it.expiry || it.validUntil || it.endDate || ''
          });
        }
      }
      const bal = d.walletBalance || d.balance || d.uberCash;
      if (bal && typeof bal.amount === 'number' && bal.amount > 0) {
        capturedPromos.push({
          type: 'credit', title: 'Uber Cash',
          value: bal.formattedAmount || `${(bal.amount/100).toFixed(2)} €`,
          expiresAt: ''
        });
      }
    } catch (_) {}
  });

  const debugDir = path.join(__dirname, '..', 'debug');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
  const prefix = email.split('@')[0];
  const shot = async (name) => {
    try { await page.screenshot({ path: path.join(debugDir, `${prefix}_${name}.png`), fullPage: true }); } catch (_) {}
  };

  try {
    // =====================================================================
    // MODE A : Cookie injection (bypass login)
    // =====================================================================
    if (cookies && cookies.length > 0) {
      // CF base cookies d'abord
      if (process.env.CF_BASE_COOKIES) {
        try {
          const cfRaw = process.env.CF_BASE_COOKIES.replace(/^﻿/, '').trim();
          for (const c of JSON.parse(cfRaw)) await page.setCookie(c).catch(() => {});
        } catch (_) {}
      }
      console.log(`  Mode cookies: injection de ${cookies.length} cookie(s)`);
      for (const c of cookies) {
        await page.setCookie({
          name: c.name,
          value: c.value,
          domain: c.domain || '.ubereats.com',
          path: c.path || '/',
          httpOnly: !!c.httpOnly,
          secure: c.secure !== false,
          sameSite: c.sameSite || 'None'
        }).catch(e => console.log(`  setCookie error: ${c.name} - ${e.message}`));
      }
      await page.goto('https://www.ubereats.com/fr/promotions', { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(8000);
      await shot('promos_cookie_mode');
      const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 200) || '').catch(() => '');
      const loggedIn = !pageText.includes('Inscription') && !pageText.includes('Connexion');
      console.log(`  Connecté: ${loggedIn ? 'OUI' : 'NON'}`);
      if (!loggedIn) console.log(`  Page: ${pageText.replace(/\n/g,' ').substring(0, 100)}`);
    }

    // =====================================================================
    // MODE B : Login automatique (email + mot de passe + TOTP)
    // =====================================================================
    else {
      if (!password) throw new Error('Ni cookies ni password fournis');

      // Injecter cookies Cloudflare/device avant login (bypasse le bot-check CDN)
      if (process.env.CF_BASE_COOKIES) {
        try {
          const cfRaw = process.env.CF_BASE_COOKIES.replace(/^﻿/, '').trim();
          const base = JSON.parse(cfRaw);
          for (const c of base) await page.setCookie(c).catch(() => {});
          console.log(`  CF cookies injectés: ${base.length}`);
        } catch (e) { console.log(`  CF_BASE_COOKIES erreur: ${e.message}`); }
      }

      const logPage = async (step) => {
        const url = page.url();
        const btns = await page.evaluate(() =>
          [...document.querySelectorAll('button,[role="button"]')].map(b => b.textContent?.trim()).filter(t => t && t.length < 60)
        ).catch(() => []);
        const inputs = await page.evaluate(() =>
          [...document.querySelectorAll('input')].map(i => `${i.type}[name=${i.name}][id=${i.id}]`)
        ).catch(() => []);
        console.log(`  [${step}] URL: ${url}`);
        console.log(`  [${step}] Inputs: ${inputs.slice(0,5).join(' | ')}`);
        console.log(`  [${step}] Buttons: ${btns.slice(0,5).join(' | ')}`);
      };

      const authUrl = 'https://auth.uber.com/v2/?next_url=https%3A%2F%2Fwww.ubereats.com%2Ffr%2Fpromotions&locale=fr-FR';
      await page.goto(authUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(2000);
      await shot('1_auth_page');

      // Email
      const emailSelectors = ['input[type="email"]','input[name="email"]','input[autocomplete="email"]',
                               'input[autocomplete="username"]','input[id*="email"]'];
      let emailInput = null;
      for (const sel of emailSelectors) {
        emailInput = await page.$(sel);
        if (emailInput) { console.log(`  Email input: ${sel}`); break; }
      }
      if (!emailInput) {
        emailInput = await page.evaluateHandle(() =>
          [...document.querySelectorAll('input')].find(i => i.offsetParent !== null && i.type !== 'hidden' && i.type !== 'submit') || null
        );
        const isNull = await page.evaluate(el => el === null, emailInput);
        if (isNull) throw new Error(`Champ email introuvable (URL: ${page.url()})`);
      }
      await emailInput.click({ clickCount: 3 });
      await emailInput.type(email, { delay: 50 });
      await page.keyboard.press('Enter');
      console.log('  Email soumis');

      await page.waitForFunction(() => {
        const hasPwd = !!document.querySelector('input[type="password"]');
        const hasChoice = [...document.querySelectorAll('button,[role="button"]')].some(b =>
          /mot de passe|password|magic link/i.test(b.textContent || '')
        );
        return hasPwd || hasChoice || !document.querySelector('input[type="email"]');
      }, { timeout: 15000 }).catch(() => {});
      await sleep(1500);
      await shot('2_after_email');

      // OTP email → "More options"
      const hasOTP = await page.evaluate(() => !!document.querySelector('[id*="EMAIL_OTP"], [id*="OTP_CODE"]'));
      if (hasOTP) {
        const clicked = await page.evaluateHandle(() =>
          [...document.querySelectorAll('button')].find(b => /more options|plus d.options|autres options/i.test(b.textContent || ''))
        );
        const box = await clicked.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          console.log('  Clic "More options"');
        }
        await sleep(2500);
        await shot('3_after_more_options');
      }

      // Bouton "Password"
      const pwdBtn = await page.evaluateHandle(() => {
        return [...document.querySelectorAll('button,[role="button"]')].find(el => {
          const t = (el.textContent || '').trim().toLowerCase();
          return (t === 'password' || t === 'login with password' || t === 'use password'
                  || t === 'sign in with password' || t === 'mot de passe') && el.children.length < 5;
        }) || null;
      });
      const pwdBtnBox = await pwdBtn.boundingBox().catch(() => null);
      if (pwdBtnBox) {
        await page.mouse.click(pwdBtnBox.x + pwdBtnBox.width / 2, pwdBtnBox.y + pwdBtnBox.height / 2);
        await sleep(2500);
        await shot('4_after_pwd_choice');
      }

      await page.waitForFunction(() => !!document.querySelector('input[type="password"]'), { timeout: 12000 }).catch(() => {});
      await sleep(500);

      // Email pre-fill
      const emailFieldOnPwd = await page.$('input[type="email"], input[name="email"], input[id="username"]');
      if (emailFieldOnPwd) {
        const currentVal = await page.evaluate(el => el.value, emailFieldOnPwd);
        if (!currentVal || currentVal.trim() === '') {
          await emailFieldOnPwd.click({ clickCount: 3 });
          await emailFieldOnPwd.type(email, { delay: 40 });
          await sleep(300);
        } else {
          console.log(`  Email déjà rempli: ${currentVal.substring(0, 20)}...`);
        }
      }

      // Password
      const pwdSelectors = ['input[type="password"]','input[name="password"]',
                             'input[autocomplete="current-password"]','input[id*="password"]','input[id="PASSWORD"]'];
      let pwdInput = null;
      for (const sel of pwdSelectors) {
        pwdInput = await page.$(sel);
        if (pwdInput) { console.log(`  Password input: ${sel}`); break; }
      }
      if (!pwdInput) throw new Error(`Champ mot de passe introuvable (URL: ${page.url()})`);

      try {
        await pwdInput.click({ clickCount: 3 });
        await pwdInput.type(password, { delay: 50 });
      } catch (_) {
        await page.keyboard.type(password, { delay: 50 }).catch(() => {});
      }
      await sleep(300);
      await page.keyboard.press('Enter').catch(() => {});
      console.log('  Mot de passe soumis');
      await page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(2000);
      await shot('5_after_login');

      // TOTP
      if (totpKey) {
        try {
          const hasTOTP = await page.evaluate(() =>
            document.querySelector('input[maxlength="1"], input[maxlength="6"], input[inputmode="numeric"]') !== null
          ).catch(() => false);
          if (hasTOTP) {
            const code = genTotp(totpKey);
            if (code) {
              console.log(`  Code TOTP: ${code}`);
              try {
                const singles = await page.$$('input[maxlength="1"]');
                if (singles.length >= 6) {
                  for (let i = 0; i < 6; i++) await singles[i].type(code[i], { delay: 80 });
                } else {
                  const inp = await page.$('input[maxlength="6"], input[inputmode="numeric"]');
                  if (inp) { await inp.click({ clickCount: 3 }); await inp.type(code, { delay: 80 }); }
                }
              } catch (e) { console.log(`  TOTP input error: ${e.message}`); }
              await sleep(800);
              try {
                await Promise.all([
                  page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }),
                  page.evaluate(() => {
                    const btn = document.querySelector('button[type="submit"]') ||
                                [...document.querySelectorAll('button')].find(b => /next|suivant|continuer/i.test(b.textContent));
                    if (btn) btn.click();
                  })
                ]);
              } catch (_) {}
              console.log(`  URL apres TOTP: ${page.url()}`);
            }
          }
        } catch (e) { console.log(`  TOTP error: ${e.message}`); }
      }

      // Attendre ubereats.com
      await page.waitForFunction(() => window.location.hostname.includes('ubereats.com'), { timeout: 20000 }).catch(() => {});
      await Promise.race([
        page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null),
        page.waitForNetworkIdle({ timeout: 15000, idleTime: 2000 }).catch(() => null)
      ]).catch(() => null);
      await sleep(2000);
      console.log(`  URL après auth: ${page.url()}`);

      // Naviguer vers la page promos propre
      await page.goto('https://www.ubereats.com/fr/promotions', { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(5000);
      await shot('6_promos_page');
      const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 200) || '').catch(() => '');
      const loggedIn = !pageText.includes('Inscription') && !pageText.includes('Connexion');
      console.log(`  Connecté: ${loggedIn ? 'OUI' : 'NON'}`);
    }

    // =====================================================================
    // Scraping des promos (commun aux deux modes)
    // =====================================================================
    const domPromos = await scrapePromosDom(page);
    const allPromos = dedup([...capturedPromos, ...domPromos]);
    console.log(`  API (${capturedEps.length} ep): ${capturedPromos.length} | DOM: ${domPromos.length} | Total: ${allPromos.length}`);

    await browser.close();
    return { ok: true, promos: allPromos, checkedAt: new Date().toISOString() };

  } catch (err) {
    console.error(`  Erreur: ${err.message}`);
    try { await browser.close(); } catch (_) {}
    return { ok: false, promos: [], error: err.message, checkedAt: new Date().toISOString() };
  }
}

async function main() {
  const raw = process.env.ACCOUNTS_JSON;
  if (!raw) { console.error('ACCOUNTS_JSON non défini'); process.exit(1); }

  let accounts;
  try { accounts = JSON.parse(raw); }
  catch (e) { console.error('ACCOUNTS_JSON invalide:', e.message); process.exit(1); }

  if (!Array.isArray(accounts) || accounts.length === 0) {
    console.error('ACCOUNTS_JSON doit être un tableau non vide'); process.exit(1);
  }

  // Merger les cookies depuis COOKIES_JSON (par email)
  if (process.env.COOKIES_JSON) {
    try {
      const cRaw = process.env.COOKIES_JSON.replace(/^﻿/, '').trim();
      const cookiesMap = JSON.parse(cRaw);
      for (const acc of accounts) {
        if (!acc.cookies && cookiesMap[acc.email]) {
          acc.cookies = cookiesMap[acc.email];
          console.log(`  Cookies depuis COOKIES_JSON: ${acc.email}`);
        }
      }
    } catch (e) { console.log(`COOKIES_JSON erreur: ${e.message}`); }
  }

  console.log(`Vérification de ${accounts.length} compte(s)...\n`);
  const results = {};

  for (const acc of accounts) {
    if (!acc.email) { console.log('Compte ignoré (email manquant)'); continue; }
    if (!acc.cookies && !acc.password) { console.log(`Compte ignoré: ${acc.email} (ni cookies ni password)`); continue; }
    console.log(`[${acc.email}]`);
    results[acc.email] = await checkAccount(acc.email, acc.password || null, acc.totpKey || null, acc.cookies || null);
    console.log(`  -> ${results[acc.email].promos.length} promo(s)\n`);
    await sleep(3000);
  }

  const out = path.join(__dirname, '..', 'promos.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2), 'utf8');
  console.log(`Résultats écrits dans promos.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
