const { defineConfig } = require('@playwright/test');
const fs = require('fs');

// Certains environnements fournissent déjà un Chromium, dont la révision ne
// correspond pas forcément à celle attendue par @playwright/test. On l'utilise
// tel quel plutôt que d'en télécharger un second.
const CHROMIUM_FOURNI = '/opt/pw-browsers/chromium';
const executablePath = fs.existsSync(CHROMIUM_FOURNI) ? CHROMIUM_FOURNI : undefined;

// Le serveur statique local n'est lancé que si la cible est locale. Le transport
// temps réel, lui, est choisi indépendamment par MNG_WS : on peut donc servir le
// site depuis la machine tout en synchronisant via les vrais brokers publics.
const CIBLE_LOCALE = !process.env.MNG_BASE || process.env.MNG_BASE.includes('localhost');
// Sans MNG_WS, l'application utilise les brokers publics : latences plus élevées.
const RESEAU_REEL = process.env.MNG_WS === '';

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  timeout: RESEAU_REEL ? 180000 : 90000,
  expect: { timeout: 10000 },
  // Les tests partagent des brokers publics : on les sérialise pour que les
  // rafales de l'un ne faussent pas les mesures de l'autre.
  workers: 1,
  fullyParallel: false,
  retries: RESEAU_REEL ? 1 : 0,
  reporter: [['list']],
  use: {
    headless: true,
    launchOptions: { args: ['--no-sandbox'], executablePath: executablePath },
    trace: 'retain-on-failure',
  },
  webServer: CIBLE_LOCALE
    ? {
        command: 'node tests/serve.js',
        url: 'http://localhost:8080/index.html',
        reuseExistingServer: true,
        timeout: 30000,
      }
    : undefined,
});
