/*
 * Tests bout-en-bout multi-appareils.
 *
 * Chaque « téléphone » est un contexte navigateur distinct : stockage, session et
 * connexion réseau séparés, exactement comme deux appareils différents.
 *
 * Le même fichier sert deux cibles :
 *   - en local  : MNG_BASE=http://localhost:8080  MNG_WS=ws://localhost:9001
 *   - en réel   : MNG_BASE=https://…github.io/…   MNG_WS vide (brokers publics)
 */
const { test, expect } = require('@playwright/test');

const BASE = process.env.MNG_BASE || 'http://localhost:8080';
const WS = process.env.MNG_WS === undefined ? 'ws://localhost:9001' : process.env.MNG_WS;
const REEL = !WS; // contre l'infra publique : latences plus élevées
const PATIENCE = REEL ? 40000 : 15000;

function url(hash) {
  const q = WS ? '?ws=' + encodeURIComponent(WS) : '';
  return BASE + '/' + q + (hash || '');
}

const TELEPHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

/** Ouvre l'écran central et renvoie { page, code, brokerIndex }. */
async function ouvrirSalle(browser, noms, duree) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[TV erreur page]', e.message));
  await page.goto(url('#/'));

  await page.click('#btn-ouvrir-salle');
  await expect(page.locator('#ecr-install')).toBeVisible();

  const champs = page.locator('#grille-noms .champ-nom');
  for (let i = 0; i < noms.length; i++) await champs.nth(i).fill(noms[i]);
  // Les places restantes sont laissées vides : elles doivent être ignorées.
  if (duree) await page.click(`#choix-duree [data-duree="${duree}"]`);

  await page.click('#btn-lancer-salle');

  // La modale QR s'ouvre d'elle-même : c'est là que se lit le code de salle.
  await expect(page.locator('#modale-qr')).toHaveClass(/on/, { timeout: 10000 });
  const code = (await page.locator('#qr-code-txt').textContent()).trim();
  expect(code).toMatch(/^[A-Z0-9]{5}$/);
  await expect(page.locator('#qr-cible svg')).toBeVisible();
  await page.click('#btn-fermer-qr');

  // On attend que le lien temps réel soit établi avant de laisser entrer les joueurs.
  await expect(page.locator('#statut-central')).toHaveAttribute('data-etat', 'online', {
    timeout: PATIENCE,
  });
  return { ctx, page, code };
}

/** Fait rejoindre un téléphone et choisir son prénom. */
async function rejoindre(browser, code, prenom) {
  const ctx = await browser.newContext(TELEPHONE);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${prenom} erreur page]`, e.message));
  await page.goto(url('#/j/' + code + '/0'));

  const bouton = page.locator(`#liste-identites [data-id]`, { hasText: prenom });
  await expect(bouton).toBeVisible({ timeout: PATIENCE });
  await bouton.click();
  await expect(page.locator('#ecr-joueur')).toBeVisible();
  return { ctx, page };
}

async function lancerLot(tv, titre) {
  await expect(tv.locator('#vue-repos')).toBeVisible();
  await tv.fill('#champ-gage', titre);
  await tv.click('#btn-lancer-enchere');
  await expect(tv.locator('#vue-enchere')).toBeVisible();
}

/** Tape n fois sur le bouton d'enchère, aussi vite que possible. */
async function taper(page, n, selecteur) {
  const sel = selecteur || '#btn-plus-un';
  await expect(page.locator(sel)).toBeEnabled({ timeout: PATIENCE });
  for (let i = 0; i < n; i++) await page.locator(sel).dispatchEvent('pointerdown');
}

/* ------------------------------------------------------------------ scénarios */

