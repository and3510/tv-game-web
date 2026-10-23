import express from 'express';
import { createServer, request as httpRequest } from 'node:http';
import { isIP, connect as tcpConnect } from 'node:net';
import { randomInt, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from 'socket.io';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// Medido com vídeo do YouTube tocando: até 16 o jogo perde ~10% de fluidez, 24 perde ~23%, 32 perde ~26%.
// 20 fica antes do ponto em que começa a pesar.
const MAX_PLAYERS_PER_ROOM = Number(process.env.MAX_PLAYERS_PER_ROOM || 20);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I para evitar confusão
const CODE_LENGTH = 6;
const MAX_SEATS = 256;
const FLAG_IDS = new Set(['', 'brasil']); // mesmas de public/js/flags.js
// Sons do inventário: arquivos colocados nesta pasta aparecem na hora (lida a cada pedido)
const SOUNDS_DIR = process.env.SOUNDS_DIR || join(__dirname, 'sounds');
const SOUND_FILE = /^[^/\\]+\.(mp3|ogg|wav|m4a)$/i;
const TOMATO_COOLDOWN_MS = 600; // no máximo ~1,6 tomate por segundo por jogador
const TOMATO_MAX_SPEED = 40;
const TIMES_OF_DAY = new Set(['day', 'night']);
const NO_CONTROL = 'Só quem tem o controle da TV pode fazer isso.';
const ANIMS = new Set(['idle', 'walk', 'run', 'jump', 'sit']);
const MODELS = new Set(['male', 'female'].flatMap((g) => 'abcdef'.split('').map((v) => `${g}-${v}`))); // personagens do Kenney
// Transmissão de tela via SFU (LiveKit, container ao lado do jogo): quem transmite envia UMA cópia e o
// LiveKit distribui para cada espectador. Os navegadores falam com ele por /livekit (repassado abaixo,
// mesmo domínio e HTTPS do jogo); o vídeo vai direto ao LiveKit pela UDP 7882 (ou TCP 7881).
const LIVEKIT_URL = new URL(process.env.LIVEKIT_URL || 'http://127.0.0.1:7880'); // endereço interno
const LIVEKIT_PUBLIC_URL = process.env.LIVEKIT_PUBLIC_URL || ''; // vazio: wss://<domínio do jogo>/livekit
const LIVEKIT_PREFIX = '/livekit';
const LIVEKIT_KEY = readLivekitKey();

function readSecret(path) {
  if (!path) return null;
  try { return readFileSync(path, 'utf8').trim() || null; } catch { return null; }
}

/** Chave da API no formato do LiveKit ("chave: segredo"), de LIVEKIT_KEYS ou do arquivo LIVEKIT_KEY_FILE. */
function readLivekitKey() {
  const raw = process.env.LIVEKIT_KEYS || readSecret(process.env.LIVEKIT_KEY_FILE);
  const m = raw?.match(/^\s*([^:\s]+)\s*:\s*(\S+)/m);
  return m ? { key: m[1], secret: m[2] } : null;
}

const isLoopback = (h) => h === 'localhost' || h.startsWith('127.') || h === '[::1]';

/** Token de acesso do LiveKit (JWT HS256). Só quem está transmitindo pode publicar, e só a tela. */
function livekitToken({ room, identity, name, canPublish }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    iss: LIVEKIT_KEY.key, sub: identity, name, nbf: now - 10, exp: now + 6 * 3600,
    video: {
      room, roomJoin: true, canSubscribe: true, canPublishData: false, canPublish,
      canPublishSources: canPublish ? ['screen_share', 'screen_share_audio'] : [],
    },
  })}`;
  return `${body}.${createHmac('sha256', LIVEKIT_KEY.secret).update(body).digest('base64url')}`;
}

const app = express();

// Quem chega pela rede direto em http://IP:3000 vai para o HTTPS do Caddy: transmitir a tela exige HTTPS.
// Requisições que vieram pelo Caddy têm X-Forwarded-Proto; localhost continua em HTTP (já é contexto seguro).
const HTTPS_REDIRECT_PORT = process.env.HTTPS_REDIRECT_PORT;
app.use((req, res, next) => {
  if (!HTTPS_REDIRECT_PORT || req.headers['x-forwarded-proto'] || req.path === '/tls-ask' || req.path === '/healthz') return next();
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!host || isLoopback(host) || host === 'app') return next();
  const port = HTTPS_REDIRECT_PORT === '443' ? '' : `:${HTTPS_REDIRECT_PORT}`;
  res.redirect(308, `https://${host}${port}${req.originalUrl}`);
});
// Sinalização do LiveKit (HTTP; o WebSocket é repassado no 'upgrade' mais abaixo).
app.use(LIVEKIT_PREFIX, (req, res) => {
  const up = httpRequest({
    host: LIVEKIT_URL.hostname, port: LIVEKIT_URL.port, method: req.method, path: req.url,
    headers: { ...req.headers, host: LIVEKIT_URL.host },
  }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'LiveKit indisponível' }); else res.destroy(); });
  req.pipe(up);
});
app.use(express.static(join(__dirname, 'public')));
app.use('/vendor/livekit', express.static(join(__dirname, 'node_modules/livekit-client/dist')));
app.use('/vendor/three', express.static(join(__dirname, 'node_modules/three')));
app.use('/sounds', express.static(SOUNDS_DIR, { dotfiles: 'deny' }));

