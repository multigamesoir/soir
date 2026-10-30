const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const S = require("./public/shared.js");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const TICK_MS = 1000 / 30;
const COUNTDOWN_MS = 3000;
const OVER_MS = 6000;
const COLORS = ["#d9534f", "#4a9be8", "#5fb89a", "#e0b04a"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // pas de I ni O

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.send("ok"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/** @type {Map<string, any>} */
const rooms = new Map();

// ---------- Utilitaires ----------
function makeCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = "";
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

function cleanName(n) {
  n = String(n || "").replace(/[^\p{L}\p{N} _\-'.]/gu, "").trim().slice(0, 14);
  return n || "Chevalier";
}

function newPlayer(id, name, color) {
  return {
    id, name, color,
    x: S.W / 2, y: S.H / 2, hp: 100, guard: 100,
    aim: Math.PI / 2, state: "idle", t0: 0, dur: 0, hitDone: false,
    kx: 0, ky: 0, rdx: 0, rdy: 0,
    cdSpin: 0, cdRoll: 0,
    alive: true, seq: 0, wins: 0, kills: 0,
    tokens: 60, lastTok: Date.now(),
  };
}

function setState(p, st, now, dur) {
  p.state = st;
  p.t0 = now;
  p.dur = dur || 0;
  p.hitDone = false;
}

function lobbyInfo(room) {
  return {
    code: room.code,
    host: room.hostId,
    state: room.state,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, color: p.color, wins: p.wins,
    })),
  };
}

function sendLobby(room) {
  io.to(room.code).emit("lobby", lobbyInfo(room));
}

function firstFreeColor(room) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[0];
}

// ---------- Cycle d'une manche ----------
function startMatch(room, now) {
  const list = [...room.players.values()];
  const n = list.length;
  list.forEach((p, i) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    p.x = S.W / 2 + Math.cos(a) * 280;
    p.y = S.H / 2 + Math.sin(a) * 170 + 10;
    p.aim = Math.atan2(S.H / 2 - p.y, S.W / 2 - p.x);
    p.hp = 100; p.guard = 100; p.alive = true; p.kills = 0;
    p.kx = p.ky = 0; p.cdSpin = p.cdRoll = 0;
    setState(p, "idle", now);
  });
  room.state = "countdown";
  room.cdEnd = now + COUNTDOWN_MS;
  room.winner = null;
  room.ev = [];
  sendLobby(room);
}

function endMatch(room, now) {
  const alive = [...room.players.values()].filter((p) => p.alive);
  const w = alive.length === 1 ? alive[0] : null;
  if (w) w.wins++;
  room.winner = w ? w.id : null;
  room.state = "over";
  room.overEnd = now + OVER_MS;
  sendLobby(room);
}

function backToLobby(room) {
  room.state = "lobby";
  room.winner = null;
  for (const p of room.players.values()) {
    p.alive = true; p.hp = 100; p.guard = 100;
    setState(p, "idle", Date.now());
  }
  sendLobby(room);
}

// ---------- Combat ----------
function resolveHit(room, a, def, now) {
  for (const o of room.players.values()) {
    if (o === a || !o.alive) continue;
    const dx = o.x - a.x;
    const dy = o.y - a.y;
    const dist = Math.hypot(dx, dy) || 0.001;
    if (dist > def.range + S.RADIUS) continue;
    if (def.arc < Math.PI) {
      if (Math.abs(S.angDiff(Math.atan2(dy, dx), a.aim)) > def.arc) continue;
    }

    // Roulade : invincible pendant une courte fenêtre
    if (o.state === "roll") {
      const e = now - o.t0;
      if (e >= S.ROLL.invFrom && e <= S.ROLL.invTo) {
        room.ev.push({ k: "dodge", x: o.x, y: o.y - 40 });
        continue;
      }
    }

    let dmg = def.dmg;
    let blocked = false;
    let guardBroken = false;
    if (o.state === "block") {
      const toAttacker = Math.atan2(-dy, -dx);
      if (Math.abs(S.angDiff(toAttacker, o.aim)) <= Math.PI * 0.45) {
        blocked = true;
        dmg = Math.max(1, Math.round(def.dmg * 0.12));
        o.guard -= def.dmg * 2.2;
        if (o.guard <= 0) { o.guard = 0; guardBroken = true; }
      }
    }

    o.hp = Math.max(0, o.hp - dmg);
    const push = def.kb * (blocked ? 0.3 : 1) * 4.8; // vitesse initiale, voir tick()
    o.kx = (dx / dist) * push;
    o.ky = (dy / dist) * push;
    room.ev.push({ k: "hit", x: o.x, y: o.y - 40, d: dmg, b: blocked ? 1 : 0, by: a.id, to: o.id });

    if (o.hp <= 0) {
      o.alive = false;
      a.kills++;
      setState(o, "dead", now, S.DIE_DUR);
      room.ev.push({ k: "ko", x: o.x, y: o.y - 40, id: o.id });
    } else if (guardBroken) {
      setState(o, "hurt", now, S.GUARD_BREAK_DUR);
      room.ev.push({ k: "gb", x: o.x, y: o.y - 60 });
    } else if (!blocked && S.MOVABLE[o.state]) {
      setState(o, "hurt", now, S.HURT_DUR);
    }
  }
}

