/* Captures d'écran du parcours complet, pour regarder le rendu sans avoir
   neuf téléphones sous la main. Écrit dans /tmp/cap-*.png.

     node test/captures.js
*/
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const dors = (ms) => new Promise((r) => setTimeout(r, ms));
const RACINE = '/home/user/March-noir-des-gages-';

async function attendre(page, sel, pred = () => true, max = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < max) {
    const el = await page.$(sel);
    if (el && pred((await el.textContent()).trim())) return;
    await dors(50);
  }
  throw new Error('timeout ' + sel);
}

(async () => {
  const serveur = spawn('node', [path.join(RACINE, 'test/serveur-test.js'), '0', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let BASE, BROKER;
  await new Promise((res) => {
    let buf = '';
    serveur.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/PRET http=(\d+) mqtt=(\d+)/);
      if (m) { BASE = `http://127.0.0.1:${m[1]}`; BROKER = `ws://127.0.0.1:${m[2]}/mqtt`; res(); }
    });
  });
  const q = '?bu=' + encodeURIComponent(BROKER);

  const nav = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
  const tv = await (await nav.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })).newPage();
  const ctxTel = await nav.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const tel = await ctxTel.newPage();
  const ctxTel2 = await nav.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const tel2 = await ctxTel2.newPage();

  await tv.goto(BASE + '/index.html' + q);
  await dors(400);
  await tv.screenshot({ path: '/tmp/cap-1-accueil.png' });

  await tv.getByRole('button', { name: /Écran central/ }).click();
  const noms = ['Marah', 'Léa', 'Tom', 'Inès', 'Hugo', 'Jade', 'Malo', 'Nina', 'Yanis', 'Sacha'];
  const champs = await tv.$$('input.champ');
  for (let i = 0; i < noms.length; i++) await champs[i].fill(noms[i]);
  await tv.fill('textarea.champ', [
    'Porter un chapeau ridicule toute la soirée',
    'Danser seul au milieu du groupe',
    'Raconter sa pire honte amoureuse'
  ].join('\n'));
  await dors(300);
  await tv.screenshot({ path: '/tmp/cap-2-config.png' });

  await tv.getByRole('button', { name: /Ouvrir la salle des ventes/ }).click();
  await attendre(tv, '.code-salle', (t) => /^[A-Z0-9]{5}$/.test(t), 30000);
  const code = (await tv.$eval('.code-salle', (e) => e.textContent)).trim();
  await dors(600);
  await tv.screenshot({ path: '/tmp/cap-3-salle.png' });

  for (const [p, n] of [[tel, 'Léa'], [tel2, 'Tom']]) {
    await p.goto(BASE + '/index.html?s=' + code + '&bu=' + encodeURIComponent(BROKER));
    await attendre(p, '.grille-noms');
    if (p === tel) { await dors(300); await p.screenshot({ path: '/tmp/cap-4-qui-es-tu.png' }); }
    await p.getByRole('button', { name: new RegExp('^' + n + '$') }).click();
    await dors(400);
  }

  await dors(400);
  await tv.screenshot({ path: '/tmp/cap-11-prochain.png' });
  await tv.getByRole('button', { name: /Démarrer l’enchère/ }).click();
  await attendre(tv, '.montant-geant');
  await dors(300);

  // dispatchEvent plutôt que click : le bouton du meneur est désactivé, et
  // Playwright attendrait 30 s qu'il redevienne cliquable.
  const miser = async (p, sel) => { await p.dispatchEvent(sel, 'click'); await dors(450); };
  await miser(tel, '.btn-encherir');
  await miser(tel2, '.btn-encherir');
  await miser(tel, '.btn-encherir');
  await miser(tel2, '.btn-encherir');
  await miser(tel, '.btn-encherir');
  await miser(tel2, '.btn-encherir');
  await miser(tel, '.btn-encherir');
  await dors(900);

  await tv.screenshot({ path: '/tmp/cap-5-enchere-tv.png' });
  await tel.screenshot({ path: '/tmp/cap-6-enchere-tel.png' });
  await tel2.screenshot({ path: '/tmp/cap-7-tel-depasse.png' });

  await tv.dispatchEvent('.carton.dore .btn.fantome.mini', 'click');
  await attendre(tv, '.tampon');
  await dors(700);
  await tv.screenshot({ path: '/tmp/cap-8-adjuge-tv.png' });
  await tel.screenshot({ path: '/tmp/cap-9-adjuge-tel.png' });

  await tv.getByRole('button', { name: /Valider et inscrire/ }).click();
  await dors(800);
  await tv.screenshot({ path: '/tmp/cap-10-ardoise.png' });

  // On solde le programme pour capturer le récapitulatif final.
  for (let i = 0; i < 2; i++) {
    await tv.getByRole('button', { name: /Démarrer l’enchère/ }).click();
    await attendre(tv, '.montant-geant');
    await dors(300);
    await tel2.dispatchEvent('.btn-encherir', 'click');
    await dors(500);
    await tv.dispatchEvent('.carton.dore .btn.fantome.mini', 'click');
    await attendre(tv, '.tampon');
    await dors(400);
    await tv.getByRole('button', { name: /Valider et inscrire/ }).click();
    await dors(800);
  }
  await attendre(tv, '.recap', () => true, 10000);
  await dors(600);
  await tv.screenshot({ path: '/tmp/cap-12-recap.png' });
  await tel.screenshot({ path: '/tmp/cap-13-releve-tel.png' });

  await nav.close();
  serveur.kill('SIGKILL');
  console.log('captures OK, code =', code);
})().catch((e) => { console.error(e); process.exit(1); });
