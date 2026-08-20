/* Tests unitaires des règles du jeu (aucune dépendance, `node tests/unit-game.js`). */
const assert = require('assert');
const MNG = require('../public/js/game.js');

let ok = 0;
function test(nom, fn) {
  fn();
  ok++;
  console.log('  ✓ ' + nom);
}

const T0 = 1700000000000;
function partie() {
  return MNG.createState('ABCDE', ['Léa', 'Tom', 'Nour'], T0);
}
function bid(state, p, n, at, id) {
  return MNG.applyCommand(state, { id: id || 'c' + Math.random(), t: 'bid', p, n }, at);
}

console.log('Règles du jeu');

test('création : trois joueurs, ardoises à zéro', () => {
  const s = partie();
  assert.strictEqual(s.players.length, 3);
  assert.deepStrictEqual(s.players.map((p) => p.tab), [0, 0, 0]);
  assert.strictEqual(s.phase, 'lobby');
});

test('ouverture d’un lot : minuteur armé', () => {
  const s = partie();
  assert.strictEqual(MNG.openLot(s, 'Danser seul', 30, T0), true);
  assert.strictEqual(s.phase, 'open');
  assert.strictEqual(s.endsAt, T0 + 30000);
  assert.strictEqual(MNG.remainingMs(s, T0 + 10000), 20000);
});

test('les mises s’additionnent sans plafond', () => {
  const s = partie();
  MNG.openLot(s, 'Lot', 30, T0);
  for (let i = 0; i < 40; i++) bid(s, 'p1', 1, T0 + 1000);
  bid(s, 'p1', 5, T0 + 1000);
  assert.strictEqual(s.bids.p1, 45);
});

test('une commande ré-émise n’est comptée qu’une fois', () => {
  const s = partie();
  MNG.openLot(s, 'Lot', 30, T0);
  const cmd = { id: 'X1', t: 'bid', p: 'p1', n: 3 };
  const a = MNG.applyCommand(s, cmd, T0 + 1000);
  const b = MNG.applyCommand(s, cmd, T0 + 1100);
  const c = MNG.applyCommand(s, cmd, T0 + 1200);
  assert.deepStrictEqual([a.applied, b.applied, c.applied], [true, false, false]);
  assert.strictEqual(s.bids.p1, 3);
});

test('toute commande reçue est acquittée, même refusée', () => {
  const s = partie();
  MNG.applyCommand(s, { id: 'Y1', t: 'bid', p: 'p1', n: 2 }, T0); // phase lobby : refusée
  assert.strictEqual(MNG.isAcked(s, 'Y1'), true);
  assert.strictEqual(s.bids.p1, undefined);
});

test('égalité : le premier arrivé mène', () => {
  const s = partie();
  MNG.openLot(s, 'Lot', 30, T0);
  bid(s, 'p1', 5, T0 + 1000);
  bid(s, 'p2', 5, T0 + 2000);
  assert.strictEqual(MNG.leader(s).id, 'p1');
  bid(s, 'p2', 1, T0 + 3000);
  assert.strictEqual(MNG.leader(s).id, 'p2');
});

test('mise arrivée dans la marge de tolérance : acceptée', () => {
  const s = partie();
  MNG.openLot(s, 'Lot', 30, T0);
  bid(s, 'p1', 4, s.endsAt + MNG.GRACE_MS - 1);
  assert.strictEqual(s.bids.p1, 4);
});

test('mise arrivée trop tard : refusée, sans effet', () => {
  const s = partie();
  MNG.openLot(s, 'Lot', 30, T0);
  bid(s, 'p1', 4, s.endsAt + MNG.GRACE_MS + 50);
  assert.strictEqual(s.bids.p1, undefined);
});