function tick(room, now) {
  const dt = TICK_MS / 1000;

  if (room.state === "countdown" && now >= room.cdEnd) {
    room.state = "playing";
    for (const p of room.players.values()) setState(p, "idle", now);
    sendLobby(room);
  }

  if (room.state === "playing" || room.state === "over") {
    for (const p of room.players.values()) {
      const e = now - p.t0;
      const atk = S.ATK[p.state];

      if (p.alive && room.state === "playing") {
        if (atk) {
          if (!p.hitDone && e >= atk.hit) {
            p.hitDone = true;
            resolveHit(room, p, atk, now);
          }
          if (p.alive && e >= atk.dur) setState(p, "idle", now);
        } else if (p.state === "roll") {
          p.x += p.rdx * S.ROLL.speed * dt;
          p.y += p.rdy * S.ROLL.speed * dt;
          if (e >= S.ROLL.dur) setState(p, "idle", now);
        } else if (p.state === "hurt") {
          if (e >= p.dur) setState(p, "idle", now);
        }
        if (p.state !== "block" && p.guard < 100) p.guard = Math.min(100, p.guard + 14 * dt);
      }

      // Recul (décroissance exponentielle)
      if (Math.abs(p.kx) > 1 || Math.abs(p.ky) > 1) {
        p.x += p.kx * dt;
        p.y += p.ky * dt;
        p.kx *= 0.84;
        p.ky *= 0.84;
      }
    }

    // Collisions entre corps (sauf pendant la roulade)
    const list = [...room.players.values()].filter((p) => p.alive && p.state !== "roll");
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const min = S.RADIUS * 2;
        if (d < min && d > 0.001) {
          const push = (min - d) / 2;
          a.x -= (dx / d) * push; a.y -= (dy / d) * push;
          b.x += (dx / d) * push; b.y += (dy / d) * push;
        }
      }
    }
    for (const p of room.players.values()) S.clampArena(p);

    if (room.state === "playing") {
      const alive = [...room.players.values()].filter((p) => p.alive);
      if (alive.length <= 1) endMatch(room, now);
    }
  }

  if (room.state === "over" && now >= room.overEnd) backToLobby(room);

  if (room.state !== "lobby") broadcast(room, now);
}

function broadcast(room, now) {
  const r1 = (v) => Math.round(v * 10) / 10;
  const snap = {
    n: room.state,
    c: room.state === "countdown" ? Math.max(0, room.cdEnd - now) : 0,
    w: room.winner,
    o: room.state === "over" ? Math.max(0, room.overEnd - now) : 0,
    ps: [...room.players.values()].map((p) => ({
      i: p.id, x: r1(p.x), y: r1(p.y), h: p.hp, g: Math.round(p.guard),
      s: p.state, a: now - p.t0, m: Math.round(p.aim * 100) / 100,
      q: p.seq, cs: Math.max(0, p.cdSpin - now), cr: Math.max(0, p.cdRoll - now),
      k: p.kills,
    })),
    ev: room.ev,
  };
  room.ev = [];
  io.to(room.code).volatile.emit("snap", snap);
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) tick(room, now);
}, TICK_MS);

// ---------- Sockets ----------
function leaveRoom(socket) {
  const code = socket.data.code;
  if (!code) return;
  socket.leave(code);
  socket.data.code = null;
  const room = rooms.get(code);
  if (!room) return;
  room.players.delete(socket.id);
  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }
  if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
  if (room.state === "playing" || room.state === "countdown") {
    if (room.players.size < 2) {
      // Il ne reste qu'un joueur : on arrête la manche
      if (room.state === "playing") endMatch(room, Date.now());
      else backToLobby(room);
    }
  }
  sendLobby(room);
}