test('une mise faite sur un téléphone remonte sur l’écran central', async ({ browser }) => {
  const tv = await ouvrirSalle(browser, ['Léa', 'Tom', 'Nour'], 60);
  const lea = await rejoindre(browser, tv.code, 'Léa');

  await lancerLot(tv.page, 'Danser seul au milieu du groupe');

  // Le lot doit apparaître sur le téléphone sans intervention.
  await expect(lea.page.locator('#joueur-lot')).toContainText('Danser seul', { timeout: PATIENCE });

  await taper(lea.page, 3);

  // …et la mise doit remonter sur la TV.
  await expect(tv.page.locator('#central-meneur')).toContainText('Léa', { timeout: PATIENCE });
  await expect(tv.page.locator('#central-meneur')).toContainText('3', { timeout: PATIENCE });
  await expect(tv.page.locator('#central-encheres')).toContainText('Léa');

  await tv.ctx.close();
  await lea.ctx.close();
});

test('deux téléphones se voient l’un l’autre, et le premier arrivé mène à égalité', async ({
  browser,
}) => {
  const tv = await ouvrirSalle(browser, ['Léa', 'Tom', 'Nour'], 60);
  const lea = await rejoindre(browser, tv.code, 'Léa');
  const tom = await rejoindre(browser, tv.code, 'Tom');

  await lancerLot(tv.page, 'Raconter sa pire honte amoureuse');
  await expect(tom.page.locator('#joueur-lot')).toContainText('honte', { timeout: PATIENCE });

  await taper(lea.page, 5);
  await expect(tv.page.locator('#central-meneur')).toContainText('Léa', { timeout: PATIENCE });

  // Tom voit bien que Léa mène : la synchro va de téléphone à téléphone via la TV.
  await expect(tom.page.locator('#joueur-meneur')).toContainText('Léa', { timeout: PATIENCE });
  await expect(tom.page.locator('#joueur-meneur')).toContainText('5', { timeout: PATIENCE });

  // Tom égalise : à 5 partout, Léa garde la main (arrivée la première).
  await taper(tom.page, 5, '#btn-plus-cinq');
  await expect(tom.page.locator('#joueur-ma-mise')).toContainText('25', { timeout: PATIENCE });
  await expect(tv.page.locator('#central-meneur')).toContainText('Tom', { timeout: PATIENCE });

  // Léa reprend la tête.
  await taper(lea.page, 21);
  await expect(tv.page.locator('#central-meneur')).toContainText('Léa', { timeout: PATIENCE });
  await expect(lea.page.locator('#joueur-meneur')).toContainText('Tu mènes', { timeout: PATIENCE });

  await tv.ctx.close();
  await lea.ctx.close();
  await tom.ctx.close();
});

// La TV plus huit téléphones : la configuration réelle de la soirée.
test('neuf appareils qui tapent en même temps : aucune mise perdue', async ({ browser }) => {
  test.setTimeout(REEL ? 300000 : 180000);
  const noms = ['Léa', 'Tom', 'Nour', 'Sacha', 'Inès', 'Malo', 'Jade', 'Ugo'];
  const tv = await ouvrirSalle(browser, noms, 60);

  const tels = await Promise.all(noms.map((n) => rejoindre(browser, tv.code, n)));

  await lancerLot(tv.page, 'Devenir majordome du groupe');
  for (const t of tels) {
    await expect(t.page.locator('#joueur-lot')).toContainText('majordome', { timeout: PATIENCE });
  }

  // Rafale simultanée : 8 téléphones x 12 taps, lancés en parallèle.
  const TAPS = 12;
  await Promise.all(tels.map((t) => taper(t.page, TAPS)));

  const attendu = noms.length * TAPS;
  await expect
    .poll(
      async () => {
        const pions = await tv.page.locator('#central-encheres .enchere-pion b').allTextContents();
        return pions.reduce((a, b) => a + Number(b), 0);
      },
      { timeout: PATIENCE, message: `total attendu ${attendu} gorgées` }
    )
    .toBe(attendu);

  // Chaque joueur doit voir sa propre mise complète, sans mise fantôme en vol.
  for (const t of tels) {
    await expect(t.page.locator('#joueur-ma-mise')).toContainText(String(TAPS), {
      timeout: PATIENCE,
    });
    await expect(t.page.locator('#joueur-ma-mise')).not.toContainText('en cours d’envoi', {
      timeout: PATIENCE,
    });
  }

  await tv.ctx.close();
  for (const t of tels) await t.ctx.close();
});

