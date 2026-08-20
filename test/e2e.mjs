/* Test de bout en bout multi-appareils.
   Chaque "téléphone" est un contexte navigateur isolé (stockage, session et
   client MQTT distincts) — c'est l'équivalent le plus proche d'appareils
   séparés qu'on puisse obtenir sur une seule machine. */
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787/';
// BROKER vide ⇒ l'application utilise ses brokers publics par défaut
const BROKER = process.env.BROKER === undefined ? 'ws://127.0.0.1:9001' : process.env.BROKER;
const url = (hash) => BROKER ? `${BASE}?broker=${encodeURIComponent(BROKER)}#${hash}` : `${BASE}#${hash}`;
console.log(`Cible : ${BASE}\nRelais : ${BROKER || '(brokers publics par défaut)'}`);

const NAMES = ['Marah', 'Léo', 'Chloé', 'Yanis', 'Emma', 'Tom', 'Inès', 'Hugo', 'Jade'];
const PHONE = { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const ko = (m) => { fail++; console.log('  \x1b[31m✗\x1b[0m ' + m); };
function check(cond, m) { cond ? ok(m) : ko(m); return cond; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function until(fn, { timeout = 15000, every = 60 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return Date.now() - t0;
    if (Date.now() - t0 > timeout) return -1;
    await sleep(every);
  }
}

const chemin = process.env.CHROME_PATH || '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  ...(fs.existsSync(chemin) ? { executablePath: chemin } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});

async function newDevice(label, viewport) {
  const ctx = await browser.newContext({ viewport: viewport ?? { width: 1440, height: 810 }, ...(viewport ? PHONE : {}) });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log(`  \x1b[31m[${label}] erreur JS:\x1b[0m ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') console.log(`  \x1b[33m[${label}] console:\x1b[0m ${m.text().slice(0, 160)}`); });
  return { ctx, page, label };
}

console.log('\n\x1b[1m═══ LE MARCHÉ NOIR DES GAGES — test multi-appareils ═══\x1b[0m\n');

// ─────────────────────────────────────────────── 1. Écran central
console.log('\x1b[1m1. Écran central : création de la vente\x1b[0m');
const tv = await newDevice('TV');
await tv.page.goto(url('setup'), { waitUntil: 'networkidle' });
const rows = await tv.page.locator('#names-list .name-input').count();
check(rows === 9, `formulaire prêt avec ${rows} champs de prénom`);
for (let i = 0; i < NAMES.length; i++) await tv.page.locator('#names-list .name-input').nth(i).fill(NAMES[i]);
await tv.page.click('#btn-open-room');
await tv.page.waitForSelector('#screen-tv.is-active', { timeout: 10000 });
const code = (await tv.page.textContent('#tv-code')).trim();
check(/^[A-Z0-9]{5}$/.test(code), `vente ouverte, code « ${code} »`);

await tv.page.waitForSelector('#modal-qr:not([hidden])', { timeout: 5000 });
const qrURL = (await tv.page.textContent('#qr-url')).trim();
check(qrURL.includes('#j/' + code), `QR code affiché → ${qrURL.slice(0, 70)}…`);
const qrPixels = await tv.page.evaluate(() => {
  const c = document.querySelector('#qr-canvas');
  return c && c.width > 0 ? c.width : 0;
});
check(qrPixels > 0, `QR code réellement dessiné (${qrPixels}px)`);
await tv.page.click('#btn-qr-close');

const tvStatus = await until(async () => (await tv.page.textContent('#tv-status')).includes('EN LIGNE'));
check(tvStatus >= 0, `écran central connecté au relais (${tvStatus} ms)`);

// ─────────────────────────────────────────────── 2. Les téléphones
console.log('\n\x1b[1m2. Huit téléphones rejoignent la vente\x1b[0m');
const phones = [];
for (let i = 1; i < NAMES.length; i++) {
  const d = await newDevice(NAMES[i], PHONE);
  await d.page.goto(url('j/' + code), { waitUntil: 'domcontentloaded' });
  phones.push({ ...d, name: NAMES[i] });
}
let joined = 0;
for (const p of phones) {
  const t = await until(async () => await p.page.locator(`#who-list button:text-is("${p.name}")`).count() > 0, { timeout: 20000 });
  if (t < 0) { ko(`${p.name} : la liste des prénoms n'est jamais arrivée`); continue; }
  await p.page.locator(`#who-list button:text-is("${p.name}")`).click();
  await p.page.waitForSelector('#screen-player.is-active', { timeout: 5000 });
  joined++;
}
check(joined === phones.length, `${joined}/${phones.length} téléphones ont reçu la liste et choisi leur prénom`);

const seen = await until(async () => {
  const t = await tv.page.textContent('#board');
  return NAMES.slice(1).every(n => t.includes('● ' + n));
}, { timeout: 20000 });
check(seen >= 0, `l'écran central voit les 8 joueurs connectés (${seen} ms)`);

// ─────────────────────────────────────────────── 3. Enchère + latence
console.log('\n\x1b[1m3. Enchère ouverte : propagation des mises\x1b[0m');
await tv.page.selectOption('#lot-select', { index: 0 });
await tv.page.click('#duration-group .chip[data-dur="60"]');
await tv.page.click('#btn-open-lot');
await tv.page.waitForSelector('#tv-live:not([hidden])');
const lotTitle = (await tv.page.textContent('#lot-title')).trim();
ok(`lot n°1 ouvert : « ${lotTitle.slice(0, 58)}… » (60 s)`);

const gotLot = await until(async () => {
  const r = await Promise.all(phones.map(async p => (await p.page.locator('#pl-live').isVisible())));
  return r.every(Boolean);
}, { timeout: 10000 });
check(gotLot >= 0, `les 8 téléphones affichent le lot (${gotLot} ms)`);

// une mise d'un côté doit remonter de l'autre
const leo = phones[0];
const t0 = Date.now();
await leo.page.click('#btn-bid1');
const lat1 = await until(async () => (await tv.page.textContent('#bidders')).includes('Léo · 1'), { timeout: 10000 });
check(lat1 >= 0, `un « +1 » sur le téléphone de Léo apparaît sur la TV en ${lat1} ms`);
const lat2 = await until(async () => (await tv.page.textContent('#leader-name')).trim() === 'Léo');
check(lat2 >= 0, `la TV désigne Léo comme meneur (${Date.now() - t0} ms au total)`);

// la TV redescend vers les autres téléphones
const chloe = phones[1];
const lat3 = await until(async () => (await chloe.page.textContent('#pl-best')).trim() === '1', { timeout: 10000 });
check(lat3 >= 0, `le téléphone de Chloé voit la meilleure offre de Léo (${lat3} ms)`);
check((await chloe.page.textContent('#pl-leader')).trim() === 'Léo', 'Chloé voit qui mène');

// +5
await chloe.page.click('#btn-bid5');
const lat4 = await until(async () => (await tv.page.textContent('#bidders')).includes('Chloé · 5'), { timeout: 10000 });
check(lat4 >= 0, `le raccourci « +5 » de Chloé remonte sur la TV (${lat4} ms)`);
const lat5 = await until(async () => (await leo.page.textContent('#pl-leader')).trim() === 'Chloé', { timeout: 10000 });
check(lat5 >= 0, `Léo voit qu'il s'est fait doubler (${lat5} ms)`);

// ─────────────────────────────────────────────── 4. Charge : 9 en même temps
console.log('\n\x1b[1m4. Charge : les 8 téléphones tapent en même temps\x1b[0m');
const TAPS = 20;
const before = { 'Léo': 1, 'Chloé': 5 };
const tStart = Date.now();
await Promise.all(phones.map(async (p) => {
  for (let i = 0; i < TAPS; i++) {
    await p.page.click('#btn-bid1', { delay: 0 });
    await sleep(25 + Math.random() * 45);
  }
}));
const spent = Date.now() - tStart;
const expected = Object.fromEntries(phones.map(p => [p.name, (before[p.name] || 0) + TAPS]));
const settle = await until(async () => {
  const t = await tv.page.textContent('#bidders');
  return Object.entries(expected).every(([n, v]) => t.includes(`${n} · ${v}`));
}, { timeout: 20000 });
check(settle >= 0,
  `${phones.length * TAPS} mises envoyées en ${spent} ms — la TV a le compte exact pour chacun (+${settle} ms)`);
if (settle < 0) console.log('    état TV : ' + (await tv.page.textContent('#bidders')));

const bestTv = (await tv.page.textContent('#best-amount')).trim();
const bestPhone = (await phones[3].page.textContent('#pl-best')).trim();
check(bestTv === bestPhone, `meilleure offre identique sur TV et téléphone (${bestTv} gorgées)`);
const mine = (await phones[0].page.textContent('#pl-mine')).trim();
check(mine === String(expected['Léo']), `Léo voit sa propre mise cumulée (${mine})`);

// ─────────────────────────────────────────────── 5. Coupure réseau
console.log('\n\x1b[1m5. Perte de connexion sur un téléphone\x1b[0m');
const yanis = phones[2];
await yanis.ctx.setOffline(true);
const banner = await until(async () => await yanis.page.locator('#pl-banner').isVisible(), { timeout: 20000 });
check(banner >= 0 && banner < 12000, `message d'erreur clair affiché hors ligne en ${banner} ms`);
check(!(await yanis.page.textContent('#pl-status')).includes('EN LIGNE'),
  'le voyant de connexion passe au rouge/orange (il ne ment pas sur l\'état)');
const offTxt = (await yanis.page.textContent('#pl-banner')).trim();
check(offTxt.length > 10, `texte affiché : « ${offTxt.slice(0, 60)}… »`);
await yanis.page.click('#btn-bid1');   // mise tapée pendant la coupure
await yanis.page.click('#btn-bid1');
await yanis.ctx.setOffline(false);
await yanis.page.evaluate(() => window.dispatchEvent(new Event('online')));
const back = await until(async () => (await yanis.page.textContent('#pl-status')).includes('EN LIGNE'), { timeout: 30000 });
check(back >= 0, `reconnexion automatique (${back} ms)`);
const recovered = await until(async () => (await tv.page.textContent('#bidders')).includes(`Yanis · ${expected['Yanis'] + 2}`), { timeout: 20000 });
check(recovered >= 0, `les 2 mises tapées hors ligne sont rattrapées par la TV (${recovered} ms)`);
if (recovered >= 0) expected['Yanis'] += 2;

// ─────────────────────────────────────────────── 6. Clôture et adjudication
console.log('\n\x1b[1m6. Clôture, adjudication et ardoises\x1b[0m');
const winner = Object.entries(expected).sort((a, b) => b[1] - a[1])[0];
await tv.page.click('#btn-close-lot');
const closed = await until(async () => await tv.page.locator('#btn-adjuge').isVisible(), { timeout: 10000 });
check(closed >= 0, `enchère clôturée manuellement, bouton « Adjugé » proposé (${closed} ms)`);
check(await tv.page.locator('#stamp').isVisible(), 'tampon « Adjugé » affiché sur la TV');
const tvWinner = (await tv.page.textContent('#leader-name')).trim();
check(tvWinner === winner[0], `gagnant annoncé : ${tvWinner} pour ${winner[1]} gorgées`);

const phoneClosed = await until(async () => await phones[0].page.locator('#pl-result').isVisible(), { timeout: 10000 });
check(phoneClosed >= 0, `les téléphones affichent le résultat (${phoneClosed} ms)`);
const bidsDisabled = await phones[0].page.locator('#btn-bid1').isDisabled();
check(bidsDisabled, 'le bouton « enchérir » est bien verrouillé après la clôture');

await tv.page.click('#btn-adjuge');
const boardUp = await until(async () => {
  const t = await tv.page.textContent('#board');
  return t.includes(winner[0]) && t.includes(String(winner[1]));
}, { timeout: 10000 });
check(boardUp >= 0, `ardoise de ${winner[0]} créditée de ${winner[1]} gorgées sur la TV (${boardUp} ms)`);
check((await tv.page.textContent('#history')).includes(winner[0]), 'le lot apparaît dans l\'historique');

const wp = phones.find(p => p.name === winner[0]);
if (wp) {
  const tabUp = await until(async () => (await wp.page.textContent('#me-tab')).trim() === String(winner[1]), { timeout: 10000 });
  check(tabUp >= 0, `${winner[0]} voit sa propre ardoise à ${winner[1]} sur son téléphone (${tabUp} ms)`);
}

// ─────────────────────────────────────────────── 7. Deuxième lot + gage libre
console.log('\n\x1b[1m7. Deuxième lot, gage personnalisé, minuteur automatique\x1b[0m');
await tv.page.fill('#lot-custom', 'Désigner qui doit porter la perruque de Jade pendant tout le dîner');
await tv.page.click('#duration-group .chip[data-dur="20"]');
await tv.page.click('#btn-open-lot');
const custom = await until(async () => (await phones[4].page.textContent('#pl-lot-title')).includes('perruque'), { timeout: 10000 });
check(custom >= 0, `le gage tapé à la main arrive sur les téléphones (${custom} ms)`);
await phones[4].page.click('#btn-bid5');
await until(async () => (await tv.page.textContent('#bidders')).includes('Emma · 5'));
ok('mise enregistrée sur le lot n°2');

console.log('  … attente de la fin du minuteur (20 s)');
const autoClose = await until(async () => await tv.page.locator('#btn-adjuge').isVisible(), { timeout: 30000 });
check(autoClose >= 0, `le minuteur clôture l'enchère tout seul (${autoClose} ms)`);
await tv.page.click('#btn-adjuge');
const twoLots = await until(async () => {
  const h = await tv.page.textContent('#history');
  return h.includes('Lot n°1') && h.includes('Lot n°2');
});
check(twoLots >= 0, 'les deux lots figurent à l\'historique');

// ─────────────────────────────────────────────── 8. Retardataire + rechargement
console.log('\n\x1b[1m8. Retardataire et rechargement de page\x1b[0m');
const late = await newDevice('Retardataire', PHONE);
await late.page.goto(qrURL, { waitUntil: 'domcontentloaded' });
const lateOk = await until(async () => await late.page.locator('#who-list button').count() >= 9, { timeout: 20000 });
check(lateOk >= 0, `un retardataire qui scanne le QR arrive sur « Qui es-tu ? » (${lateOk} ms)`);

await phones[0].page.reload({ waitUntil: 'domcontentloaded' });
const reloaded = await until(async () => await phones[0].page.locator('#screen-player.is-active').count() > 0, { timeout: 20000 });
check(reloaded >= 0, `un téléphone rechargé retrouve son identité sans re-choisir (${reloaded} ms)`);

await tv.page.reload({ waitUntil: 'domcontentloaded' });
const tvBack = await until(async () => {
  const c = await tv.page.locator('#tv-code').textContent().catch(() => '');
  return c && c.trim() === code;
}, { timeout: 20000 });
check(tvBack >= 0, `l'écran central rechargé retrouve la vente ${code} et les ardoises (${tvBack} ms)`);
check((await tv.page.textContent('#board')).includes(String(winner[1])), 'les ardoises ont survécu au rechargement');

// ─────────────────────────────────────────────── 9. Mode secours hors-ligne
console.log('\n\x1b[1m9. Mode secours : écran central sans aucun relais\x1b[0m');
const solo = await newDevice('Secours');
await solo.page.goto(`${BASE}${BASE.includes('?') ? '&' : '?'}broker=${encodeURIComponent('wss://127.0.0.1:9')}#setup`, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 3; i++) await solo.page.locator('#names-list .name-input').nth(i).fill(['Ana', 'Bob', 'Cyd'][i]);
await solo.page.click('#btn-open-room');
await solo.page.waitForSelector('#screen-tv.is-active', { timeout: 10000 });
await solo.page.click('#btn-qr-close').catch(() => {});
const offStatus = await until(async () => {
  const t = await solo.page.textContent('#tv-status');
  return t.includes('HORS LIGNE') || t.includes('RECONNEXION');
}, { timeout: 25000 });
check(offStatus >= 0, `l'écran central signale clairement qu'il n'a pas de relais (${offStatus} ms)`);
await solo.page.selectOption('#lot-select', { index: 1 });
await solo.page.click('#btn-open-lot');
await solo.page.waitForSelector('#tv-live:not([hidden])', { timeout: 5000 });
await solo.page.locator('#screen-tv details summary').click();
await solo.page.selectOption('#manual-player', { index: 1 });
await solo.page.fill('#manual-amount', '7');
await solo.page.click('#btn-manual-bid');
const manual = await until(async () => (await solo.page.textContent('#bidders')).includes('Bob · 7'), { timeout: 5000 });
check(manual >= 0, 'les mises peuvent être saisies à la main sur la TV, sans réseau');
await solo.page.click('#btn-close-lot');
await until(async () => await solo.page.locator('#btn-adjuge').isVisible(), { timeout: 8000 });
await solo.page.click('#btn-adjuge');
const soloBoard = await until(async () => (await solo.page.textContent('#board')).includes('Bob'), { timeout: 5000 });
check(soloBoard >= 0 && (await solo.page.textContent('#board')).includes('7'),
  'la partie peut se jouer entièrement depuis la TV en cas de panne de réseau');

// ─────────────────────────────────────────────── bilan
console.log(`\n\x1b[1m═══ ${pass} vérifications passées, ${fail} échec(s) ═══\x1b[0m\n`);
await browser.close();
process.exit(fail ? 1 : 0);