function joinRoom(socket, room, name) {
  const p = newPlayer(socket.id, cleanName(name), firstFreeColor(room));
  room.players.set(socket.id, p);
  if (!room.hostId) room.hostId = socket.id;
  socket.join(room.code);
  socket.data.code = room.code;
  socket.emit("joined", { code: room.code, id: socket.id });
  sendLobby(room);
}

io.on("connection", (socket) => {
  socket.on("create", (d) => {
    leaveRoom(socket);
    const code = makeCode();
    if (!code) return socket.emit("err", "Impossible de créer un lobby, réessaie.");
    const room = { code, players: new Map(), hostId: null, state: "lobby", ev: [], winner: null };
    rooms.set(code, room);
    joinRoom(socket, room, d && d.name);
  });

  socket.on("join", (d) => {
    const code = String((d && d.code) || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    const room = rooms.get(code);
    if (!room) return socket.emit("err", "Ce code de lobby n'existe pas.");
    if (room.players.size >= MAX_PLAYERS) return socket.emit("err", "Le lobby est plein (4 joueurs max).");
    if (room.state !== "lobby") return socket.emit("err", "Un combat est en cours, réessaie dans quelques secondes.");
    leaveRoom(socket);
    joinRoom(socket, room, d && d.name);
  });

  socket.on("start", () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.hostId !== socket.id || room.state !== "lobby") return;
    if (room.players.size < 2) return socket.emit("err", "Il faut au moins 2 joueurs pour se battre.");
    startMatch(room, Date.now());
  });

  socket.on("leave", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));

  // Entrée de déplacement (30/s) : on l'applique immédiatement, comme le client l'a prédite
  socket.on("input", (d) => {
    const room = rooms.get(socket.data.code);
    if (!room || !d) return;
    const p = room.players.get(socket.id);
    if (!p) return;

    // Anti-spam : jeton par entrée, ~40 entrées/s max
    const now = Date.now();
    p.tokens = Math.min(60, p.tokens + ((now - p.lastTok) / 1000) * 40);
    p.lastTok = now;
    if (p.tokens < 1) return;
    p.tokens -= 1;

    p.seq = d.seq | 0;
    if (room.state !== "playing" || !p.alive || !S.MOVABLE[p.state]) return;

    let mx = Number(d.mx) || 0;
    let my = Number(d.my) || 0;
    mx = S.clamp(mx, -1, 1);
    my = S.clamp(my, -1, 1);
    const aim = Number(d.aim);
    if (Number.isFinite(aim)) p.aim = aim;

    const wantBlock = !!d.block && p.guard > 5;
    const moving = Math.hypot(mx, my) > 0.1;
    const next = wantBlock ? "block" : moving ? "run" : "idle";
    if (next !== p.state) setState(p, next, now);

    S.applyMove(p, mx, my, wantBlock);
  });

  // Actions : attaques et roulade
  socket.on("act", (d) => {
    const room = rooms.get(socket.data.code);
    if (!room || !d || room.state !== "playing") return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    // On peut enchaîner une roulade depuis le bouclier, mais pas une attaque
    const okState = p.state === "idle" || p.state === "run" || (p.state === "block" && d.t === "roll");
    if (!okState) return;

    const now = Date.now();
    const aim = Number(d.aim);
    if (Number.isFinite(aim)) p.aim = aim;

    if (d.t === "atk1" || d.t === "atk2") {
      setState(p, d.t, now);
    } else if (d.t === "spin") {
      if (now < p.cdSpin) return;
      p.cdSpin = now + S.ATK.spin.cd;
      setState(p, "spin", now);
    } else if (d.t === "roll") {
      if (now < p.cdRoll) return;
      p.cdRoll = now + S.ROLL.cd;
      let dx = Number(d.dx) || 0;
      let dy = Number(d.dy) || 0;
      const len = Math.hypot(dx, dy);
      if (len < 0.1) { dx = Math.cos(p.aim); dy = Math.sin(p.aim); } else { dx /= len; dy /= len; }
      p.rdx = dx; p.rdy = dy;
      setState(p, "roll", now);
    }
  });
});

server.listen(PORT, () => console.log("Serveur prêt sur le port " + PORT));
