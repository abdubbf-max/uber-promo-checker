const puppeteer = require('puppeteer');
const { TOTP, Secret } = require('otpauth');
const fs   = require('fs');
const path = require('path');

// ── Helpers ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function genTotp(key) {
  if (!key) return null;
  try {
    return new TOTP({ secret: Secret.fromBase32(key.toUpperCase().replace(/\s/g,'')), digits: 6, period: 30 }).generate();
  } catch (_) {
    try { return new TOTP({ secret: key, digits: 6, period: 30 }).generate(); }
    catch (__) { return null; }
  }
}

function dedup(list) {
  const seen = new Set();
  return list.filter(p => {
    const k = (p.title + p.value).toLowerCase().replace(/\s/g, '');
    return seen.has(k) ? false : seen.add(k);
  });
}

// ── Login + scrape promotions for one account ──────────────────────────────
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

  // Intercept TOUTES les réponses /_p/api/ (comme notre hook fetch, mais natif Puppeteer)
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
            type: 'offer',
            title,
            value: it.discount?.formattedValue || it.subtitleText || it.formattedDiscount
                   || it.formattedAmount || it.description || '',
            expiresAt: it.expiresAt || it.expiry || it.validUntil || it.endDate || ''
          });
        }
      }
      // Uber Cash
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
    // ── Étape 1 : Accueil UberEats ──────────────────────────────────────────
    await page.goto('https://www.ubereats.com/fr/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);

    // ── Étape 2 : Ouvrir la modale de connexion ─────────────────────────────
    const opened = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('a,button,[role="button"]')];
      const btn = candidates.find(e => /se connecter|sign in|login|connexion/i.test((e.textContent||'').trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (opened) await sleep(2000);

    // ── Étape 3 : Saisir email ──────────────────────────────────────────────
    let emailInput = await page.$('input[type="email"], input[autocomplete="email"], input[name="email"]');
    if (!emailInput) {
      // Fallback : aller directement sur auth.uber.com
      await page.goto('https://auth.uber.com/v2/?next_url=https%3A%2F%2Fwww.ubereats.com%2Ffr%2F', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(1500);
      emailInput = await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 8000 }).catch(() => null);
    }
    if (!emailInput) throw new Error('Champ email introuvable');
    await emailInput.click({ clickCount: 3 }); await emailInput.type(email, { delay: 40 });

    // Soumettre
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(b => /continuer|suivant|next|continue/i.test(b.textContent));
      if (b) b.click(); else document.querySelector('button[type="submit"]')?.click();
    });
    await sleep(2500);

    // ── Étape 4 : Saisir mot de passe ──────────────────────────────────────
    const pwdInput = await page.waitForSelector('input[type="password"]', { timeout: 10000 }).catch(() => null);
    if (!pwdInput) throw new Error('Champ mot de passe introuvable');
    await pwdInput.click({ clickCount: 3 }); await pwdInput.type(password, { delay: 40 });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(b => /continuer|suivant|next|continue/i.test(b.textContent));
      if (b) b.click(); else document.querySelector('button[type="submit"]')?.click();
    });
    await sleep(3500);

    // ── Étape 5 : TOTP si nécessaire ────────────────────────────────────────
    if (totpKey) {
      const code = genTotp(totpKey);
      if (code) {
        const singles = await page.$$('input[maxlength="1"]');
        if (singles.length >= 6) {
          for (let i = 0; i < 6; i++) await singles[i].type(code[i], { delay: 60 });
        } else {
          const inp = await page.$('input[maxlength="6"], input[inputmode="numeric"][type="tel"], input[inputmode="numeric"][type="text"]');
          if (inp) { await inp.click({ clickCount: 3 }); await inp.type(code, { delay: 60 }); }
        }
        await sleep(2000);
        await page.evaluate(() => document.querySelector('button[type="submit"]')?.click());
        await sleep(3000);
      }
    }

    // ── Étape 6 : Attendre le retour sur ubereats.com ──────────────────────
    await page.waitForFunction(
      () => window.location.hostname.includes('ubereats.com') && !window.location.hostname.includes('auth.uber'),
      { timeout: 15000 }
    ).catch(() => {});
    console.log(`  URL apres login: ${page.url()}`);

    // ── Étape 7 : Page promotions (déclenche les appels API promo) ──────────
    await page.goto('https://www.ubereats.com/fr/promotions', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(5000);

    // ── Étape 8 : Scraping DOM (backup) ─────────────────────────────────────
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
    console.log(`  API (${capturedEps.length} endpoints): ${capturedPromos.length} | DOM: ${domPromos.length} | Total: ${allPromos.length}`);

    await browser.close();
    return { ok: true, promos: allPromos, checkedAt: new Date().toISOString() };

  } catch (err) {
    console.error(`  Erreur: ${err.message}`);
    try { await browser.close(); } catch (_) {}
    return { ok: false, promos: [], error: err.message, checkedAt: new Date().toISOString() };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
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
