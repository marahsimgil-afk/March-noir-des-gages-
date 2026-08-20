/*
 * Sonde des adresses publiques candidates — dans un vrai navigateur.
 *
 * Une réponse HTTP correcte ne suffit pas : certains CDN renvoient bien notre
 * HTML à `fetch` mais le navigateur ne l'affiche pas (type MIME neutralisé,
 * en-tête de téléchargement forcé, interstitiel…). Le seul critère qui compte est
 * donc : « la page démarre-t-elle réellement dans un navigateur ? »
 *
 * Écrit l'adresse retenue en dernière ligne, préfixée RETENUE=.
 */
const { chromium } = require('@playwright/test');

const CANDIDATES = process.argv.slice(2);

async function sonder(navigateur, base) {
  const page = await navigateur.newPage();
  const diagnostic = [];
  page.on('pageerror', (e) => diagnostic.push('erreur JS : ' + e.message));
  page.on('response', (r) => {
    if (!r.url().includes('index.html')) return;
    const h = r.headers();
    diagnostic.push(
      'HTTP ' + r.status() +
        ' | type: ' + (h['content-type'] || '—') +
        (h['content-disposition'] ? ' | disposition: ' + h['content-disposition'] : '')
    );
  });

  let resultat;
  try {
    await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Le bouton d'accueil est écrit en dur dans le HTML : s'il est absent, la page
    // n'a pas été rendue du tout.
    await page.waitForSelector('#btn-ouvrir-salle', { state: 'visible', timeout: 15000 });
    // Et l'application doit avoir chargé ses scripts. On laisse le temps : la
    // bibliothèque MQTT pèse 364 Ko, et certains hébergeurs la servent lentement.
    await page.waitForFunction(() => !!(window.MNG && window.MNGNet && window.mqtt), null, {
      timeout: 25000,
    });
    resultat = { base, ok: true, detail: 'page rendue, scripts chargés' };
  } catch (e) {
    resultat = { base, ok: false, detail: e.message.split('\n')[0] };
    // Ce que le navigateur a réellement affiché : c'est la seule façon de
    // distinguer un interstitiel du CDN d'une page servie en texte brut.
    try {
      const recu = await page.evaluate(() => ({
        titre: document.title,
        debut: (document.body ? document.body.innerText : '').slice(0, 160).replace(/\s+/g, ' '),
      }));
      diagnostic.push('titre : « ' + recu.titre + ' »');
      diagnostic.push('affiché : « ' + recu.debut + ' »');
    } catch (e2) {
      /* page inutilisable, on s'en tient au message d'erreur */
    }
  }

  resultat.diagnostic = diagnostic.slice(0, 5);
  await page.close();
  return resultat;
}

(async () => {
  console.log('Sonde des adresses publiques (navigateur réel)\n');
  const navigateur = await chromium.launch({ args: ['--no-sandbox'] });
  const resultats = [];
  for (const c of CANDIDATES) resultats.push(await sonder(navigateur, c));
  await navigateur.close();

  for (const r of resultats) {
    console.log(`  ${r.ok ? 'OK ' : 'NON'}  ${r.base}`);
    console.log(`        ↳ ${r.detail}`);
    for (const d of r.diagnostic) console.log(`          · ${d}`);
  }

  const gagnante = resultats.find((r) => r.ok);
  console.log('');
  if (!gagnante) {
    console.log('Aucune adresse publique n’affiche l’application.');
    console.log('RETENUE=');
    return;
  }
  console.log('RETENUE=' + gagnante.base);
})();
