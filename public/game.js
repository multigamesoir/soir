(() => {
  "use strict";
  const S = window.Shared;
  const { W, H } = S;
  const $ = (id) => document.getElementById(id);
  const canvas = $("c");
  const ctx = canvas.getContext("2d");
  const socket = io();

  // =====================================================================
  //  Sprites : 15 images par animation, 8 rangées = 8 directions
  //  Rangées : 0=S 1=SO 2=O 3=NO 4=N 5=NE 6=E 7=SE
  // =====================================================================
  const SHEETS = {
    idle: "Idle", run: "Run", atk1: "Melee", atk2: "Melee2", spin: "MeleeSpin",
    roll: "Rolling", block: "ShieldBlockMid", hurt: "TakeDamage", dead: "Die",
  };
  const FR = 128;       // taille d'une case
  const FRAMES = 15;    // images par animation
  const SC = 1.7;       // échelle d'affichage
  const AX = 64, AY = 98; // point de ancrage (les pieds) dans la case
  const LOOP_FPS = { idle: 12, run: 24, block: 12 };
  const ONESHOT = {
    atk1: S.ATK.atk1.dur, atk2: S.ATK.atk2.dur, spin: S.ATK.spin.dur,
    roll: S.ROLL.dur, hurt: S.HURT_DUR, dead: S.DIE_DUR,
  };
  const imgs = {};

  function loadImages() {
    const jobs = Object.entries(SHEETS).map(([key, file]) => new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res();
      im.onerror = () => rej(new Error("Image introuvable : " + file));
      im.src = "assets/knight/" + file + ".webp";
      imgs[key] = im;
    }));
    return Promise.all(jobs);
  }

  function frameOf(state, a) {
    a = Math.max(0, a);
    if (LOOP_FPS[state]) return Math.floor((a / 1000) * LOOP_FPS[state]) % FRAMES;
    return Math.min(FRAMES - 1, Math.floor((a / ONESHOT[state]) * FRAMES));
  }

  // =====================================================================
  //  État global
  // =====================================================================
  let phase = "loading"; // loading | menu | lobby | game
  let myId = null;
  let lobby = null;
  let snaps = [];        // snapshots reçus {t, d, map}
  let latest = null;     // dernier snapshot
  let latestT = 0;
  let playingSince = 0;
  const INTERP_MS = 100;

  const me = {
    x: W / 2, y: H / 2, init: false, seq: 0, pending: [],
    srvState: "idle", guard: 100, alive: true,
    localAct: null, buffered: null,
    mvState: "idle", mvT0: 0,
    cdSpinEnd: 0, cdRollEnd: 0, lockAim: 0,
  };
  const keys = {};
  const mouse = { x: W / 2, y: H / 2 };
  const fx = { parts: [], texts: [], shake: 0 };

  // =====================================================================
  //  Écran et caméra
  // =====================================================================
  let dpr = 1, scale = 1, offX = 0, offY = 0;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    scale = Math.min(innerWidth / W, innerHeight / H);
    offX = (innerWidth - W * scale) / 2;
    offY = (innerHeight - H * scale) / 2;
  }
  window.addEventListener("resize", resize);
  resize();

  function toWorld(cx, cy) {
    return { x: (cx - offX) / scale, y: (cy - offY) / scale };
  }

  // =====================================================================
  //  Décor : sol de pierre dessiné une seule fois
  // =====================================================================
  const bg = document.createElement("canvas");
  bg.width = W; bg.height = H;
  (function drawBg() {
    const g = bg.getContext("2d");
    let seed = 1337;
    const rnd = () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    g.fillStyle = "#12161c";
    g.fillRect(0, 0, W, H);

    // dalles
    const T = 80;
    for (let y = 60; y < H - 40; y += T) {
      for (let x = 40; x < W - 40; x += T) {
        const l = 26 + Math.floor(rnd() * 9);
        g.fillStyle = `rgb(${l},${l + 4},${l + 10})`;
        g.fillRect(x + 1, y + 1, T - 2, T - 2);
        g.strokeStyle = "rgba(0,0,0,0.35)";
        g.lineWidth = 2;
        g.strokeRect(x + 1, y + 1, T - 2, T - 2);
        if (rnd() < 0.25) {
          g.strokeStyle = "rgba(0,0,0,0.28)";
          g.lineWidth = 1.5;
          g.beginPath();
          const sx = x + 10 + rnd() * 50, sy = y + 10 + rnd() * 50;
          g.moveTo(sx, sy);
          g.lineTo(sx + (rnd() - 0.5) * 40, sy + (rnd() - 0.5) * 40);
          g.lineTo(sx + (rnd() - 0.5) * 60, sy + (rnd() - 0.5) * 60);
          g.stroke();
        }
      }
    }

    // cercle d'arène
    g.strokeStyle = "rgba(152,163,176,0.22)";
    g.lineWidth = 4;
    g.beginPath(); g.ellipse(W / 2, H / 2 + 10, 330, 200, 0, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 2;
    g.beginPath(); g.ellipse(W / 2, H / 2 + 10, 310, 184, 0, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(W / 2 - 330, H / 2 + 10); g.lineTo(W / 2 + 330, H / 2 + 10);
    g.moveTo(W / 2, H / 2 - 190); g.lineTo(W / 2, H / 2 + 210); g.stroke();

    // murs
    const wall = (x, y, w, h) => {
      const gr = g.createLinearGradient(0, y, 0, y + h);
      gr.addColorStop(0, "#232a34"); gr.addColorStop(1, "#171c23");
      g.fillStyle = gr; g.fillRect(x, y, w, h);
    };
    wall(0, 0, W, 62); wall(0, H - 38, W, 38); wall(0, 0, 38, H); wall(W - 38, 0, 38, H);
    g.strokeStyle = "rgba(0,0,0,0.5)"; g.lineWidth = 3;
    g.strokeRect(38, 62, W - 76, H - 100);
    for (let x = 0; x < W; x += 64) {
      g.fillStyle = "rgba(0,0,0,0.25)"; g.fillRect(x, 0, 2, 62);
    }

    // lueurs de torches
    const torch = (x, y) => {
      const r = g.createRadialGradient(x, y, 4, x, y, 260);
      r.addColorStop(0, "rgba(224,176,74,0.22)"); r.addColorStop(1, "rgba(224,176,74,0)");
      g.fillStyle = r; g.fillRect(x - 260, y - 260, 520, 520);
      g.fillStyle = "#e0b04a"; g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill();
    };
    torch(200, 44); torch(W - 200, 44); torch(640, 44);

    // vignette
    const v = g.createRadialGradient(W / 2, H / 2, 260, W / 2, H / 2, 780);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,0.6)");
    g.fillStyle = v; g.fillRect(0, 0, W, H);
  })();

  // =====================================================================
  //  Son (petits bips synthétisés, aucun fichier)
  // =====================================================================
  let audio = null, muted = false;
  function snd(f0, f1, dur, type, vol) {
    if (muted) return;
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      const t = audio.currentTime;
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + dur);
    } catch (e) { /* le son est facultatif */ }
  }
  const sfx = {
    swing: () => snd(420, 140, 0.14, "sawtooth", 0.025),
    hit: () => snd(180, 50, 0.16, "square", 0.06),
    block: () => snd(700, 380, 0.1, "triangle", 0.07),
    dodge: () => snd(300, 600, 0.12, "sine", 0.05),
    ko: () => snd(220, 40, 0.5, "sawtooth", 0.07),
  };

  // =====================================================================
  //  Interface (menu / lobby)
  // =====================================================================
  function show(el, on) { el.classList.toggle("hidden", !on); }
  function setPhase(p) {
    phase = p;
    show($("loading"), p === "loading");
    show($("menu"), p === "menu");
    show($("lobby"), p === "lobby");
    show($("help"), p === "game");
    // Sinon un champ de texte resté actif avale les touches du jeu
    if (p === "game" && document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { /* ignoré */ } return null; }
  $("name").value = store("ka-name") || "Chevalier" + Math.floor(Math.random() * 90 + 10);
  const urlCode = (new URLSearchParams(location.search).get("code") || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  if (urlCode) $("code").value = urlCode;

  function myName() {
    const n = $("name").value.trim() || "Chevalier";
    store("ka-name", n);
    return n;
  }

  $("btn-create").onclick = () => { $("menu-err").textContent = ""; socket.emit("create", { name: myName() }); };
  $("btn-join").onclick = joinNow;
  $("code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinNow(); });
  $("code").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ""); });
  function joinNow() {
    const code = $("code").value.trim();
    if (code.length !== 4) { $("menu-err").textContent = "Le code fait 4 lettres."; return; }
    $("menu-err").textContent = "";
    socket.emit("join", { code, name: myName() });
  }
  $("btn-start").onclick = () => socket.emit("start");
  $("btn-leave").onclick = () => { socket.emit("leave"); resetNet(); setPhase("menu"); };
  $("btn-copy").onclick = () => {
    if (!lobby) return;
    const link = location.origin + location.pathname + "?code=" + lobby.code;
    const done = () => { $("btn-copy").textContent = "Lien copié"; setTimeout(() => ($("btn-copy").textContent = "Copier le lien"), 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, () => prompt("Copie ce lien :", link));
    else prompt("Copie ce lien :", link);
  };

  function renderLobby() {
    if (!lobby) return;
    $("lobby-code").textContent = lobby.code;
    const ul = $("players");
    ul.innerHTML = "";
    for (const p of lobby.players) {
      const li = document.createElement("li");
      li.style.setProperty("--c", p.color);
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = p.name;
      li.appendChild(nm);
      const tags = [];
      if (p.id === lobby.host) tags.push("hôte");
      if (p.wins) tags.push(p.wins + (p.wins > 1 ? " victoires" : " victoire"));
      if (tags.length) { const t = document.createElement("span"); t.className = "tag"; t.textContent = tags.join(" · "); li.appendChild(t); }
      if (p.id === myId) { const y = document.createElement("span"); y.className = "tag you"; y.textContent = "toi"; li.appendChild(y); }
      ul.appendChild(li);
    }
    const isHost = lobby.host === myId;
    show($("btn-start"), isHost);
    $("btn-start").disabled = lobby.players.length < 2;
    $("lobby-hint").textContent = isHost
      ? (lobby.players.length < 2 ? "Partage le code : il faut au moins 2 joueurs." : "Tout le monde est là ? Lance le combat.")
      : "En attente de l'hôte…";
  }

  function resetNet() {
    lobby = null; snaps = []; latest = null; myId = null;
    me.init = false; me.pending = []; me.localAct = null; me.buffered = null;
  }

  // =====================================================================
  //  Réseau
  // =====================================================================
  socket.on("err", (m) => {
    if (phase === "menu") $("menu-err").textContent = m;
    else if (phase === "lobby") $("lobby-err").textContent = m;
  });
  socket.on("joined", (d) => { myId = d.id; $("lobby-err").textContent = ""; });

  socket.on("lobby", (l) => {
    lobby = l;
    if (l.state === "lobby") {
      snaps = []; latest = null; me.init = false; me.pending = []; me.localAct = null; me.buffered = null;
      fx.parts = []; fx.texts = [];
      setPhase("lobby");
      renderLobby();
    } else {
      if (l.state === "countdown") { snaps = []; latest = null; me.init = false; me.pending = []; me.localAct = null; me.buffered = null; fx.parts = []; fx.texts = []; }
      setPhase("game");
    }
  });

  socket.on("snap", (d) => {
    const now = performance.now();
    const map = {};
    for (const p of d.ps) map[p.i] = p;
    snaps.push({ t: now, d, map });
    if (snaps.length > 14) snaps.shift();
    if (latest && latest.n !== "playing" && d.n === "playing") playingSince = now;
    latest = d; latestT = now;

    for (const e of d.ev) handleEvent(e);

    const mine = map[myId];
    if (!mine) return;
    me.srvState = mine.s;
    me.alive = mine.s !== "dead";
    me.guard = mine.g;
    me.cdSpinEnd = now + mine.cs;
    me.cdRollEnd = now + mine.cr;

    if (!me.init) { me.x = mine.x; me.y = mine.y; me.init = true; me.pending = []; }

    if (me.localAct && (mine.s === me.localAct.type || !S.MOVABLE[mine.s])) me.localAct = null;

    me.pending = me.pending.filter((i) => i.seq > mine.q);
    if (S.MOVABLE[mine.s] && !me.localAct) {
      // Réconciliation : position du serveur + rejouer les entrées pas encore confirmées
      const p = { x: mine.x, y: mine.y };
      for (const i of me.pending) S.applyMove(p, i.mx, i.my, i.block && me.guard > 5);
      me.x = p.x; me.y = p.y;
    }
  });

  socket.on("disconnect", () => {
    resetNet();
    setPhase("menu");
    $("menu-err").textContent = "Connexion perdue. Recrée ou rejoins un lobby.";
  });

  function handleEvent(e) {
    if (e.k === "hit") {
      spawnSparks(e.x, e.y, e.b);
      fx.texts.push({ x: e.x, y: e.y, txt: e.b ? "bloqué" : "-" + e.d, life: 0.9, c: e.b ? "#9cc7ff" : "#ffe3b0", big: !e.b });
      (e.b ? sfx.block : sfx.hit)();
      if (e.to === myId) fx.shake = Math.max(fx.shake, e.b ? 3 : 9);
    } else if (e.k === "dodge") {
      fx.texts.push({ x: e.x, y: e.y, txt: "esquive", life: 0.8, c: "#8fe0c0", big: false });
      sfx.dodge();
    } else if (e.k === "gb") {
      fx.texts.push({ x: e.x, y: e.y, txt: "garde brisée", life: 1.2, c: "#ff9a8f", big: false });
      fx.shake = Math.max(fx.shake, 6);
    } else if (e.k === "ko") {
      fx.texts.push({ x: e.x, y: e.y - 20, txt: "K.O.", life: 1.4, c: "#ff6b60", big: true });
      sfx.ko();
      fx.shake = Math.max(fx.shake, 10);
    }
  }

  function spawnSparks(x, y, blocked) {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2, s = 80 + Math.random() * 220;
      fx.parts.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60,
        life: 0.35 + Math.random() * 0.2, max: 0.5, c: blocked ? "#aed3ff" : "#ffd89a",
      });
    }
  }

  // =====================================================================
  //  Entrées
  // =====================================================================
  function typing() { const a = document.activeElement; return a && a.tagName === "INPUT"; }

  window.addEventListener("keydown", (e) => {
    if (typing()) return;
    if (e.key && e.key.toLowerCase() === "m" && !e.repeat) { muted = !muted; return; }
    if (phase !== "game") return;
    keys[e.code] = true;
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    if (e.repeat) return;
    if (e.code === "KeyJ") tryAct("atk1");
    else if (e.code === "KeyK") tryAct("atk2");
    else if (e.code === "KeyE" || e.code === "KeyL") tryAct("spin");
    else if (e.code === "Space") tryAct("roll");
  });
  window.addEventListener("keyup", (e) => { keys[e.code] = false; });
  window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("mousemove", (e) => { mouse.cx = e.clientX; mouse.cy = e.clientY; });
  canvas.addEventListener("mousedown", (e) => {
    mouse.cx = e.clientX; mouse.cy = e.clientY;
    if (phase !== "game") return;
    if (e.button === 0) tryAct("atk1");
    else if (e.button === 2) tryAct("atk2");
  });

  function shiftHeld() { return !!(keys.ShiftLeft || keys.ShiftRight); }

  function moveVec() {
    const mx = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    const my = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);
    return { mx, my };
  }

  function mouseAim() {
    if (mouse.cx === undefined) return me.lockAim;
    const w = toWorld(mouse.cx, mouse.cy);
    return Math.atan2(w.y - (me.y - 35), w.x - me.x);
  }

  function canAct(t) {
    if (!(phase === "game" && latest && latest.n === "playing" && me.alive && !me.localAct)) return false;
    if (t === "roll") return me.srvState === "idle" || me.srvState === "run" || me.srvState === "block";
    return (me.srvState === "idle" || me.srvState === "run") && !shiftHeld();
  }

  function tryAct(t) {
    if (phase !== "game" || !latest || latest.n !== "playing" || !me.alive) return;
    const now = performance.now();
    if (t === "spin" && now < me.cdSpinEnd) return;
    if (t === "roll" && now < me.cdRollEnd) return;
    if (!canAct(t)) { me.buffered = { t, until: now + 300 }; return; }
    doAct(t, now);
  }

  function doAct(t, now) {
    const aim = mouseAim();
    const { mx, my } = moveVec();
    me.buffered = null;
    me.lockAim = aim;
    me.localAct = { type: t, t0: now, aim };
    if (t === "spin") me.cdSpinEnd = now + S.ATK.spin.cd;
    if (t === "roll") me.cdRollEnd = now + S.ROLL.cd;
    socket.emit("act", { t, aim: Math.round(aim * 100) / 100, dx: mx, dy: my });
    if (t !== "roll") sfx.swing();
  }

  // Une entrée toutes les 1/30 s : envoyée au serveur ET appliquée tout de suite (prédiction)
  function inputStep() {
    if (phase !== "game" || !latest || latest.n !== "playing" || !me.alive || !me.init) return;
    const now = performance.now();

    if (me.buffered) {
      if (now > me.buffered.until) me.buffered = null;
      else if (canAct(me.buffered.t)) {
        const t = me.buffered.t;
        if (!((t === "spin" && now < me.cdSpinEnd) || (t === "roll" && now < me.cdRollEnd))) doAct(t, now);
      }
    }

    const { mx, my } = moveVec();
    const block = shiftHeld();
    const aim = mouseAim();
    me.seq++;
    socket.volatile.emit("input", { seq: me.seq, mx, my, block, aim: Math.round(aim * 100) / 100 });

    if (S.MOVABLE[me.srvState] && !me.localAct) {
      const blocking = block && me.guard > 5;
      S.applyMove(me, mx, my, blocking);
      me.pending.push({ seq: me.seq, mx, my, block });
      if (me.pending.length > 90) me.pending.shift();
      const st = blocking ? "block" : Math.hypot(mx, my) > 0.1 ? "run" : "idle";
      if (st !== me.mvState) { me.mvState = st; me.mvT0 = now; }
    }
  }

  // =====================================================================
  //  Vues des joueurs (ce qu'on dessine)
  // =====================================================================
  function myView(now) {
    const mine = latest && latest.ps.find((p) => p.i === myId);
    if (!mine) return null;
    const sinceSnap = now - latestT;
    let s, a, aim;
    if (me.localAct && mine.s !== me.localAct.type) {
      s = me.localAct.type; a = now - me.localAct.t0; aim = me.localAct.aim;
    } else if (S.MOVABLE[mine.s] && latest.n === "playing") {
      s = me.mvState; a = now - me.mvT0; aim = mouseAim();
      me.lockAim = aim;
    } else {
      s = mine.s; a = mine.a + sinceSnap; aim = mine.m;
      if (!S.MOVABLE[mine.s]) me.lockAim = mine.m;
    }
    // hors déplacement libre, on suit la position du serveur en douceur
    if (!(S.MOVABLE[mine.s] && !me.localAct)) {
      me.x += (mine.x - me.x) * 0.45;
      me.y += (mine.y - me.y) * 0.45;
    }
    return { id: myId, x: me.x, y: me.y, s, a, aim, h: mine.h, g: mine.g, k: mine.k };
  }

  function remoteView(id, rt) {
    if (!snaps.length) return null;
    let i = snaps.length - 1;
    while (i > 0 && snaps[i].t > rt) i--;
    const A = snaps[i], B = snaps[i + 1];
    const pa = A.map[id];
    if (!pa) return null;
    let x = pa.x, y = pa.y;
    if (B && B.map[id]) {
      const f = S.clamp((rt - A.t) / (B.t - A.t), 0, 1);
      x = pa.x + (B.map[id].x - pa.x) * f;
      y = pa.y + (B.map[id].y - pa.y) * f;
    }
    return { id, x, y, s: pa.s, a: pa.a + Math.max(0, rt - A.t), aim: pa.m, h: pa.h, g: pa.g, k: pa.k };
  }

  // =====================================================================
  //  Rendu
  // =====================================================================
  function playerInfo(id) {
    return (lobby && lobby.players.find((p) => p.id === id)) || { name: "?", color: "#98a3b0", wins: 0 };
  }

  function drawKnight(v) {
    const info = playerInfo(v.id);
    const dead = v.s === "dead";
    ctx.save();
    ctx.translate(v.x, v.y);

    // anneau de couleur au sol
    ctx.globalAlpha = dead ? 0.25 : 0.9;
    ctx.strokeStyle = info.color;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(0, 4, 30, 13, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;

    const img = imgs[v.s] || imgs.idle;
    const f = frameOf(v.s, v.a);
    const row = S.dirRow(v.aim);
    ctx.drawImage(img, f * FR, row * FR, FR, FR, -AX * SC, -AY * SC, FR * SC, FR * SC);

    if (!dead) {
      // nom + barre de vie
      const bw = 56, by = -AY * SC + 16;
      ctx.font = "600 13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.strokeText(info.name, 0, by - 8); ctx.fillStyle = info.color; ctx.fillText(info.name, 0, by - 8);
      ctx.fillStyle = "rgba(0,0,0,0.65)"; ctx.fillRect(-bw / 2 - 1, by - 1, bw + 2, 8);
      ctx.fillStyle = "#d9534f"; ctx.fillRect(-bw / 2, by, bw * (v.h / 100), 6);
      if (v.s === "block" || v.g < 100) {
        ctx.fillStyle = "rgba(0,0,0,0.65)"; ctx.fillRect(-bw / 2 - 1, by + 8, bw + 2, 5);
        ctx.fillStyle = "#7db4f0"; ctx.fillRect(-bw / 2, by + 9, bw * (v.g / 100), 3);
      }
    }
    ctx.restore();
  }

  function drawWorld(now) {
    const views = [];
    const rt = now - INTERP_MS;
    for (const p of latest.ps) {
      const v = p.i === myId ? myView(now) : remoteView(p.i, rt);
      if (v) views.push(v);
    }
    views.sort((a, b) => (a.s === "dead" ? -1 : 0) - (b.s === "dead" ? -1 : 0) || a.y - b.y);
    for (const v of views) drawKnight(v);

    // étincelles
    for (const p of fx.parts) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;

    // textes flottants
    ctx.textAlign = "center";
    for (const t of fx.texts) {
      ctx.globalAlpha = Math.min(1, t.life * 1.6);
      ctx.font = (t.big ? "800 26px" : "700 15px") + " system-ui, sans-serif";
      ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(t.txt, t.x, t.y); ctx.fillStyle = t.c; ctx.fillText(t.txt, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawHUD(now) {
    const list = latest.ps;
    const n = list.length;
    const gap = 10;
    const cw = Math.min(220, (innerWidth - 16 - gap * (n - 1)) / n);
    let x = (innerWidth - (cw * n + gap * (n - 1))) / 2;
    ctx.textAlign = "left";
    for (const p of list) {
      const info = playerInfo(p.i);
      const alive = p.s !== "dead";
      ctx.globalAlpha = alive ? 1 : 0.5;
      ctx.fillStyle = "rgba(10,12,16,0.78)"; ctx.fillRect(x, 8, cw, 46);
      ctx.fillStyle = info.color; ctx.fillRect(x, 8, 4, 46);
      ctx.font = "600 14px system-ui, sans-serif"; ctx.fillStyle = "#e8e3d6";
      ctx.fillText(info.name + (p.i === myId ? " (toi)" : ""), x + 12, 26, cw - 50);
      ctx.textAlign = "right"; ctx.fillStyle = "#98a3b0"; ctx.font = "12px system-ui, sans-serif";
      ctx.fillText(p.k + " K.O.", x + cw - 8, 26);
      ctx.textAlign = "left";
      ctx.fillStyle = "#2a303a"; ctx.fillRect(x + 12, 33, cw - 22, 9);
      ctx.fillStyle = "#d9534f"; ctx.fillRect(x + 12, 33, (cw - 22) * (p.h / 100), 9);
      ctx.fillStyle = "#2a303a"; ctx.fillRect(x + 12, 45, cw - 22, 3);
      ctx.fillStyle = "#7db4f0"; ctx.fillRect(x + 12, 45, (cw - 22) * (p.g / 100), 3);
      ctx.globalAlpha = 1;
      x += cw + gap;
    }

    // recharges
    const pip = (label, end, total, px) => {
      const rem = Math.max(0, end - now);
      const w = 116, h = 34, y = innerHeight - 92;
      ctx.fillStyle = "rgba(10,12,16,0.78)"; ctx.fillRect(px, y, w, h);
      ctx.fillStyle = rem > 0 ? "#3a4350" : "#3f8a72";
      ctx.fillRect(px, y, w * (rem > 0 ? 1 - rem / total : 1), h);
      ctx.fillStyle = "#e8e3d6"; ctx.font = "600 13px system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(label, px + w / 2, y + 22);
    };
    pip("Tourbillon (E)", me.cdSpinEnd, S.ATK.spin.cd, innerWidth / 2 - 122);
    pip("Roulade (Espace)", me.cdRollEnd, S.ROLL.cd, innerWidth / 2 + 6);

    // bandeaux centraux
    ctx.textAlign = "center";
    const big = (txt, sub) => {
      ctx.font = "700 72px Georgia, serif";
      ctx.lineWidth = 8; ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(txt, innerWidth / 2, innerHeight / 2 - 10); ctx.fillStyle = "#e8e3d6"; ctx.fillText(txt, innerWidth / 2, innerHeight / 2 - 10);
      if (sub) {
        ctx.font = "600 20px system-ui, sans-serif"; ctx.lineWidth = 4;
        ctx.strokeText(sub, innerWidth / 2, innerHeight / 2 + 28); ctx.fillStyle = "#98a3b0"; ctx.fillText(sub, innerWidth / 2, innerHeight / 2 + 28);
      }
    };
    if (latest.n === "countdown") big(String(Math.max(1, Math.ceil((latest.c - (now - latestT)) / 1000))), "Prépare-toi");
    else if (latest.n === "playing" && now - playingSince < 800) big("Combat !");
    else if (latest.n === "over") {
      const w = latest.w ? playerInfo(latest.w) : null;
      big(w ? w.name + " gagne !" : "Égalité", "Retour au lobby dans " + Math.max(1, Math.ceil((latest.o - (now - latestT)) / 1000)) + " s");
    }
  }

  // =====================================================================
  //  Boucle principale
  // =====================================================================
  let last = performance.now();
  let acc = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Une action non confirmée par le serveur (refusée) est abandonnée après 450 ms
    if (me.localAct && now - me.localAct.t0 > 450 && S.MOVABLE[me.srvState]) me.localAct = null;

    acc += dt * 1000;
    const stepMs = S.STEP * 1000;
    let guard = 0;
    while (acc >= stepMs && guard++ < 5) { acc -= stepMs; inputStep(); }
    if (acc > stepMs * 5) acc = 0;

    for (const p of fx.parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 600 * dt; p.life -= dt; }
    fx.parts = fx.parts.filter((p) => p.life > 0);
    for (const t of fx.texts) { t.y -= 34 * dt; t.life -= dt; }
    fx.texts = fx.texts.filter((t) => t.life > 0);
    fx.shake = Math.max(0, fx.shake - 30 * dt);

    // dessin
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b0e12";
    ctx.fillRect(0, 0, innerWidth, innerHeight);

    const sx = fx.shake ? (Math.random() - 0.5) * fx.shake : 0;
    const sy = fx.shake ? (Math.random() - 0.5) * fx.shake : 0;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (offX + sx), dpr * (offY + sy));
    ctx.drawImage(bg, 0, 0);
    if (phase === "game" && latest) drawWorld(now);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (phase === "game" && latest) drawHUD(now);

    requestAnimationFrame(frame);
  }

  // =====================================================================
  //  Démarrage
  // =====================================================================
  loadImages()
    .then(() => { setPhase("menu"); if (urlCode) $("code").focus(); })
    .catch((e) => { $("loading").querySelector(".plate").textContent = "Erreur de chargement : " + e.message; });
  requestAnimationFrame(frame);
})();
