const { defineConfig } = require('@playwright/test');
const fs = require('fs');

// Certains environnements fournissent déjà un Chromium, dont la révision ne
// correspond pas forcément à celle attendue par @playwright/test. On l'utilise
// tel quel plutôt que d'en télécharger un second.
const CHROMIUM_FOURNI = '/opt/pw-browsers/chromium';
const executablePath = fs.existsSync(CHROMIUM_FOURNI) ? CHROMIUM_FOURNI : undefined;

// Contre l'infra publique (URL GitHub Pages + brokers MQTT publics), on ne lance
// pas de serveur local et on laisse plus de marge aux latences réseau.
const CIBLE_LOCALE = !process.env.MNG_BASE;

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  timeout: CIBLE_LOCALE ? 90000 : 180000,
  expect: { timeout: 10000 },
  // Les tests partagent des brokers publics : on les sérialise pour que les
  // rafales de l'un ne faussent pas les mesures de l'autre.
  workers: 1,
  fullyParallel: false,
  retries: CIBLE_LOCALE ? 0 : 1,
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
