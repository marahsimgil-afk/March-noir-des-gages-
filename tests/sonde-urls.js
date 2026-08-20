/*
 * Sonde des adresses publiques candidates.
 *
 * Pour être utilisable, une adresse doit servir index.html en `text/html` ET les
 * scripts en JavaScript : plusieurs CDN renvoient du `text/plain` par sécurité,
 * ce qui empêche purement et simplement l'application de démarrer.
 *
 * Écrit l'adresse retenue sur la sortie standard (dernière ligne, préfixe RETENUE=).
 */
const CANDIDATES = process.argv.slice(2);

const MARQUEUR = 'Le Marché Noir des Gages';

async function sonder(base) {
  const out = { base, ok: false, detail: '' };
  try {
    const rIndex = await fetch(base + '/index.html', { redirect: 'follow' });
    if (!rIndex.ok) return { ...out, detail: 'index.html → HTTP ' + rIndex.status };

    const ctIndex = (rIndex.headers.get('content-type') || '').toLowerCase();
    if (!ctIndex.includes('text/html')) {
      return { ...out, detail: 'index.html servi en « ' + ctIndex +' »' };
    }

    const corps = await rIndex.text();
    if (!corps.includes(MARQUEUR)) {
      return { ...out, detail: 'contenu inattendu (page d’avertissement du CDN ?)' };
    }

    // Le navigateur refuse d'exécuter un script servi avec un mauvais type MIME
    // dès lors que l'en-tête nosniff est présent : on vérifie donc aussi le JS.
    const rJs = await fetch(base + '/js/game.js', { redirect: 'follow' });
    const ctJs = (rJs.headers.get('content-type') || '').toLowerCase();
    if (!rJs.ok) return { ...out, detail: 'js/game.js → HTTP ' + rJs.status };
    if (!/javascript|ecmascript/.test(ctJs)) {
      return { ...out, detail: 'js/game.js servi en « ' + ctJs + ' »' };
    }

    return { base, ok: true, detail: 'html + js corrects' };
  } catch (e) {
    return { ...out, detail: e.message };
  }
}

(async () => {
  console.log('Sonde des adresses publiques\n');
  const resultats = [];
  for (const c of CANDIDATES) {
    const r = await sonder(c);
    resultats.push(r);
    console.log(`  ${r.ok ? 'OK ' : 'NON'}  ${r.base}`);
    console.log(`        ↳ ${r.detail}`);
  }

  const gagnante = resultats.find((r) => r.ok);
  console.log('');
  if (!gagnante) {
    console.error('Aucune adresse publique exploitable.');
    process.exit(1);
  }
  console.log('RETENUE=' + gagnante.base);
})();
