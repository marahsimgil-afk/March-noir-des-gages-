/* Choisit la première URL candidate où l'application démarre RÉELLEMENT.
   Un simple curl ne suffit pas : certains relais renvoient le fichier aux
   outils en ligne de commande mais une page d'attente publicitaire aux
   navigateurs. On ouvre donc chaque candidate dans un vrai navigateur. */
import { chromium } from 'playwright';
import fs from 'node:fs';

const candidats = process.argv.slice(2).filter(Boolean);
const chemin = process.env.CHROME_PATH || '/opt/pw-browsers/chromium';
const navigateur = await chromium.launch({
  ...(fs.existsSync(chemin) ? { executablePath: chemin } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});

let retenue = '';
for (const base of candidats) {
  const page = await (await navigateur.newContext()).newPage();
  let verdict;
  try {
    await page.goto(base + '#setup', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForSelector('#names-list .name-input', { timeout: 15000 });
    const e = await page.evaluate(() => ({
      mqtt: typeof window.mqtt, qr: typeof window.QRCodeLib,
      champs: document.querySelectorAll('#names-list .name-input').length
    }));
    verdict = (e.mqtt === 'object' && e.qr === 'object' && e.champs === 9)
      ? null : `démarrage incomplet (${JSON.stringify(e)})`;
  } catch (err) {
    verdict = String(err.message).split('\n')[0].slice(0, 90);
  }
  await page.context().close();
  if (!verdict) { console.error(`  retenue : ${base}`); retenue = base; break; }
  console.error(`  écartée : ${base}\n            ${verdict}`);
}
await navigateur.close();
if (!retenue) { console.error('Aucune URL candidate ne fait démarrer l’application.'); process.exit(1); }
console.log(retenue);
