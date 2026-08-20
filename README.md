# Le Marché Noir des Gages

Jeu d'enchères clandestines pour une soirée entre amis : un gage est mis aux
enchères, on mise en **gorgées**, le plus offrant remporte le lot — et boit ce
qu'il a misé. L'écran central (TV) mène la vente, chaque joueur enchérit depuis
son téléphone, tout est synchronisé en temps réel.

Aucun compte, aucune installation : les joueurs scannent un QR code.

---

## Le soir J — 4 étapes

1. **Sur la TV** (ou la tablette branchée dessus) : ouvre le lien, choisis
   **Écran central**, tape les 9 prénoms, puis **Ouvrir la vente**.
2. **Le QR code s'affiche.** Chacun le scanne avec l'appareil photo de son
   téléphone et tape son prénom. Le bouton **QR** en haut à droite le
   réaffiche à tout moment pour les retardataires.
3. **Choisis un gage** (liste déroulante, ou tape le tien), règle le minuteur,
   **Ouvre l'enchère**. Les téléphones font monter les gorgées en direct.
4. À la fin du minuteur, clique **Adjugé ! Valider** : l'ardoise du gagnant est
   créditée. Il annonce à voix haute qui fait le gage. Lot suivant.

> **Si le réseau lâche** : l'écran central fonctionne seul. Ouvre le lot,
> déplie **Ajout manuel** dans la colonne de droite et saisis les mises que les
> joueurs annoncent à voix haute. La soirée continue.

> **Si un téléphone ne se connecte pas** : depuis l'accueil de l'app, le lien
> *Tester ma connexion* dit en 5 secondes si l'appareil peut jouer. Souvent, il
> suffit de basculer Wi-Fi ↔ 4G.

L'écran central peut être rechargé sans rien perdre : les ardoises, l'historique
et le code de la vente sont conservés sur l'appareil.

---

## Comment c'est fait

Une page statique, sans serveur à héberger et sans compte à créer.

- **Synchronisation** : MQTT over WebSocket sur des brokers publics
  (`broker.emqx.io`, puis `broker.hivemq.com`, puis `test.mosquitto.org` en
  bascule automatique). Chaque vente utilise un code aléatoire à 5 caractères
  qui sert de préfixe de sujet.
- **L'écran central fait autorité.** Il publie l'état complet de la vente en
  message *retenu* : un téléphone qui arrive en retard reçoit immédiatement la
  situation exacte.
- **Aucune mise ne peut être perdue.** Un téléphone ne publie pas « +1 » mais
  *son total cumulé* sur le lot en cours, et le rejoue tant que l'écran central
  ne l'a pas acquitté. Un message égaré, une coupure de réseau ou un téléphone
  en veille se rattrapent tout seuls.
- **Pannes visibles** : le voyant de connexion ne ment pas, et un bandeau
  explique quoi faire. Si plus rien n'arrive de l'écran central pendant 6
  secondes, le téléphone force une reconnexion.

### Fichiers

| Chemin | Rôle |
|---|---|
| `docs/index.html` | Les écrans (accueil, configuration, TV, téléphone, diagnostic) |
| `docs/app.js` | Transport temps réel, logique d'enchère, rendu |
| `docs/style.css` | Direction artistique noir / laiton / rouge |
| `docs/lib/` | `mqtt.js` et `qrcode` embarqués (aucun CDN au chargement) |
| `test/serve.mjs` | Banc de test local : broker MQTT + serveur statique |
| `test/e2e.mjs` | Test multi-appareils (Playwright) |

### Tester en local

```bash
npm install
npm run serve     # dans un terminal
npm test          # dans un autre
```

`npm test` ouvre 10 navigateurs isolés (un écran central + huit téléphones + un
retardataire) et vérifie 42 points : propagation des mises, minuteur,
adjudication, ardoises, charge à 160 mises simultanées, coupure de réseau,
rechargement de page et mode secours hors-ligne.

Le même test est rejoué par GitHub Actions contre l'application **réellement en
ligne** et les **brokers publics réels** (`.github/workflows/en-ligne.yml`).