test('clôture puis validation : l’ardoise du gagnant grossit', () => {
  const s = partie();
  MNG.openLot(s, 'Chapeau ridicule', 30, T0);
  bid(s, 'p1', 3, T0 + 1000);
  bid(s, 'p2', 7, T0 + 2000);
  MNG.closeLot(s, T0 + 30000);
  assert.strictEqual(s.result.winnerId, 'p2');
  assert.strictEqual(s.result.amount, 7);
  MNG.settle(s, T0 + 31000);
  assert.strictEqual(MNG.player(s, 'p2').tab, 7);
  assert.strictEqual(MNG.player(s, 'p1').tab, 0); // seul le gagnant paie
  assert.strictEqual(s.history.length, 1);
  assert.strictEqual(s.phase, 'lobby');
});

test('les ardoises se cumulent sur plusieurs lots', () => {
  const s = partie();
  for (const [p, n] of [['p1', 4], ['p1', 6], ['p3', 2]]) {
    MNG.openLot(s, 'Lot', 30, T0);
    bid(s, p, n, T0 + 500);
    MNG.closeLot(s, T0 + 30000);
    MNG.settle(s, T0 + 31000);
  }
  assert.strictEqual(MNG.player(s, 'p1').tab, 10);
  assert.strictEqual(MNG.player(s, 'p3').tab, 2);
  assert.strictEqual(s.history.length, 3);
});

test('lot sans aucune offre : invendu, personne ne paie', () => {
  const s = partie();
  MNG.openLot(s, 'Lot', 30, T0);
  MNG.closeLot(s, T0 + 30000);
  assert.strictEqual(s.result.winnerId, null);
  MNG.settle(s, T0 + 31000);
  assert.deepStrictEqual(s.players.map((p) => p.tab), [0, 0, 0]);
});

test('annulation : rien n’est encaissé ni historisé', () => {
  const s = partie();
  MNG.openLot(s, 'Lot', 30, T0);
  bid(s, 'p1', 9, T0 + 1000);
  MNG.closeLot(s, T0 + 30000);
  MNG.cancelLot(s);
  assert.strictEqual(MNG.player(s, 'p1').tab, 0);
  assert.strictEqual(s.history.length, 0);
  assert.strictEqual(s.phase, 'lobby');
});

test('rafale de neuf joueurs : total exact, rien de perdu', () => {
  const s = MNG.createState('ZZZZZ', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], T0);
  MNG.openLot(s, 'Lot', 60, T0);
  let n = 0;
  for (let tour = 0; tour < 30; tour++) {
    for (let j = 1; j <= 9; j++) {
      bid(s, 'p' + j, 1, T0 + 1000 + tour, 'r' + tour + '-' + j);
      n++;
    }
  }
  const total = Object.values(s.bids).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, n);
  assert.strictEqual(s.bids.p1, 30);
});

test('déduplication toujours valide après un long flot de commandes', () => {
  const s = partie();
  MNG.openLot(s, 'Lot', 60, T0);
  for (let i = 0; i < 500; i++) bid(s, 'p1', 1, T0 + 1000, 'flot' + i);
  const avant = s.bids.p1;
  // Une ré-émission tardive d'une commande récente ne doit pas repasser.
  const res = MNG.applyCommand(s, { id: 'flot499', t: 'bid', p: 'p1', n: 1 }, T0 + 2000);
  assert.strictEqual(res.applied, false);
  assert.strictEqual(s.bids.p1, avant);
});

test('l’instantané réseau reste compact', () => {
  const s = MNG.createState('ZZZZZ', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], T0);
  MNG.openLot(s, 'Un gage plutôt long comme titre de lot pour voir', 60, T0);
  for (let i = 0; i < 400; i++) bid(s, 'p' + ((i % 9) + 1), 1, T0 + 1000, 'k' + i);
  const taille = JSON.stringify(MNG.snapshot(s, T0 + 2000)).length;
  assert.ok(taille < 8000, 'instantané de ' + taille + ' octets, attendu < 8000');
});

test('le code de salle évite les caractères ambigus', () => {
  for (let i = 0; i < 200; i++) {
    assert.ok(/^[ACDEFGHJKLMNPQRTUVWXYZ2346789]{5}$/.test(MNG.makeCode()));
  }
});

console.log('\n' + ok + ' tests unitaires passés.\n');
