/* =========================================================
   Test de bout en bout — plusieurs "téléphones" pour de vrai.

   Trois navigateurs isolés (contextes séparés, donc localStorage séparés) :
   un écran central + deux téléphones. On vérifie qu'une mise faite d'un côté
   remonte bien de l'autre, sans perte, y compris en tapant vite.

     node test/e2e.js              → broker MQTT local (hors ligne)
     node test/e2e.js --public     → URL publique + brokers publics réels
                                     (URL_APP=https://…)
   ========================================================= */
'use strict';

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

// Trois modes :
//   (défaut)   serveur local + broker MQTT local  → aucun réseau requis
//   --reels    serveur local + vrais brokers publics → valide le transport réel
//   --public   URL_APP en ligne + vrais brokers publics → valide tout
const PUBLIC = process.argv.includes('--public');
const BROKERS_REELS = PUBLIC || process.argv.includes('--reels');
let BASE = PUBLIC ? (process.env.URL_APP || '').replace(/\/$/, '') : '';
let BROKER_LOCAL = '';

if (PUBLIC && !BASE) {
  console.error('URL_APP est requis avec --public');
  process.exit(2);
}

const JOUEURS = ['Alice', 'Bruno', 'Chloé'];
// Deux lots seulement : la vente se termine dans le scénario, ce qui permet de
// vérifier que le récapitulatif final s'ouvre tout seul.
const PROGRAMME = [
  'Porter un chapeau ridicule toute la soirée',
  'Danser seul au milieu du groupe'
];

let echecs = 0;
let etapes = 0;

function ok(titre, detail) {
  etapes++;
  console.log(`  [32m✓[0m ${titre}${detail ? '  [2m' + detail + '[0m' : ''}`);
}
function ko(titre, detail) {
  etapes++;
  echecs++;
  console.log(`  [31m✗ ${titre}[0m${detail ? '\n      ' + detail : ''}`);
}
function verifier(condition, titre, detail) {
  if (condition) ok(titre, detail); else ko(titre, detail);
  return condition;
}
function titre(t) { console.log(`\n[1m${t}[0m`); }

const dors = (ms) => new Promise((r) => setTimeout(r, ms));

/* Attend qu'un sélecteur satisfasse un prédicat sur son texte. */
async function attendre(page, selecteur, predicat, delaiMax = 15000, libelle = '') {
  const t0 = Date.now();
  let dernier = '<absent>';
  while (Date.now() - t0 < delaiMax) {
    try {
      const el = await page.$(selecteur);
      if (el) {
        dernier = (await el.textContent()) || '';
        if (predicat(dernier.trim())) return { ms: Date.now() - t0, texte: dernier.trim() };
      }
    } catch (e) { /* navigation en cours */ }
    await dors(40);
  }
  throw new Error(`délai dépassé sur « ${selecteur} » ${libelle} — dernier texte vu : « ${dernier.trim()} »`);
}

/* Attend qu'au moins `mini` éléments correspondent au sélecteur. */
async function attendreNombre(page, selecteur, mini, delaiMax = 20000, libelle = '') {
  const t0 = Date.now();
  let vu = 0;
  while (Date.now() - t0 < delaiMax) {
    try {
      vu = await page.$$eval(selecteur, (l) => l.length);
      if (vu >= mini) return { ms: Date.now() - t0, nombre: vu };
    } catch (e) { /* navigation en cours */ }
    await dors(50);
  }
  throw new Error(`délai dépassé : ${vu}/${mini} « ${selecteur} » ${libelle}`);
}