test('clôture manuelle : adjugé, validation, ardoise mise à jour partout', async ({ browser }) => {
  const tv = await ouvrirSalle(browser, ['Léa', 'Tom', 'Nour'], 60);
  const lea = await rejoindre(browser, tv.code, 'Léa');
  const tom = await rejoindre(browser, tv.code, 'Tom');

  await lancerLot(tv.page, 'Porter le chapeau ridicule');
  await taper(lea.page, 2);
  await taper(tom.page, 7);
  await expect(tv.page.locator('#central-meneur')).toContainText('Tom', { timeout: PATIENCE });

  await tv.page.click('#btn-clore');
  await expect(tv.page.locator('#vue-adjuge')).toBeVisible();
  await expect(tv.page.locator('#tampon-adjuge')).toContainText('Adjugé');
  await expect(tv.page.locator('#adjuge-qui')).toContainText('Tom');

  // Le résultat descend sur les téléphones.
  await expect(tom.page.locator('#joueur-res-qui')).toContainText('C’est toi', { timeout: PATIENCE });
  await expect(lea.page.locator('#joueur-res-qui')).toContainText('Tom', { timeout: PATIENCE });

  // Tant que l'organisatrice n'a pas validé, l'ardoise ne bouge pas.
  await expect(tom.page.locator('#joueur-ardoise')).toHaveText('0');

  await tv.page.click('#btn-encaisser');
  await expect(tv.page.locator('#vue-repos')).toBeVisible();
  await expect(tom.page.locator('#joueur-ardoise')).toHaveText('7', { timeout: PATIENCE });
  await expect(lea.page.locator('#joueur-ardoise')).toHaveText('0', { timeout: PATIENCE });
  await expect(tv.page.locator('#central-histo')).toContainText('chapeau');
  await expect(tv.page.locator('#central-ardoises')).toContainText('7');

  await tv.ctx.close();
  await lea.ctx.close();
  await tom.ctx.close();
});

test('un retardataire qui scanne en cours d’enchère reçoit l’état immédiatement', async ({
  browser,
}) => {
  const tv = await ouvrirSalle(browser, ['Léa', 'Tom', 'Nour'], 60);
  const lea = await rejoindre(browser, tv.code, 'Léa');

  await lancerLot(tv.page, 'Imiter quelqu’un du groupe');
  await taper(lea.page, 4);
  await expect(tv.page.locator('#central-meneur')).toContainText('Léa', { timeout: PATIENCE });

  // Nour arrive maintenant, enchère déjà ouverte.
  const nour = await rejoindre(browser, tv.code, 'Nour');
  await expect(nour.page.locator('#joueur-lot')).toContainText('Imiter', { timeout: PATIENCE });
  await expect(nour.page.locator('#joueur-meneur')).toContainText('Léa', { timeout: PATIENCE });
  await taper(nour.page, 6);
  await expect(tv.page.locator('#central-meneur')).toContainText('Nour', { timeout: PATIENCE });

  await tv.ctx.close();
  await lea.ctx.close();
  await nour.ctx.close();
});

test('coupure réseau sur un téléphone : reprise automatique, mise conservée', async ({
  browser,
}) => {
  const tv = await ouvrirSalle(browser, ['Léa', 'Tom', 'Nour'], 60);
  const lea = await rejoindre(browser, tv.code, 'Léa');

  await lancerLot(tv.page, 'Parler avec un accent imposé');
  await taper(lea.page, 2);
  await expect(tv.page.locator('#central-meneur')).toContainText('2', { timeout: PATIENCE });

  // Le téléphone perd le réseau (ascenseur, cave, 4G capricieuse).
  await lea.ctx.setOffline(true);
  await expect(lea.page.locator('#joueur-alerte')).toContainText(/perdu|Impossible|connexion/i, {
    timeout: PATIENCE,
  });

  // Le réseau revient.
  await lea.ctx.setOffline(false);
  await expect(lea.page.locator('#statut-joueur')).toHaveAttribute('data-etat', 'online', {
    timeout: PATIENCE,
  });

  // Et l'on peut de nouveau enchérir, sur la même identité, sans avoir rien perdu.
  await taper(lea.page, 3);
  await expect(tv.page.locator('#central-meneur')).toContainText('5', { timeout: PATIENCE });

  await tv.ctx.close();
  await lea.ctx.close();
});