async function listSounds() {
  try {
    return (await readdir(SOUNDS_DIR)).filter((f) => SOUND_FILE.test(f) && !f.startsWith('.')).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  } catch {
    return []; // pasta ainda não existe
  }
}
app.get('/api/sounds', async (_req, res) => res.json({ sounds: await listSounds() }));

app.get('/healthz', (_req, res) => res.json({ status: 'ok', rooms: rooms.size }));

// Usado pelo Caddy (on_demand_tls) para decidir se emite certificado interno: só IPs e localhost.
app.get('/tls-ask', (req, res) => {
  const domain = String(req.query.domain ?? '');
  const ok = isIP(domain) !== 0 || domain === 'localhost';
  res.sendStatus(ok ? 200 : 403);
});

const httpServer = createServer(app);
// destroyUpgrade: false → o Socket.IO não derruba os WebSockets que não são dele (os do /livekit).
const io = new Server(httpServer, { destroyUpgrade: false });

httpServer.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith(`${LIVEKIT_PREFIX}/`)) return; // o resto é do Socket.IO
  const up = tcpConnect(Number(LIVEKIT_URL.port) || 80, LIVEKIT_URL.hostname, () => {
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      headers.push(`${name}: ${name.toLowerCase() === 'host' ? LIVEKIT_URL.host : req.rawHeaders[i + 1]}`);
    }
    up.write(`${req.method} ${req.url.slice(LIVEKIT_PREFIX.length)} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  const close = () => { socket.destroy(); up.destroy(); };
  up.on('error', close);
  socket.on('error', close);
  up.on('close', close);
  socket.on('close', close);
});

/**
 * @typedef {{ media: null | {kind:'youtube',id:string} | {kind:'video',url:string}, playing:boolean, time:number, updatedAt:number }} TvState
 * @type {Map<string, { players: Map<string, object>, seats: Map<number, string>, tv: TvState,
 *   admin: string, controller: string, time: 'day'|'night', screen: null|{id:string,by:string} }>}
 */
const rooms = new Map();

function generateCode() {
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function sanitizeName(name) {
  const clean = String(name ?? '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 16);
  return clean || `Jogador${randomInt(1000, 9999)}`;
}

const num = (v) => (Number.isFinite(v) ? v : 0);

function sanitizeAppearance(a = {}) {
  return { model: MODELS.has(a.model) ? a.model : 'male-a' };
}

/** Aceita links do YouTube (watch, youtu.be, shorts, embed, live) ou arquivos de vídeo diretos. */
function parseMedia(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.href.length > 500) return null;
  const host = u.hostname.replace(/^(www|m)\./, '');
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'music.youtube.com') {
    const id = host === 'youtu.be'
      ? u.pathname.slice(1)
      : u.searchParams.get('v') ?? u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1];
    return /^[\w-]{11}$/.test(id ?? '') ? { kind: 'youtube', id } : null;
  }
  if (/\.(mp4|webm|ogv|m4v)$/i.test(u.pathname)) return { kind: 'video', url: u.href };
  return null;
}

/** Posição atual do vídeo calculada no servidor, para não depender do relógio dos clientes. */
function tvSnapshot(tv) {
  const elapsed = tv.playing ? (Date.now() - tv.updatedAt) / 1000 : 0;
  return { media: tv.media, playing: tv.playing, time: tv.time + elapsed };
}

/** Troca o que está passando na TV da sala e avisa todo mundo. */
function setMedia(code, media, by) {
  const r = rooms.get(code);
  r.tv = { media, playing: true, time: 0, updatedAt: Date.now() };
  io.to(code).emit('tv:state', { ...tvSnapshot(r.tv), by, action: 'load' });
}

/** Papéis da sala: admin (dono; muda dia/noite e pode retomar o controle) e quem controla a TV. */
const rolesOf = (r) => ({ admin: r.admin, controller: r.controller });

function stopScreenOf(code, r) {
  if (!r.screen) return;
  r.screen = null;
  io.to(code).emit('screen:stopped');
}

io.on('connection', (socket) => {
  let currentRoom = null;
  const room = () => rooms.get(currentRoom);
  const me = () => room()?.players.get(socket.id);

  function freeSeat() {
    const r = room();
    if (!r) return;
    for (const [seat, id] of r.seats) if (id === socket.id) r.seats.delete(seat);
  }

  function enterRoom(code, { name, appearance }, ack) {
    const r = rooms.get(code);
    if (r.players.size >= MAX_PLAYERS_PER_ROOM) return ack({ ok: false, error: 'Sala cheia.' });

    const player = {
      id: socket.id,
      name: sanitizeName(name),
      appearance: sanitizeAppearance(appearance),
      x: 0, // o cliente escolhe o ponto de entrada (na frente da plateia) e manda no primeiro estado
      y: 0,
      z: 0,
      ry: 0,
      anim: 'idle',
      fl: false, // lanterna ligada
      fg: '', // bandeira na mão
      ly: 0, // direção da lanterna (yaw/pitch)
      lp: 0,
    };
    r.players.set(socket.id, player);
    currentRoom = code;
    socket.join(code);
    socket.to(code).emit('player:joined', player);
    ack({
      ok: true,
      code,
      self: player,
      players: [...r.players.values()].filter((p) => p.id !== socket.id),
      tv: tvSnapshot(r.tv),
      screen: r.screen,
      roles: rolesOf(r),
      time: r.time,
    });
  }

  socket.on('room:create', (data = {}, ack) => {
    if (typeof ack !== 'function' || currentRoom) return;
    const code = generateCode();
    rooms.set(code, {
      players: new Map(),
      seats: new Map(),
      screen: null, // { id, by } de quem está transmitindo a tela
      tv: { media: null, playing: false, time: 0, updatedAt: Date.now() },
      admin: socket.id, // quem cria a sala é o admin e começa com o controle da TV
      controller: socket.id,
      time: 'day',
    });
    enterRoom(code, data, ack);
    console.log(`[room] ${code} criada por ${socket.id}`);
  });

  socket.on('room:join', (data = {}, ack) => {
    if (typeof ack !== 'function' || currentRoom) return;
    const code = String(data.code ?? '').toUpperCase().trim();
    if (!rooms.has(code)) return ack({ ok: false, error: 'Sala não encontrada.' });
    enterRoom(code, data, ack);
  });

  socket.on('player:state', (s = {}) => {
    const player = me();
    if (!player) return;
    player.x = num(s.x);
    player.y = num(s.y);
    player.z = num(s.z);
    player.ry = num(s.ry);
    player.anim = ANIMS.has(s.anim) ? s.anim : 'idle';
    player.fl = s.fl === true;
    player.ly = num(s.ly);
    player.lp = Math.min(Math.max(num(s.lp), -1.6), 1.6);
    player.fg = FLAG_IDS.has(s.fg) ? s.fg : '';
    socket.volatile.to(currentRoom).emit('player:state', {
      id: socket.id, x: player.x, y: player.y, z: player.z, ry: player.ry, anim: player.anim,
      fl: player.fl, ly: player.ly, lp: player.lp, fg: player.fg,
    });
  });

  const isController = () => room()?.controller === socket.id;

  // ---------- Papéis e ambiente ----------
  // Quem tem o controle (ou o admin) passa para outro jogador; o admin pode retomar passando para si mesmo.
  socket.on('room:pass-control', ({ to } = {}) => {
    const r = room();
    if (!r || !r.players.has(to) || r.controller === to) return;
    if (socket.id !== r.controller && socket.id !== r.admin) return;
    r.controller = to;
    if (r.screen && r.screen.id !== to) stopScreenOf(currentRoom, r); // a transmissão era de quem perdeu o controle
    io.to(currentRoom).emit('room:roles', { ...rolesOf(r), by: me().name });
  });

  socket.on('room:time', ({ value } = {}) => {
    const r = room();
    if (!r || socket.id !== r.admin || !TIMES_OF_DAY.has(value) || r.time === value) return;
    r.time = value;
    io.to(currentRoom).emit('room:time', { value, by: me().name });
  });

  // ---------- Sons do inventário: todos na sala ouvem (sem limite de frequência) ----------
  socket.on('sound:play', async ({ name } = {}) => {
    if (!room() || typeof name !== 'string') return;
    if (!(await listSounds()).includes(name)) return;
    if (room()) io.to(currentRoom).emit('sound:play', { name, by: me().name, id: socket.id }); // id: para silenciar por pessoa
  });

  // ---------- Tomates: o servidor só valida e repassa; cada cliente simula a trajetória ----------
  let lastTomatoAt = 0;
  socket.on('tomato:throw', ({ o, v } = {}) => {
    const player = me();
    if (!player) return;
    const now = Date.now();
    if (now - lastTomatoAt < TOMATO_COOLDOWN_MS) return;
    const vec = (a) => (Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? a.map((n) => Math.round(n * 100) / 100) : null);
    const origin = vec(o), vel = vec(v);
    if (!origin || !vel || Math.hypot(...vel) > TOMATO_MAX_SPEED) return;
    if (Math.hypot(origin[0] - player.x, origin[2] - player.z) > 3) return; // tem que sair de perto de quem lançou
    lastTomatoAt = now;
    socket.to(currentRoom).emit('tomato:throw', { o: origin, v: vel, id: socket.id });
  });

  // ---------- Cadeiras ----------
  socket.on('seat:sit', ({ seat } = {}, ack) => {
    const r = room();
    if (!r || typeof ack !== 'function') return;
    if (!Number.isInteger(seat) || seat < 0 || seat >= MAX_SEATS) return ack({ ok: false, error: 'Lugar inválido.' });
    const owner = r.seats.get(seat);
    if (owner && owner !== socket.id) return ack({ ok: false, error: 'Esse lugar já está ocupado.' });
    freeSeat();
    r.seats.set(seat, socket.id);
    ack({ ok: true });
  });

  socket.on('seat:stand', freeSeat);

  // ---------- Transmissão de tela (o vídeo passa pelo LiveKit; aqui só quem pode transmitir/assistir) ----------
  function stopScreen() {
    const r = room();
    if (r?.screen?.id !== socket.id) return;
    r.screen = null;
    io.to(currentRoom).emit('screen:stopped');
  }

  socket.on('screen:start', (ack) => {
    const r = room();
    if (!r || typeof ack !== 'function') return;
    if (!isController()) return ack({ ok: false, error: NO_CONTROL });
    if (r.screen && r.screen.id !== socket.id) return ack({ ok: false, error: `${r.screen.by} já está transmitindo.` });
    r.screen = { id: socket.id, by: me().name };
    socket.to(currentRoom).emit('screen:started', r.screen);
    ack({ ok: true });
  });

  socket.on('screen:stop', stopScreen);

  // Token para entrar na sala do LiveKit: publicar só quem está transmitindo; os outros só assistem.
  socket.on('screen:token', (ack) => {
    const r = room();
    if (!r || typeof ack !== 'function') return;
    if (!LIVEKIT_KEY) return ack({ ok: false, error: 'Transmissão de tela não configurada no servidor (LiveKit).' });
    if (!r.screen) return ack({ ok: false, error: 'Ninguém está transmitindo.' });
    const token = livekitToken({ room: `sala-${currentRoom}`, identity: socket.id, name: me().name, canPublish: r.screen.id === socket.id });
    ack({ ok: true, token, url: LIVEKIT_PUBLIC_URL });
  });

  // ---------- TV ----------
  socket.on('tv:load', ({ url } = {}, ack) => {
    const r = room();
    if (!r || typeof ack !== 'function') return;
    if (!isController()) return ack({ ok: false, error: NO_CONTROL });
    const media = parseMedia(url);
    if (!media) return ack({ ok: false, error: 'Link inválido. Use um link do YouTube ou de um arquivo .mp4/.webm.' });
    setMedia(currentRoom, media, me().name);
    ack({ ok: true });
  });

  socket.on('tv:control', ({ action, time } = {}) => {
    const r = room();
    if (!r?.tv.media || !isController() || !['play', 'pause', 'seek'].includes(action)) return;
    const t = Math.min(Math.max(num(time), 0), 60 * 60 * 24);
    r.tv.time = t;
    r.tv.updatedAt = Date.now();
    if (action === 'play') r.tv.playing = true;
    if (action === 'pause') r.tv.playing = false;
    io.to(currentRoom).emit('tv:state', { ...tvSnapshot(r.tv), by: me().name, action });
  });

  socket.on('disconnect', () => {
    const r = room();
    if (!r) return;
    freeSeat();
    stopScreen();
    r.players.delete(socket.id);
    socket.to(currentRoom).emit('player:left', socket.id);
    if (r.players.size === 0) {
      rooms.delete(currentRoom);
      console.log(`[room] ${currentRoom} removida (vazia)`);
      return;
    }
    // Admin saiu: o jogador mais antigo assume. Quem controlava saiu: o controle volta para o admin.
    const before = JSON.stringify(rolesOf(r));
    if (r.admin === socket.id) r.admin = r.players.keys().next().value;
    if (r.controller === socket.id) r.controller = r.admin;
    if (JSON.stringify(rolesOf(r)) !== before) io.to(currentRoom).emit('room:roles', rolesOf(r));
  });
});

// Docker/Kubernetes pedem para desligar com SIGTERM. Rodando como PID 1 (sem init), o Node ignora o sinal
// se não houver handler — o pod esperaria o terminationGracePeriod inteiro e seria morto com SIGKILL.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} recebido: encerrando`);
    io.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref(); // conexões que não fecharem a tempo
  });
}

httpServer.listen(PORT, () => {
  console.log(`Servidor em http://localhost:${PORT}`);
  console.log(LIVEKIT_KEY ? `Transmissão de tela via LiveKit (${LIVEKIT_URL.host})` : 'LiveKit não configurado: transmissão de tela desativada');
});