async function nouvelEcran(navigateur, taille) {
  const contexte = await navigateur.newContext({
    viewport: taille,
    userAgent: taille.width < 500
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : undefined,
    hasTouch: taille.width < 500,
    isMobile: taille.width < 500,
    permissions: []
  });
  const page = await contexte.newPage();
  page.on('pageerror', (e) => console.log(`    [31m[erreur js][0m ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`    [33m[console][0m ${m.text()}`);
  });
  page.on('requestfailed', (r) =>
    console.log(`    \x1b[31m[requête échouée]\x1b[0m ${r.url()} — ${(r.failure() || {}).errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) console.log(`    \x1b[31m[HTTP ${r.status()}]\x1b[0m ${r.url()}`);
  });
  return { contexte, page };
}

function url(chemin) {
  const sep = chemin.includes('?') ? '&' : '?';
  // Sans « bu », l'application choisit elle-même parmi ses brokers publics.
  return BASE + '/' + chemin + (BROKERS_REELS ? '' : sep + 'bu=' + encodeURIComponent(BROKER_LOCAL));
}

async function principal() {
  let serveur = null;
  if (!PUBLIC) {
    serveur = spawn('node', [path.join(__dirname, 'serveur-test.js'), '0', '0'], {
      stdio: ['ignore', 'pipe', 'inherit']
    });
    // Le bac à sable ne doit jamais survivre au test, même si celui-ci est tué.
    const tuer = () => { try { serveur.kill('SIGKILL'); } catch (e) {} };
    process.on('exit', tuer);
    process.on('SIGINT', () => { tuer(); process.exit(130); });
    process.on('SIGTERM', () => { tuer(); process.exit(143); });

    await new Promise((resolve, rejeter) => {
      const minuteur = setTimeout(() => rejeter(new Error('le bac à sable n’a pas démarré')), 15000);
      let tampon = '';
      serveur.stdout.on('data', (d) => {
        tampon += d.toString();
        const m = tampon.match(/PRET http=(\d+) mqtt=(\d+)/);
        if (m) {
          BASE = `http://127.0.0.1:${m[1]}`;
          BROKER_LOCAL = `ws://127.0.0.1:${m[2]}/mqtt`;
          clearTimeout(minuteur);
          resolve();
        }
      });
      serveur.on('exit', (c) => rejeter(new Error('le bac à sable s’est arrêté (code ' + c + ')')));
    });
    console.log(BROKERS_REELS
      ? `Bac à sable prêt — ${BASE}  (brokers MQTT publics réels)`
      : `Bac à sable prêt — ${BASE}  (broker ${BROKER_LOCAL})`);
  } else {
    console.log(`Cible publique — ${BASE}  (brokers MQTT publics réels)`);
  }

  const navigateur = await chromium.launch({
    // CHROMIUM_PATH permet d'utiliser un Chromium déjà présent sur la machine
    // au lieu de celui téléchargé par Playwright.
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required']
  });

  const tv = await nouvelEcran(navigateur, { width: 1280, height: 800 });
  const tel1 = await nouvelEcran(navigateur, { width: 390, height: 844 });
  const tel2 = await nouvelEcran(navigateur, { width: 390, height: 844 });
  let tel3 = null;

  try {
    /* ---------- 1. L'écran central ouvre la salle ---------- */
    titre('1. Écran central — ouverture de la salle');
    await tv.page.goto(url('index.html'), { waitUntil: 'domcontentloaded' });
    await tv.page.getByRole('button', { name: /Écran central/ }).click();

    const champs = await tv.page.$$('input.champ');
    for (let i = 0; i < JOUEURS.length; i++) await champs[i].fill(JOUEURS[i]);
    ok('3 prénoms saisis', JOUEURS.join(', '));

    // Tout le programme est saisi d'un coup, avant même d'ouvrir la salle.
    await tv.page.fill('textarea.champ', PROGRAMME.join('\n'));
    const compte = await attendre(tv.page, '.compte-programme', (t) => /lots? au programme/.test(t), 5000);
    verifier(/^2 lots/.test(compte.texte), 'programme saisi en une fois', compte.texte);

    await tv.page.getByRole('button', { name: /Ouvrir la salle des ventes/ }).click();

    const r = await attendre(tv.page, '.code-salle', (t) => /^[A-Z0-9]{5}$/.test(t), 30000, '(code de salle)');
    const code = r.texte;
    verifier(/^[A-Z0-9]{5}$/.test(code), 'salle ouverte, code affiché', `${code} en ${r.ms} ms`);

    // Avec de vrais brokers, la connexion aboutit un peu après l'affichage du code.
    const lien = await attendre(tv.page, '.lien-etat[data-etat="ok"]', () => true, 30000, '(connexion écran central)');
    const suffixe = await tv.page.$eval('.lien-etat', (e) => e.textContent.trim());
    ok('écran central connecté au broker', `${suffixe} — en ${lien.ms} ms`);

    const qr = await tv.page.$('.qr-panneau svg');
    verifier(!!qr, 'QR code généré et affiché');

    /* ---------- 2. Deux téléphones rejoignent ---------- */
    titre('2. Les téléphones rejoignent');
    for (const [tel, nom] of [[tel1, 'Alice'], [tel2, 'Bruno']]) {
      await tel.page.goto(url('index.html?s=' + code), { waitUntil: 'domcontentloaded' });
      await attendre(tel.page, '.grille-noms', () => true, 20000, '(liste des prénoms)');
      await tel.page.getByRole('button', { name: new RegExp('^' + nom + '$') }).click();
      await attendre(tel.page, '.enseigne .gros', (t) => t.length > 0, 15000);
      ok(`${nom} a rejoint depuis son téléphone`);
    }

    // L'écran central doit les voir en ligne (la présence remonte via l'état,
    // donc on attend au lieu de photographier un instant précis).
    const presence = await attendreNombre(tv.page, '.pastille-x.on', 2, 25000, '(présence sur la TV)');
    ok('les deux joueurs apparaissent connectés sur l’écran central',
      `${presence.nombre} pastilles vertes en ${presence.ms} ms`);

    /* ---------- 3. Mise en vente ---------- */
    titre('3. Mise en vente — le lot vient du programme');
    const annonce = await attendre(tv.page, '.gage-titre', (t) => t.length > 0, 10000, '(lot suivant)');
    verifier(annonce.texte === PROGRAMME[0], 'le premier lot du programme est proposé sans rien retaper', annonce.texte);
    await tv.page.getByRole('button', { name: /Démarrer l’enchère/ }).click();
    await attendre(tv.page, '.montant-geant', () => true, 10000, '(enchère ouverte)');
    ok('enchère démarrée en un bouton');

    for (const [tel, nom] of [[tel1, 'Alice'], [tel2, 'Bruno']]) {
      const v = await attendre(tel.page, '.btn-encherir .lib', (t) => /ENCHÉRIR/.test(t), 12000, `(bouton chez ${nom})`);
      ok(`${nom} voit le lot et le bouton d’enchère`, `en ${v.ms} ms`);
    }

    /* ---------- 4. Une mise doit remonter sur l'écran central ---------- */
    titre('4. Propagation d’une mise (téléphone → écran central)');
    let t0 = Date.now();
    await tel1.page.click('.btn-encherir');
    const m1 = await attendre(tv.page, '.montant-geant', (t) => t === '1', 12000, '(montant sur la TV)');
    verifier(true, 'la mise d’Alice s’affiche sur l’écran central', `${Date.now() - t0} ms`);
    await attendre(tv.page, '.meneur-nom', (t) => t === 'Alice', 8000, '(meneur sur la TV)');
    ok('l’écran central désigne bien Alice comme meneuse');

    /* ---------- 5. …et sur l'autre téléphone ---------- */
    titre('5. Propagation croisée (téléphone → téléphone)');
    t0 = Date.now();
    await attendre(tel2.page, '.montant-geant', (t) => t === '1', 12000, '(montant chez Bruno)');
    ok('Bruno voit l’offre d’Alice', `${Date.now() - t0} ms`);
    await attendre(tel2.page, '.meneur-nom', (t) => t === 'Alice', 8000);
    ok('Bruno voit qui mène');

    t0 = Date.now();
    await tel2.page.click('.btn-encherir5');
    await attendre(tv.page, '.montant-geant', (t) => t === '6', 12000, '(6 attendu sur la TV)');
    ok('le +5 de Bruno remonte sur l’écran central', `${Date.now() - t0} ms → 6 gorgées`);
    await attendre(tel1.page, '.btn-encherir .lib', (t) => /ENCHÉRIR/.test(t), 8000);
    const libAlice = await tel1.page.$eval('.btn-encherir .lib', (e) => e.textContent.trim());
    verifier(libAlice === '+1 ENCHÉRIR', 'Alice n’est plus meneuse : son bouton se réactive', libAlice);

    /* ---------- 6. Rafale de taps : aucune mise perdue ---------- */
    titre('6. Rafale de taps — aucune mise ne doit se perdre');
    const RAFALE = 10;
    t0 = Date.now();
    for (let i = 0; i < RAFALE; i++) {
      await tel1.page.dispatchEvent('.btn-encherir', 'click');
      await dors(35);
    }
    const attendu = String(6 + RAFALE);
    const rr = await attendre(tv.page, '.montant-geant', (t) => t === attendu, 15000, `(${attendu} attendu)`);
    verifier(true, `${RAFALE} taps rapides comptés exactement`, `${attendu} gorgées, stabilisé en ${rr.ms} ms`);

    // Contre-vérification : le total ne doit pas continuer à bouger.
    await dors(1200);
    const stable = await tv.page.$eval('.montant-geant', (e) => e.textContent.trim());
    verifier(stable === attendu, 'le montant reste stable après la rafale', `${stable}`);

    /* ---------- 7. Retardataire : l'état est récupéré tout seul ---------- */
    titre('7. Retardataire en cours d’enchère');
    tel3 = await nouvelEcran(navigateur, { width: 390, height: 844 });
    await tel3.page.goto(url('index.html?s=' + code), { waitUntil: 'domcontentloaded' });
    await attendre(tel3.page, '.grille-noms', () => true, 20000, '(liste des prénoms)');
    await tel3.page.getByRole('button', { name: /^Chloé$/ }).click();
    const vue = await attendre(tel3.page, '.montant-geant', (t) => t === attendu, 15000, '(état repris)');
    ok('Chloé arrive en cours d’enchère et voit le montant courant', `${attendu} gorgées, en ${vue.ms} ms`);

    /* ---------- 8. Adjudication ---------- */
    titre('8. Adjudication et ardoise');
    await tv.page.getByRole('button', { name: /Adjuger maintenant/ }).click();
    await attendre(tv.page, '.tampon', (t) => /Adjugé/i.test(t), 10000);
    ok('tampon « Adjugé » sur l’écran central');

    await attendre(tel1.page, '.tampon', (t) => /Adjugé/i.test(t), 10000);
    const gagnantTel = await tel1.page.$eval('.meneur-nom', (e) => e.textContent.trim());
    verifier(gagnantTel === 'TOI', 'Alice est prévenue qu’elle a remporté le lot', gagnantTel);

    await tv.page.getByRole('button', { name: /Valider et inscrire/ }).click();
    await attendre(tv.page, '.carton.dore .ligne .val', (t) => t === attendu, 10000, '(ardoise sur la TV)');
    ok('l’ardoise de l’écran central est mise à jour', `${attendu} gorgées`);

    const ardoiseAlice = await attendre(tel1.page, '.ligne .val', (t) => t === attendu, 12000, '(ardoise chez Alice)');
    ok('Alice voit sa propre ardoise mise à jour', `${ardoiseAlice.texte} gorgées`);

    /* ---------- 9. Prolongation anti-sniper ---------- */
    titre('9. Prolongation si l’on mise dans les dernières secondes');
    const lot2 = await attendre(tv.page, '.gage-titre', (t) => t.length > 0, 10000, '(lot 2)');
    verifier(lot2.texte === PROGRAMME[1], 'le lot suivant s’enchaîne tout seul', lot2.texte);
    await tv.page.$$eval('.segmente button', (l) => l[0].click()); // 20 s
    await tv.page.getByRole('button', { name: /Démarrer l’enchère/ }).click();
    await attendre(tv.page, '.minuteur', (t) => Number(t) > 0, 10000);
    await attendre(tv.page, '.minuteur', (t) => Number(t) <= 3, 30000, '(3 dernières secondes)');
    await tel2.page.click('.btn-encherir');
    const prolong = await attendre(tv.page, '.etiquette', (t) => /Prolongation/.test(t), 8000);
    verifier(true, 'l’enchère est prolongée par une mise de dernière seconde', prolong.texte);
    const secondes = Number(await tv.page.$eval('.minuteur', (e) => e.textContent.trim()));
    verifier(secondes >= 2, 'le minuteur est bien reparti', `${secondes} s`);

    await tv.page.getByRole('button', { name: /Adjuger maintenant/ }).click();
    await attendre(tv.page, '.tampon', () => true, 10000);
    await tv.page.getByRole('button', { name: /Valider et inscrire/ }).click();
    ok('deuxième lot adjugé et validé');

    /* ---------- 10. Récapitulatif final ---------- */
    titre('10. Récapitulatif de fin de vente');
    const recap = await attendre(tv.page, '.enseigne .gros', (t) => /Registre/.test(t), 12000, '(récap auto)');
    ok('le récapitulatif s’ouvre tout seul au dernier lot', `en ${recap.ms} ms`);

    const lignesRecap = await tv.page.$$eval('.recap-ligne', (l) => l.length);
    verifier(lignesRecap === JOUEURS.length, 'l’ardoise finale liste tous les joueurs', `${lignesRecap} lignes`);

    // Scopé au récapitulatif : le plateau reste dans le DOM, simplement masqué.
    const registre = await tv.page.$$eval('.recap .carton:not(.dore) .ligne .val',
      (l) => l.map((e) => e.textContent.trim()));
    verifier(registre.length === 2, 'le registre montre les deux lots vendus', registre.join(' + ') + ' gorgées');

    const totalRecap = await tv.page.$eval('.recap-montant', (e) => Number(e.textContent.trim()));
    verifier(totalRecap >= Number(attendu), 'le premier de l’ardoise porte bien son total', `${totalRecap} gorgées`);

    const releve = await attendre(tel1.page, '.enseigne .gros', (t) => /relevé/i.test(t), 12000, '(relevé joueur)');
    ok('chaque téléphone affiche son propre relevé', releve.texte);

    /* ---------- 11. Reprise après coupure réseau ---------- */
    titre('11. Coupure réseau sur un téléphone');
    await tel2.contexte.setOffline(true);
    const degrade = await attendre(
      tel2.page,
      '.lien-etat:not([data-etat="ok"])',
      () => true,
      20000,
      '(bandeau dégradé)'
    );
    const etatKo = await tel2.page.$eval('.lien-etat', (e) => e.getAttribute('data-etat'));
    verifier(etatKo !== 'ok', 'le téléphone hors ligne affiche un état dégradé',
      `état = ${etatKo}, en ${degrade.ms} ms`);
    await tel2.contexte.setOffline(false);
    const revenu = await attendre(tel2.page, '.lien-etat[data-etat="ok"]', () => true, 30000, '(reconnexion)');
    ok('reconnexion automatique dès que le réseau revient', `en ${revenu.ms} ms`);

    /* ---------- Bilan ---------- */
    titre('Bilan');
    console.log(`  ${etapes - echecs}/${etapes} vérifications passées`);
  } catch (e) {
    ko('exception pendant le scénario', e.stack || e.message);
    for (const [nom, ecran] of [['tv', tv], ['tel1', tel1], ['tel2', tel2], ['tel3', tel3]]) {
      if (!ecran) continue;
      try { await ecran.page.screenshot({ path: `/tmp/mng-${nom}.png`, fullPage: true }); } catch (_) {}
      try {
        const vu = await ecran.page.evaluate(() => ({
          texte: (document.body.innerText || '').slice(0, 400),
          mqtt: typeof window.mqtt,
          qrcode: typeof window.qrcode,
          demarre: !!window.MNG
        }));
        console.log(`    [2m[${nom}] mqtt=${vu.mqtt} qrcode=${vu.qrcode} app=${vu.demarre}[0m`);
        console.log(`    [2m[${nom}] écran : ${JSON.stringify(vu.texte)}[0m`);
      } catch (_) {}
    }
    console.log('  captures d’écran dans /tmp/mng-*.png');
  } finally {
    await navigateur.close();
    if (serveur) serveur.kill('SIGTERM');
  }

  process.exit(echecs === 0 ? 0 : 1);
}

principal().catch((e) => { console.error(e); process.exit(1); });
