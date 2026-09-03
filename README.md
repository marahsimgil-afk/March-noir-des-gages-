# Le Marché Noir des Gages

Jeu d'enchères clandestines pour une soirée entre amis : on met un gage aux
enchères, on mise **en gorgées**, le plus offrant remporte le droit de désigner
qui fait le gage — et boit ce qu'il a misé.

Une tablette ou un téléphone branché à la TV sert d'**écran central**. Les autres
joueurs scannent un QR code et enchérissent depuis leur propre téléphone.
Aucun compte, aucune application à installer.

---

## Mettre l'application en ligne (une seule fois, ~30 secondes)

L'hébergement est gratuit et permanent, mais GitHub demande une autorisation
qu'un robot n'a pas le droit de donner à ma place. À faire une fois :

1. Ouvrir **https://github.com/marahsimgil-afk/March-noir-des-gages-/settings/pages**
2. Sous **Source**, choisir **Deploy from a branch**
3. **Branch** : `claude/marche-noir-gages-app-dolp68` — dossier `/ (root)` — **Save**
4. Attendre une minute, puis ouvrir :

   **https://marahsimgil-afk.github.io/March-noir-des-gages-/**

C'est cette adresse qui devient le lien de la soirée. Elle ne change plus.

---

## Mode d'emploi du soir J

1. Sur la tablette branchée à la TV, ouvre le lien, choisis **« Écran central »**,
   tape les prénoms (dix places sont proposées), puis **tous les gages d'un coup** — un par ligne, dans
   l'ordre où tu veux les vendre. **« Ouvrir la salle des ventes »**.
2. Un QR code s'affiche : chacun le scanne avec l'appareil photo de son téléphone
   et choisit son prénom. (Le bouton **« Afficher le QR »** le remet à l'écran
   pour un retardataire.)
3. Le premier gage est déjà affiché. Choisis la durée (10, 15, 20 ou 30 s),
   **« Démarrer l'enchère »**. Les autres tapent **+1** autant qu'ils veulent.
4. À la fin, **« Valider et inscrire à l'ardoise »** : le gage suivant s'affiche
   tout seul. Plus rien à taper — durée, démarrer, valider, et on enchaîne.
5. Au dernier gage, le **Registre** s'ouvre de lui-même : l'ardoise finale de
   chacun et qui a acheté quoi. Chaque téléphone affiche son propre relevé.

Tu peux à tout moment **passer un lot**, **ajouter des gages** en cours de route,
ou rouvrir le **Récapitulatif**.

Si le WiFi te lâche complètement, il reste le **mode secours** (lien en bas de
l'accueil) : tout se joue sur un seul écran, sans réseau.

---

## Comment ça marche

| | |
|---|---|
| Hébergement | GitHub Pages (statique, gratuit, permanent) |
| Temps réel | MQTT sur WebSocket sécurisé, brokers publics — aucun compte, aucune clé |
| Dépendances | `mqtt.js` et `qrcode-generator`, servis depuis le site (aucun CDN externe) |

Les CDN qui servent les dépôts publics (jsDelivr, statically, githack) ont été
essayés et écartés, mesures à l'appui : ils renvoient le HTML en `text/plain`
ou intercalent leur propre page d'avertissement, et l'application ne démarre
jamais. GitHub Pages est la seule voie qui sert vraiment la page.

**Le programme est la colonne vertébrale.** Tous les gages sont saisis avant
l'ouverture de la salle ; chaque entrée garde ensuite son résultat (vendu à qui,
pour combien, ou passé). Le panneau « lot suivant », l'historique et le
récapitulatif final ne sont que trois lectures de cette même liste — il n'y a
pas de comptes tenus en double.

**L'écran central est la seule autorité.** Il détient l'état de la partie, applique
les mises et republie l'état complet en message *retained* : un téléphone qui
arrive en retard reçoit donc l'état courant à la seconde où il s'abonne.

**Les téléphones n'envoient jamais un montant absolu**, seulement une intention
(« monte de +1 »). C'est l'écran central qui calcule `meilleure offre + 1`. Deux
personnes qui tapent exactement en même temps ne peuvent donc pas se marcher
dessus : les deux mises comptent, dans l'ordre où elles arrivent.

**Les prolongations sont plafonnées.** Une mise dans les 3 dernières secondes
relance le marteau à 3 s — sinon un joueur peut emporter le lot en misant à la
toute dernière fraction de seconde. Mais au-delà de deux prolongations, plus
rien ne rallonge l'enchère : sans ce plafond, deux joueurs obstinés font monter
le montant indéfiniment, trois secondes à la fois. L'écran annonce
« Prolongation 1 / 2 », puis « Dernière prolongation ».

**Les taps rapprochés sont regroupés** (fenêtre de 90 ms) en un seul message,
pour que dix taps d'affilée fassent bien +10 sans inonder le réseau.

**Choix du serveur.** La première lettre du code de salle désigne le broker
utilisé (`A` = EMQX, `B` = HiveMQ, `C` = Mqtt Dashboard, `D` = EMQX bis).
L'écran central retient le premier qui répond ; les téléphones savent donc où
le rejoindre en lisant simplement le code. Si un broker tombe entre deux
soirées, il suffit d'ouvrir une nouvelle salle : elle basculera toute seule sur
un autre. Cette liste n'est pas choisie au jugé : `test/sonde-brokers.js` vérifie
en continu que chacun accepte connexion, publication *retained* et abonnement.

**Ce qu'il faut savoir** : les brokers publics sont ouverts à tous. Les prénoms
et les ardoises transitent donc en clair sous un sujet tiré au hasard (5
caractères, plus de 30 millions de combinaisons) : personne ne tombera dessus
par accident, mais ce n'est pas un canal secret. Pour un jeu à boire entre
amis, c'est le bon compromis ; n'y mettez pas de gages que vous ne diriez pas
à voix haute.

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
- une mise dans les 3 dernières secondes prolonge l'enchère, mais deux fois au
  maximum : même en misant sans arrêt, le marteau finit par tomber ;
- les lots s'enchaînent tout seuls dans l'ordre du programme ;
- le récapitulatif s'ouvre de lui-même au dernier lot, avec l'ardoise de chacun
  et la liste de qui a acheté quoi ;
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
