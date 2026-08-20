/* Génère docs/solo.html : l'application entière dans un seul fichier.
   Utile à deux titres — aucun sous-fichier à servir (donc insensible aux
   types MIME approximatifs d'un CDN), et un fichier unique que l'on peut
   garder en secours sur un téléphone ou une clé USB. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const lire = (f) => fs.readFileSync(path.join(DOCS, f), 'utf8');
// « </script » dans du code JS ne peut apparaître que dans une chaîne ou une
// expression régulière : on le neutralise pour ne pas fermer la balise.
const sur = (js) => js.replace(/<\/script/gi, '<\\/script');

let html = lire('index.html');

html = html.replace(/[ \t]*<link rel="stylesheet" href="style\.css">\n/,
  '<style>\n' + lire('style.css') + '</style>\n');

html = html.replace(/[ \t]*<script src="([^"]+)"><\/script>\n/g, (_, src) =>
  '<script>\n' + sur(lire(src)) + '\n</script>\n');

// Les polices distantes restent facultatives : la page fonctionne sans elles.
if (/<script src=|<link rel="stylesheet" href="style/.test(html)) {
  console.error('Des ressources locales n’ont pas été intégrées.');
  process.exit(1);
}

html = html.replace('<title>Le Marché Noir des Gages</title>',
  '<title>Le Marché Noir des Gages</title>\n<!-- Fichier unique et autonome — engendré par tools/bundle.mjs, ne pas modifier à la main. -->');

fs.writeFileSync(path.join(DOCS, 'solo.html'), html);
console.log('docs/solo.html — ' + Math.round(html.length / 1024) + ' Ko');
