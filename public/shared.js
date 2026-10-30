// Code partagé entre le serveur (Node) et le client (navigateur).
// Le déplacement doit être IDENTIQUE des deux côtés pour que la prédiction fonctionne.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const W = 1280;
  const H = 720;
  const MARGIN = 56;
  const RADIUS = 24; // rayon du corps
  const STEP = 1 / 30; // pas d'une entrée joueur (30 par seconde)
  const SPEED = 230; // px/s
  const BLOCK_SPEED = 0.45; // multiplicateur quand on se protège

  // États dans lesquels le joueur peut se déplacer librement
  const MOVABLE = { idle: 1, run: 1, block: 1 };

  // Attaques : durée totale, moment de l'impact, dégâts, portée, demi-angle, recul
  const ATK = {
    atk1: { dur: 520, hit: 270, dmg: 12, range: 92, arc: 1.0, kb: 40 },
    atk2: { dur: 700, hit: 340, dmg: 20, range: 104, arc: 1.1, kb: 90 },
    spin: { dur: 900, hit: 330, dmg: 22, range: 118, arc: Math.PI, kb: 110, cd: 4000 },
  };
  const ROLL = { dur: 480, speed: 440, invFrom: 60, invTo: 360, cd: 1200 };
  const HURT_DUR = 380;
  const GUARD_BREAK_DUR = 1000;
  const DIE_DUR = 1300;

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  function clampArena(p) {
    p.x = clamp(p.x, MARGIN, W - MARGIN);
    p.y = clamp(p.y, MARGIN + 20, H - MARGIN);
  }

  // Applique UNE entrée (1/30 s) à un joueur {x,y}
  function applyMove(p, mx, my, blocking) {
    const len = Math.hypot(mx, my);
    if (len > 0.01) {
      const k = (SPEED * (blocking ? BLOCK_SPEED : 1) * STEP) / Math.max(1, len);
      p.x += mx * k;
      p.y += my * k;
    }
    clampArena(p);
  }

  // Différence d'angle signée, entre -PI et PI
  function angDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  // Rangée du spritesheet (8 directions) selon l'angle de visée (repère écran, y vers le bas)
  // Rangées : 0=S 1=SO 2=O 3=NO 4=N 5=NE 6=E 7=SE
  function dirRow(angle) {
    let deg = (angle * 180) / Math.PI;
    deg = ((deg % 360) + 360) % 360;
    return (Math.round((deg - 90) / 45) + 8) % 8;
  }

  return {
    W, H, MARGIN, RADIUS, STEP, SPEED, BLOCK_SPEED, MOVABLE,
    ATK, ROLL, HURT_DUR, GUARD_BREAK_DUR, DIE_DUR,
    clamp, clampArena, applyMove, angDiff, dirRow,
  };
});
