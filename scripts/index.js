const puppeteer = require('puppeteer');
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

async function clickContinue(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(b => /continuer|suivant|next|continue/i.test((b.textContent||'').trim()))
           || document.querySelector('button[type="submit"]');
    if (b) { b.click(); return true; }
    return false;
  });
}

async function checkAccount(email, password, totpKey) {
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

  page.on('response', async (resp) => {
    const url = resp.url();
    if (!url.includes('/_p/api/')) return;
    try {
      const body = await resp.json().catch(() => null);
      if (!body?.data) return;
      const ep = url.split('/_p/api/')[1]?.split('?')[0] || '';
      capturedEps.push(ep);
      const d = body.data;
      const fields = ['offers','activeOffers','vouchers','coupons','promotions','items',
                      'rewards','userOffers','eatsOffers','discounts','userRewards',
                      'promos','deals','incentives','eatsPromotions','userPromotions'];
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

  try {
    const debugDir = path.join(__dirname, '..', 'debug');
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
    const shot = async (name) => {
      try {
        await page.screenshot({ path: path.join(debugDir, `${email.split('@')[0]}_${name}.png`), fullPage: true });
      } catch (_) {}
    };
    const logPage = async (step) => {
      const url = page.url();
      const btns = await page.evaluate(() =>
        [...document.querySelectorAll('button,[role="button"]')].map(b => b.textContent?.trim()).filter(t => t && t.length < 60)
      );
      const inputs = await page.evaluate(() =>
        [...document.querySelectorAll('input')].map(i => `${i.type}[name=${i.name}][id=${i.id}]`)
      );
      console.log(`  [${step}] URL: ${url}`);
      console.log(`  [${step}] Inputs: ${inputs.slice(0,5).join(' | ')}`);
      console.log(`  [${step}] Buttons: ${btns.slice(0,5).join(' | ')}`);
    };

    // Aller directement sur auth.uber.com (plus fiable que passer par ubereats.com)
    const authUrl = 'https://auth.uber.com/v2/?next_url=https%3A%2F%2Fwww.ubereats.com%2Ffr%2Fpromotions&locale=fr-FR';
    console.log(`  -> ${authUrl}`);
    await page.goto(authUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);
    await shot('1_auth_page');
    await logPage('1-auth');

    // Étape email
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[autocomplete="username"]',
      'input[id*="email"]',
    ];
    let emailInput = null;
    for (const sel of emailSelectors) {
      emailInput = await page.$(sel);
      if (emailInput) { console.log(`  Email input: ${sel}`); break; }
    }
    if (!emailInput) {
      // Chercher n'importe quel input visible
      emailInput = await page.evaluateHandle(() => {
        return [...document.querySelectorAll('input')].find(i =>
          i.offsetParent !== null && i.type !== 'hidden' && i.type !== 'submit'
        ) || null;
      });
      const isNull = await page.evaluate(el => el === null, emailInput);
      if (isNull) throw new Error(`Champ email introuvable (URL: ${page.url()})`);
      console.log('  Email input: fallback (premier input visible)');
    }

    await emailInput.click({ clickCount: 3 });
    await emailInput.type(email, { delay: 50 });
    await sleep(300);

    // Soumettre via Enter (plus fiable sur les SPA React que cliquer un bouton)
    await page.keyboard.press('Enter');
    console.log('  Email soumis (Enter), attente DOM...');

    // Attendre que quelque chose change : champ password OU boutons de choix de méthode
    await page.waitForFunction(() => {
      const hasPwd = !!document.querySelector('input[type="password"]');
      const hasChoice = [...document.querySelectorAll('button,[role="button"]')].some(b =>
        /mot de passe|password|magic link|continuer avec/i.test(b.textContent || '')
      );
      const emailGone = !document.querySelector('input[type="email"]');
      return hasPwd || hasChoice || emailGone;
    }, { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    await shot('2_after_email');
    await logPage('2-after-email');

    // Uber affiche une page OTP email → cliquer "More options" via coordonnées réelles
    const hasOTP = await page.evaluate(() =>
      !!document.querySelector('[id*="EMAIL_OTP"], [id*="OTP_CODE"]')
    );
    if (hasOTP) {
      console.log('  Page OTP email détectée -> clic "More options" (coordonnées)');
      const clicked = await page.evaluateHandle(() =>
        [...document.querySelectorAll('button')].find(b =>
          /more options|plus d.options|autres options/i.test(b.textContent || '')
        )
      );
      const box = await clicked.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        console.log(`  Clic coordonnées: (${Math.round(box.x + box.width/2)}, ${Math.round(box.y + box.height/2)})`);
      } else {
        console.log('  BoundingBox null, tentative tap clavier Tab+Enter');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
      }
      await sleep(2500);
      await shot('3_after_more_options');
      await logPage('3-after-more-options');
    }

    // Chercher le bouton "Password" exact (pas un conteneur) dans le menu ouvert
    const clickPwdBtn = async () => {
      return page.evaluateHandle(() => {
        const btns = [...document.querySelectorAll('button,[role="button"]')];
        // Chercher un bouton dont le texte est EXACTEMENT "password" ou "login with password"
        return btns.find(el => {
          const t = (el.textContent || '').trim().toLowerCase();
          return (t === 'password' || t === 'login with password' || t === 'use password'
                  || t === 'sign in with password' || t === 'mot de passe')
                 && el.children.length < 5; // pas un conteneur
        }) || null;
      });
    };

    let pwdBtn = await clickPwdBtn();
    let pwdBtnBox = await pwdBtn.boundingBox().catch(() => null);
    if (pwdBtnBox) {
      const label = await page.evaluate(el => el?.textContent?.trim(), pwdBtn);
      console.log(`  Bouton password exact: "${label}"`);
      await page.mouse.click(pwdBtnBox.x + pwdBtnBox.width / 2, pwdBtnBox.y + pwdBtnBox.height / 2);
      await sleep(2500);
      await shot('4_after_pwd_choice');
      await logPage('4-after-pwd-choice');
    } else {
      console.log('  Aucun bouton password exact trouvé');
    }

    // Attendre le champ mot de passe
    await page.waitForFunction(
      () => !!document.querySelector('input[type="password"]'),
      { timeout: 12000 }
    ).catch(() => {});
    await sleep(500);

    // Étape mot de passe — le formulaire peut avoir un champ email + password
    // S'assurer que le champ email est rempli
    const emailFieldOnPwd = await page.$('input[type="email"], input[name="email"], input[id="username"]');
    if (emailFieldOnPwd) {
      const currentVal = await page.evaluate(el => el.value, emailFieldOnPwd);
      if (!currentVal || currentVal.trim() === '') {
        console.log('  Email vide sur formulaire password -> remplissage');
        await emailFieldOnPwd.click({ clickCount: 3 });
        await emailFieldOnPwd.type(email, { delay: 40 });
        await sleep(300);
      } else {
        console.log(`  Email déjà rempli: ${currentVal.substring(0, 20)}...`);
      }
    }

    const pwdSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
      'input[id*="password"]',
      'input[id="PASSWORD"]',
    ];
    let pwdInput = null;
    for (const sel of pwdSelectors) {
      pwdInput = await page.$(sel);
      if (pwdInput) { console.log(`  Password input: ${sel}`); break; }
    }
    if (!pwdInput) throw new Error(`Champ mot de passe introuvable (URL: ${page.url()})`);

    // Taper le mot de passe — la navigation peut détruire le contexte, c'est normal
    try {
      await pwdInput.click({ clickCount: 3 });
      await pwdInput.type(password, { delay: 50 });
    } catch (_) {
      // Si le contexte est détruit pendant la frappe, tenter via clavier global
      await page.keyboard.type(password, { delay: 50 }).catch(() => {});
    }
    await sleep(300);
    await page.keyboard.press('Enter').catch(() => {});
    console.log('  Mot de passe soumis, attente navigation...');

    // Attendre la navigation (login réussi = Uber redirige vers ubereats.com)
    await page.waitForNavigation({ timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(2000);
    await shot('5_after_login').catch(() => {});

    // Étape TOTP si nécessaire
    if (totpKey) {
      const hasTOTP = await page.evaluate(() =>
        document.querySelector('input[maxlength="1"], input[maxlength="6"], input[inputmode="numeric"]') !== null
      );
      if (hasTOTP) {
        console.log('  TOTP détecté');
        const code = genTotp(totpKey);
        if (code) {
          const singles = await page.$$('input[maxlength="1"]');
          if (singles.length >= 6) {
            for (let i = 0; i < 6; i++) await singles[i].type(code[i], { delay: 80 });
          } else {
            const inp = await page.$('input[maxlength="6"], input[inputmode="numeric"]');
            if (inp) { await inp.click({ clickCount: 3 }); await inp.type(code, { delay: 80 }); }
          }
          await sleep(1500);
          await page.evaluate(() => document.querySelector('button[type="submit"]')?.click());
          await sleep(4000);
          console.log(`  URL apres TOTP: ${page.url()}`);
        }
      }
    }

    // Attendre retour sur ubereats.com
    await page.waitForFunction(
      () => window.location.hostname.includes('ubereats.com'),
      { timeout: 20000 }
    ).catch(() => {});
    console.log(`  URL finale: ${page.url()}`);

    // Si pas encore sur ubereats, naviguer manuellement
    if (!page.url().includes('ubereats.com')) {
      await page.goto('https://www.ubereats.com/fr/promotions', { waitUntil: 'networkidle2', timeout: 30000 });
    } else if (!page.url().includes('/promotions')) {
      await page.goto('https://www.ubereats.com/fr/promotions', { waitUntil: 'networkidle2', timeout: 30000 });
    }
    await sleep(8000);
    await shot('6_promos_page');

    // Log page content for debug
    const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '').catch(() => '');
    console.log(`  Page content (500 chars): ${pageText.replace(/\n/g, ' ').substring(0, 300)}`);

    // Scraping DOM
    const domPromos = await page.evaluate(() => {
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

  console.log(`Vérification de ${accounts.length} compte(s)...\n`);
  const results = {};

  for (const acc of accounts) {
    if (!acc.email || !acc.password) { console.log(`Compte ignoré (email/password manquant)`); continue; }
    console.log(`[${acc.email}]`);
    results[acc.email] = await checkAccount(acc.email, acc.password, acc.totpKey || null);
    console.log(`  -> ${results[acc.email].promos.length} promo(s)\n`);
    await sleep(3000);
  }

  const out = path.join(__dirname, '..', 'promos.json');
  fs.writeFileSync(out, JSON.stringify(results, null, 2), 'utf8');
  console.log(`Résultats écrits dans promos.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
