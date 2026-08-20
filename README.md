# Le Marché Noir des Gages

Jeu d'enchères clandestines pour une soirée entre amis. Un lot — un gage ou un
droit — est mis en vente ; chacun enchérit **en gorgées de bière**, sans plafond,
depuis son téléphone. Le plus offrant remporte le lot et désigne qui exécute le
gage. Son ardoise s'alourdit d'autant.

**L'application est en ligne ici : https://marahsimgil-afk.github.io/March-noir-des-gages-/**

---

## Le soir J

1. Sur la tablette branchée à la TV, ouvrir le lien, choisir **« Ouvrir la salle
   des ventes »**, taper les 9 prénoms, valider.
2. Le **QR code** s'affiche tout seul. Chacun le scanne avec l'appareil photo de
   son téléphone, puis tape son prénom. (Le bouton « Afficher le QR code » le
   remontre à tout moment, pour les retardataires.)
3. Choisir un gage — dans la liste ou en le tapant — puis **« Ouvrir les
   enchères »**. Les téléphones affichent un gros bouton « +1 gorgée ».
4. À la fin du minuteur, la TV affiche **Adjugé**. Cliquer sur **« Valider »**
   pour porter les gorgées à l'ardoise du gagnant, et enchaîner.

Si le voyant en haut à gauche de la TV est **vert**, tout le monde est synchronisé.
S'il passe au rouge, l'écran l'explique en clair.

**Filet de sécurité :** en cas de wifi impraticable,
[la version mono-écran](https://marahsimgil-afk.github.io/March-noir-des-gages-/solo.html)
fonctionne sans aucune connexion — un seul appareil circule.

---

## Comment ça marche

Site statique sur GitHub Pages ; synchronisation temps réel en **MQTT sur
WebSocket** via des brokers publics (aucun compte à créer, ça passe en 4G comme
derrière le wifi d'une location).

L'**écran central fait autorité** : lui seul modifie l'état de la partie. Les
téléphones lui envoient des commandes idempotentes et reçoivent des instantanés
complets. Trois conséquences utiles :

- **Aucune mise perdue.** Chaque tap porte un identifiant unique et est ré-émis
  jusqu'à son acquittement ; l'écran central dédoublonne. Neuf personnes qui
  tapent en même temps ne peuvent pas s'écraser mutuellement.
- **Reprise immédiate.** L'état est publié en message *retenu* : un téléphone qui
  arrive en cours d'enchère, ou qui a perdu le réseau, se resynchronise dès la
  reconnexion.
- **Panne de broker absorbée.** Trois brokers sont configurés ; les téléphones
  retrouvent tout seuls celui qu'utilise l'écran central.

L'état de la TV est sauvegardé localement : un rechargement d'onglet ne fait pas
perdre les ardoises.

### Fichiers

| Chemin | Rôle |
| --- | --- |
| `public/js/game.js` | Les règles, sans DOM ni réseau — testables unitairement |
| `public/js/net.js` | Transport MQTT, bascule de broker, ré-émission des commandes |
| `public/js/central.js` | Écran TV (arbitre) |
| `public/js/player.js` | Écran téléphone |
| `public/solo.html` | Version de secours mono-écran, hors ligne |

## Tests

```bash
npm install
npm run test:unit     # règles du jeu
npm test              # + suite multi-appareils (broker MQTT local, navigateurs séparés)
npm run brokers       # état des brokers publics
```

La suite bout-en-bout ouvre un contexte navigateur par appareil simulé et couvre :
propagation d'une mise, égalité départagée par l'ordre d'arrivée, rafale de huit
téléphones simultanés, coupure réseau et reprise, retardataire, rechargement de
la TV, clôture automatique au minuteur, et la version de secours.

Le workflow **Vérification en conditions réelles** rejoue cette même suite depuis
un runner GitHub contre l'URL publique et les vrais brokers, chaque semaine et
après chaque déploiement.