test('l’écran central rechargé retrouve la partie et les ardoises', async ({ browser }) => {
  const tv = await ouvrirSalle(browser, ['Léa', 'Tom', 'Nour'], 60);
  const lea = await rejoindre(browser, tv.code, 'Léa');

  await lancerLot(tv.page, 'Chanter toutes ses réponses');
  await taper(lea.page, 8);
  await expect(tv.page.locator('#central-meneur')).toContainText('8', { timeout: PATIENCE });
  await tv.page.click('#btn-clore');
  await tv.page.click('#btn-encaisser');
  await expect(tv.page.locator('#central-ardoises')).toContainText('8');

  // La tablette redémarre (Safari a vidé l'onglet, câble débranché…).
  await tv.page.reload();
  await expect(tv.page.locator('#ecr-central')).toBeVisible({ timeout: PATIENCE });
  await expect(tv.page.locator('#central-ardoises')).toContainText('8');
  await expect(tv.page.locator('#central-histo')).toContainText('Chanter');
  await expect(tv.page.locator('#statut-central')).toHaveAttribute('data-etat', 'online', {
    timeout: PATIENCE,
  });

  // Et le téléphone déjà connecté continue de fonctionner.
  await lancerLot(tv.page, 'Déclaration d’amour à un objet');
  await expect(lea.page.locator('#joueur-lot')).toContainText('amour', { timeout: PATIENCE });
  await taper(lea.page, 2);
  await expect(tv.page.locator('#central-meneur')).toContainText('Léa', { timeout: PATIENCE });

  await tv.ctx.close();
  await lea.ctx.close();
});

test('le filet de sécurité mono-écran fonctionne sans réseau', async ({ browser }) => {
  const ctx = await browser.newContext(TELEPHONE);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[solo erreur page]', e.message));
  await page.goto(BASE + '/solo.html');

  const champs = page.locator('#grille-noms .champ-nom');
  await champs.nth(0).fill('Léa');
  await champs.nth(1).fill('Tom');
  await page.click('#btn-demarrer');
  await expect(page.locator('#s-jeu')).toBeVisible();

  await page.fill('#champ-gage', 'Danser seul');
  await page.selectOption('#champ-duree', '60');
  await page.click('#btn-ouvrir');
  await expect(page.locator('#lot-titre')).toContainText('Danser seul');

  const boutonTom = page.locator('#boutons-mise [data-p]', { hasText: 'Tom' });
  for (let i = 0; i < 4; i++) await boutonTom.click();
  await expect(page.locator('#meneur')).toContainText('Tom');
  await expect(page.locator('#meneur')).toContainText('4');

  await page.click('#btn-clore');
  await page.click('#btn-encaisser');
  await expect(page.locator('#ardoises')).toContainText('4');
  await expect(page.locator('#histo')).toContainText('Danser seul');

  await ctx.close();
});

test('le minuteur se termine tout seul et adjuge au plus offrant', async ({ browser }) => {
  test.setTimeout(120000);
  const tv = await ouvrirSalle(browser, ['Léa', 'Tom', 'Nour'], 20);
  const lea = await rejoindre(browser, tv.code, 'Léa');
  const tom = await rejoindre(browser, tv.code, 'Tom');

  await lancerLot(tv.page, 'Être exempté du prochain gage');
  await taper(lea.page, 3);
  await taper(tom.page, 4);

  // On laisse le minuteur aller au bout : pas de clic, la TV clôt d'elle-même.
  await expect(tv.page.locator('#vue-adjuge')).toBeVisible({ timeout: 45000 });
  await expect(tv.page.locator('#adjuge-qui')).toContainText('Tom');
  await expect(tom.page.locator('#joueur-res-qui')).toContainText('C’est toi', { timeout: PATIENCE });

  // Après le gong, plus personne ne peut enchérir.
  await expect(lea.page.locator('#btn-plus-un')).toBeHidden();

  await tv.ctx.close();
  await lea.ctx.close();
  await tom.ctx.close();
});
