# Le Marché Noir des Gages

Jeu d'enchères clandestines pour une soirée entre amis : on met un gage aux
enchères, on mise **en gorgées**, le plus offrant remporte le droit de désigner
qui fait le gage — et boit ce qu'il a misé.

Une tablette ou un téléphone branché à la TV sert d'**écran central**. Les autres
joueurs scannent un QR code et enchérissent depuis leur propre téléphone.
Aucun compte, aucune application à installer.

---

## Mode d'emploi du soir J

1. Sur la tablette branchée à la TV, ouvre le lien, choisis **« Écran central »**,
   tape les 9 prénoms, puis **« Ouvrir la salle des ventes »**.
2. Un QR code s'affiche : chacun le scanne avec l'appareil photo de son téléphone
   et choisit son prénom. (Le bouton **« Afficher le QR »** le remet à l'écran
   pour un retardataire.)
3. Sur la TV : choisis un gage (ou écris le tien), règle la durée, **« Mettre en
   vente »**. Les autres tapent **+1** autant qu'ils veulent.
4. À la fin du minuteur, **« Valider et inscrire à l'ardoise »**. Le gagnant
   annonce à voix haute qui fait le gage. On recommence.

Si le WiFi te lâche complètement, il reste le **mode secours** (lien en bas de
l'accueil) : tout se joue sur un seul écran, sans réseau.

---

## Comment ça marche

| | |
|---|---|
| Hébergement | GitHub Pages (statique, gratuit, permanent) |
| Temps réel | MQTT sur WebSocket sécurisé, brokers publics — aucun compte, aucune clé |
| Dépendances | `mqtt.js` et `qrcode-generator`, servis depuis le site (aucun CDN externe) |

**L'écran central est la seule autorité.** Il détient l'état de la partie, applique
les mises et republie l'état complet en message *retained* : un téléphone qui
arrive en retard reçoit donc l'état courant à la seconde où il s'abonne.

**Les téléphones n'envoient jamais un montant absolu**, seulement une intention
(« monte de +1 »). C'est l'écran central qui calcule `meilleure offre + 1`. Deux
personnes qui tapent exactement en même temps ne peuvent donc pas se marcher
dessus : les deux mises comptent, dans l'ordre où elles arrivent.

**Les taps rapprochés sont regroupés** (fenêtre de 90 ms) en un seul message,
pour que dix taps d'affilée fassent bien +10 sans inonder le réseau.

**Choix du serveur.** La première lettre du code de salle désigne le broker
utilisé (`A` = EMQX, `B` = HiveMQ, `C` = Mosquitto, `D` = Eclipse). L'écran
central retient le premier qui répond ; les téléphones savent donc où le
rejoindre en lisant simplement le code. Si un broker tombe entre deux soirées,
il suffit d'ouvrir une nouvelle salle : elle basculera toute seule sur un autre.

**Ce qui est visible en cas de panne** : un bandeau en haut de l'écran indique
`Ligne sécurisée` / `Connexion au marché…` / `Hors ligne`, et les téléphones
préviennent explicitement si l'écran central se déconnecte.

---

## Vérifications automatisées

```bash
npm install
npx playwright install chromium

npm test                # scénario complet, broker MQTT local, 3 navigateurs isolés
node test/sonde-brokers.js   # les brokers publics répondent-ils encore ?
URL_APP=https://… node test/e2e.js --public   # même scénario contre le site en ligne
```

`test/e2e.js` ouvre trois contextes de navigateur séparés (un écran central,
deux téléphones, plus un retardataire) et vérifie notamment :

- une mise faite sur un téléphone apparaît sur l'écran central **et** sur l'autre
  téléphone ;
- dix taps rapides sont comptés exactement, sans perte ni doublon ;
- un retardataire qui arrive en cours d'enchère récupère l'état courant ;
- l'adjudication met bien à jour l'ardoise partout ;
- une mise dans les 3 dernières secondes prolonge l'enchère ;
- un téléphone coupé du réseau l'affiche, puis se reconnecte tout seul.

Ces tests tournent aussi dans GitHub Actions (`.github/workflows/verification.yml`),
en local et contre l'URL publique.

---

## Fichiers

```
index.html        écran d'accueil + écran central + écran joueur
app.js            toute la logique (transport, enchères, ardoise, interface)
style.css         direction artistique
solo.html         mode secours, un seul écran, sans réseau
vendor/           mqtt.js et qrcode-generator, figés dans le dépôt
test/             bac à sable local et scénarios de bout en bout
```
