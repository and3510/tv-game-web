import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';
import { io } from '/socket.io/socket.io.esm.min.js';
import {
  createCharacter, loadCharacters, CHARACTERS, ALL_CHARACTERS, DEFAULT_CHARACTER, previewUrl,
  SIT_OFFSET, EYE_HEIGHT, EYE_HEIGHT_SIT, CAMERA_TARGET,
} from './character.js';
import { buildWorld, spawnPoint, WORLD_BOUNDS, SEAT_TOP } from './world.js';
import { TV } from './tv.js';
import { ScreenShare, QUALITY } from './screenshare.js';
import { FLAGS, drawFlag } from './flags.js';
import { TomatoSystem, THROW_SPEED, TOMATO_GRAVITY } from './tomatoes.js';

const socket = io();
const $ = (id) => document.getElementById(id);

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage indisponível */ }
}

// ---------- Lobby: escolha do personagem ----------
const charactersReady = loadCharacters();
const saved = load('appearance', {});
// quem tinha a aparência antiga (homem/mulher + cores) cai no primeiro personagem do mesmo tipo
const appearance = {
  model: ALL_CHARACTERS.includes(saved.model) ? saved.model : saved.model === 'female' ? 'female-a' : DEFAULT_CHARACTER,
};

const preview = (() => {
  const canvas = $('preview');
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  r.setSize(canvas.clientWidth, canvas.clientHeight, false);
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2));
  const light = new THREE.DirectionalLight(0xffffff, 2);
  light.position.set(2, 3, 4);
  sc.add(light);
  const cam = new THREE.PerspectiveCamera(30, canvas.clientWidth / canvas.clientHeight, 0.1, 20);
  cam.position.set(0, 0.95, 5.2);
  cam.lookAt(0, 0.72, 0);
  const clock = new THREE.Clock();
  let char = null;
  const rebuild = () => {
    if (char) { sc.remove(char); char.userData.dispose(); }
    char = createCharacter(appearance);
    char.rotation.y = 0.5;
    sc.add(char);
  };
  charactersReady.then(rebuild);
  r.setAnimationLoop(() => {
    const dt = clock.getDelta();
    if (char) {
      char.rotation.y += dt * 0.6;
      char.userData.animate('idle', dt);
    }
    r.render(sc, cam);
  });
  return { rebuild, dispose: () => { r.setAnimationLoop(null); r.dispose(); } };
})();

function renderCustomizer() {
  const gender = appearance.model.split('-')[0];
  document.querySelectorAll('.model-btn').forEach((b) => b.classList.toggle('active', b.dataset.model === gender));
  $('char-grid').replaceChildren(...CHARACTERS[gender].map((id) => {
    const b = document.createElement('button');
    b.className = `char-option${appearance.model === id ? ' active' : ''}`;
    b.title = id;
    b.innerHTML = `<img src="${previewUrl(id)}" alt="">`;
    b.onclick = () => { appearance.model = id; onAppearanceChange(); };
    return b;
  }));
}
function onAppearanceChange() {
  save('appearance', appearance);
  renderCustomizer();
  charactersReady.then(preview.rebuild);
}
document.querySelectorAll('.model-btn').forEach((b) => {
  b.onclick = () => {
    if (appearance.model.startsWith(b.dataset.model)) return;
    appearance.model = CHARACTERS[b.dataset.model][0];
    onAppearanceChange();
  };
});
renderCustomizer();

// ---------- Lobby: entrar / criar ----------
const nameInput = $('name');
const codeInput = $('code');
const errorEl = $('error');
nameInput.value = load('playerName', '');
const params = new URLSearchParams(location.search);
if (params.get('sala')) codeInput.value = params.get('sala').toUpperCase();

function setBusy(busy) {
  $('create').disabled = busy;
  $('join').disabled = busy;
}

async function handleEnter(res) {
  setBusy(false);
  if (!res.ok) { errorEl.textContent = res.error; return; }
  save('playerName', nameInput.value.trim());
  history.replaceState(null, '', `?sala=${res.code}`);
  errorEl.textContent = 'Carregando personagens…';
  await charactersReady; // em geral já terminou enquanto o jogador escolhia o personagem
  errorEl.textContent = '';
  startGame(res);
}

$('create').onclick = () => {
  errorEl.textContent = '';
  setBusy(true);
  socket.emit('room:create', { name: nameInput.value, appearance }, handleEnter);
};

$('join').onclick = () => {
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 6) { errorEl.textContent = 'O código tem 6 caracteres.'; return; }
  errorEl.textContent = '';
  setBusy(true);
  socket.emit('room:join', { code, name: nameInput.value, appearance }, handleEnter);
};
codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && $('join').click());

socket.on('disconnect', () => {
  if (!game) return;
  alert('Conexão com o servidor perdida.');
  location.href = location.pathname;
});

// ---------- Cena ----------
// 3D leve por padrão: o vídeo da tela é um elemento HTML desenhado pelo navegador (camada CSS3D), então
// baixar a qualidade do 3D não tira nenhum pixel do vídeo e libera placa de vídeo/CPU para ele rodar liso.
// Sem antisserrilhado (caro, só suaviza bordas do 3D); alpha é necessário para o "furo" da TV.
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1); // ajustado em applyGraphics()
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = false; // ligado só no modo "3D caprichado"
renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft foi removido do three.js (já caía no PCF)
renderer.domElement.id = 'webgl';

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.id = 'labels';

const cssRenderer = new CSS3DRenderer();
cssRenderer.setSize(innerWidth, innerHeight);
cssRenderer.domElement.id = 'css3d';
const cssScene = new THREE.Scene();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b5e0);
scene.fog = new THREE.Fog(0x87b5e0, 80, 230);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 500);

const hemi = new THREE.HemisphereLight(0xffffff, 0x4a6b3a, 1.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(30, 50, 20);
sun.castShadow = false; // ligado só no modo "3D caprichado"
sun.shadow.mapSize.set(1024, 1024); // 2048 pesava em placas de vídeo fracas sem diferença visível
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 150 });
scene.add(sun, sun.target);

const world = buildWorld(scene);

// ---------- Dia / noite (admin escolhe; transição suave) ----------
const DAY = {
  sky: new THREE.Color(0x87b5e0), hemiSky: new THREE.Color(0xffffff), hemiGround: new THREE.Color(0x4a6b3a),
  sunColor: new THREE.Color(0xffffff), hemi: 1.1, sun: 1.6, fogNear: 80, fogFar: 230,
};
const NIGHT = { // sala escura de cinema: só a tela, as faixas dos degraus e as lanternas iluminam
  sky: new THREE.Color(0x010102), hemiSky: new THREE.Color(0x10141f), hemiGround: new THREE.Color(0x000000),
  sunColor: new THREE.Color(0x8fa8ff), hemi: 0.05, sun: 0.02, fogNear: 20, fogFar: 90,
};
let nightT = 0;
let nightTarget = 0;
const mix = (a, b, t) => a + (b - a) * t;

function applyNight(t) {
  scene.background.lerpColors(DAY.sky, NIGHT.sky, t);
  scene.fog.color.copy(scene.background);
  scene.fog.near = mix(DAY.fogNear, NIGHT.fogNear, t);
  scene.fog.far = mix(DAY.fogFar, NIGHT.fogFar, t);
  hemi.color.lerpColors(DAY.hemiSky, NIGHT.hemiSky, t);
  hemi.groundColor.lerpColors(DAY.hemiGround, NIGHT.hemiGround, t);
  hemi.intensity = mix(DAY.hemi, NIGHT.hemi, t);
  sun.color.lerpColors(DAY.sunColor, NIGHT.sunColor, t);
  sun.intensity = mix(DAY.sun, NIGHT.sun, t);
  world.setNight(t);
  beamMat.opacity = mix(0.012, 0.06, t); // o facho só "aparece" no ar quando está escuro
}

// ---------- Lanterna (L): todo jogador tem uma ----------
const FLASH_INTENSITY = 35;
const FLASH_ANGLE = 0.38;
const BEAM_LENGTH = 12;
const DOWN = new THREE.Vector3(0, -1, 0);
const beamMat = new THREE.MeshBasicMaterial({
  color: 0xfff1d6, transparent: true, opacity: 0.012, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});
const beamGeo = new THREE.ConeGeometry(Math.tan(FLASH_ANGLE) * BEAM_LENGTH, BEAM_LENGTH, 24, 1, true).translate(0, -BEAM_LENGTH / 2, 0);

/**
 * Luzes de lanterna: um estoque FIXO de poucas luzes, repartido entre as lanternas acesas mais perto da câmera.
 * Antes cada jogador tinha a sua luz (mesmo apagada, cada pixel era calculado contra todas, e cada entrada
 * mudava o número de luzes e recompilava os shaders → engasgo). O facho visível continua um por jogador.
 */
const MAX_FLASH_LIGHTS = 2; // a minha + a mais próxima; medido: 3 luzes deixava o jogo 25% mais lento sozinho
const flashLights = Array.from({ length: MAX_FLASH_LIGHTS }, () => {
  const light = new THREE.SpotLight(0xfff1d6, 0, 35, FLASH_ANGLE, 0.55, 1.2);
  scene.add(light, light.target);
  return light;
});

/** Facho visível de um jogador (cone barato, sem luz própria). */
function createFlashlight() {
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.visible = false;
  scene.add(beam);
  return { beam, on: false, origin: new THREE.Vector3(), dir: new THREE.Vector3(), dispose: () => scene.remove(beam) };
}

/** Posiciona o facho na ponta da lanterna, apontando para (yaw, pitch); pitch positivo = para baixo. */
function updateFlashlight(fx, mesh, on, yaw, pitch, showBeam = true) {
  fx.on = on;
  fx.beam.visible = on && showBeam;
  if (!on) return;
  mesh.userData.flashlightTip(fx.origin);
  fx.dir.set(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  fx.beam.position.copy(fx.origin);
  fx.beam.quaternion.setFromUnitVectors(DOWN, fx.dir);
}

/** Dá as luzes do estoque às lanternas acesas mais próximas da câmera (a minha primeiro). */
function assignFlashLights() {
  const active = [game.fx, ...[...remotes.values()].map((r) => r.fx)].filter((fx) => fx.on);
  if (active.length > MAX_FLASH_LIGHTS) {
    const mine = game.fx.on ? [game.fx] : [];
    const others = active.filter((fx) => fx !== game.fx)
      .sort((a, b) => a.origin.distanceToSquared(camera.position) - b.origin.distanceToSquared(camera.position));
    active.splice(0, active.length, ...mine, ...others);
  }
  flashLights.forEach((light, i) => {
    const fx = active[i];
    light.intensity = fx ? FLASH_INTENSITY : 0;
    if (!fx) return;
    light.position.copy(fx.origin);
    light.target.position.copy(fx.origin).addScaledVector(fx.dir, 10);
  });
}

/** Direção da minha lanterna: para onde a câmera olha (na 3ª pessoa, um pouco mais para cima que a câmera). */
function myFlashlightAim() {
  const pitch = game.view === 'first' ? game.pitch : THREE.MathUtils.clamp(game.pitch - 0.3, -0.9, 1.2);
  return { yaw: game.yaw, pitch };
}

function toggleFlashlight() {
  game.flashlight = !game.flashlight;
  game.mesh.userData.setFlashlight(game.flashlight);
  $('flash-btn').classList.toggle('active', game.flashlight);
  toast(game.flashlight ? '🔦 Lanterna ligada (L para desligar)' : '🔦 Lanterna desligada');
}

function setTimeOfDay(value, instant = false) {
  nightTarget = value === 'night' ? 1 : 0;
  if (instant) { nightT = nightTarget; applyNight(nightT); }
  document.querySelectorAll('#time-row button').forEach((b) => b.classList.toggle('active', b.dataset.time === value));
}
const tv = new TV(cssScene, world.screen, {
  onMuted: () => { $('tv-unmute').hidden = false; },
  onError: (msg) => toast(msg),
});

// ---------- HUD ----------
let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

// ---------- Transmissão de tela ----------
const screenShare = new ScreenShare(socket, tv, {
  onChange: updateShareUI, onStats: updateShareStats, toast, quality: load('shareQuality', 'alta'),
});

$('tv-quality').replaceChildren(...Object.entries(QUALITY).map(([key, q]) => new Option(q.label, key, false, key === screenShare.quality)));
$('tv-quality').onchange = async (e) => {
  save('shareQuality', e.target.value);
  await screenShare.setQuality(e.target.value);
  if (screenShare.sharing) toast(`Qualidade: ${QUALITY[e.target.value].label}`);
};

// Status da transmissão: sem avisos na tela de quem transmite; os detalhes ficam no painel do Tab (👥).
let shareStats = null;
function updateShareStats(s) {
  shareStats = s?.height ? s : null;
  if (!$('player-list').hidden) renderShareStatus();
}

function renderShareStatus() {
  const box = $('share-status');
  box.hidden = !screenShare.sharing;
  if (box.hidden) return;
  const s = shareStats;
  const line = (text, cls) => Object.assign(document.createElement('p'), { textContent: text, className: cls ?? '' });
  const rows = [line('📡 Sua transmissão', 'title')];
  if (!s) rows.push(line('Conectando…'));
  else {
    rows.push(line(`${s.height}p · ${s.fps} fps · ${s.mbps.toFixed(1)} Mbps · ${(s.codec ?? '').toUpperCase()} · ${s.viewers} assistindo`));
    const q = QUALITY[screenShare.quality];
    const tip = screenShare.quality === 'normal' ? 'A qualidade se ajusta sozinha.' : 'Se travar, escolha Normal no painel da TV (T).';
    if (s.limit === 'bandwidth') rows.push(line(`⚠ Sua internet de envio não está aguentando ~${(q.bitrate / 1e6).toFixed(1)} Mbps. ${tip}`, 'warn'));
    if (s.limit === 'cpu') rows.push(line(`⚠ Seu computador está no limite para codificar o vídeo (feche programas/abas pesadas). ${tip}`, 'warn'));
  }
  rows.push(line('Para parar: T → ⏹ Parar transmissão'));
  box.replaceChildren(...rows);
}

function updateShareUI() {
  const btn = $('tv-share');
  const other = screenShare.live && !screenShare.sharing;
  btn.classList.toggle('active', screenShare.sharing);
  btn.disabled = other;
  btn.textContent = screenShare.sharing ? '⏹ Parar transmissão'
    : other ? `📡 ${screenShare.broadcaster.by} está transmitindo` : '📡 Transmitir uma aba ou a tela';
  if (!screenShare.sharing) updateShareStats(null);
}

$('tv-share').onclick = async () => {
  if (screenShare.sharing) { screenShare.stop(); return; }
  $('tv-msg').textContent = '';
  try {
    await screenShare.start();
    togglePanel(false);
  } catch (err) {
    if (err.name !== 'NotAllowedError') $('tv-msg').textContent = err.message; // NotAllowed = cancelou a escolha
  }
};

$('tv-unmute').onclick = () => {
  tv.unmute();
  $('tv-unmute').hidden = true;
};

function updateCount() {
  const n = remotes.size + 1;
  $('count').textContent = `${n} jogador${n > 1 ? 'es' : ''} na sala`;
}

// ---------- Painel da TV ----------
const panel = $('tv-panel');
function togglePanel(open = panel.hidden) {
  panel.hidden = !open;
  $('tv-btn').classList.toggle('active', open);
  if (open) {
    toggleInventory(false);
    document.exitPointerLock();
    keys.clear();
    $('tv-msg').textContent = '';
    updateToggleButton();
    updateTimebar();
    $('tv-url').focus();
  } else {
    document.activeElement?.blur();
  }
}

function updateToggleButton() {
  $('tv-toggle').textContent = tv.state.playing ? '⏸ Pausar' : '▶ Play';
}

$('tv-load').onclick = () => {
  const url = $('tv-url').value.trim();
  if (!url) return;
  $('tv-msg').textContent = '';
  socket.emit('tv:load', { url }, (res) => {
    if (!res.ok) { $('tv-msg').textContent = res.error; return; }
    $('tv-url').value = '';
    togglePanel(false);
  });
};
$('tv-url').addEventListener('keydown', (e) => e.key === 'Enter' && $('tv-load').click());


panel.querySelectorAll('[data-tv]').forEach((b) => {
  b.onclick = () => {
    const action = b.dataset.tv;
    if (action === 'toggle') tvControl('toggle');
    else tvControl('seek', action === 'fwd' ? 10 : -10);
  };
});

// ---------- Barra de tempo e controles pessoais (volume / legendas) ----------
function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

let seeking = false; // enquanto arrasta, a barra não é atualizada pelo vídeo
function updateTimebar() {
  const live = screenShare.live;
  const dur = live ? 0 : tv.duration();
  const seek = $('tv-seek');
  seek.disabled = !isController() || !dur;
  $('cc-btn').disabled = !tv.isYouTube || live;
  if (seeking) return;
  const t = dur ? Math.min(tv.expectedTime(), dur) : 0;
  seek.max = String(Math.floor(dur));
  seek.value = String(Math.floor(t));
  $('tv-time').textContent = live ? '● AO VIVO' : fmtTime(t);
  $('tv-duration').textContent = live ? '' : fmtTime(dur);
}
$('tv-seek').addEventListener('input', () => { seeking = true; $('tv-time').textContent = fmtTime($('tv-seek').value); });
$('tv-seek').addEventListener('change', () => {
  seeking = false;
  if (isController() && tv.state.media) socket.emit('tv:control', { action: 'seek', time: Number($('tv-seek').value) });
});
setInterval(() => { if (game && !panel.hidden) updateTimebar(); }, 500);

let userVolume = load('tvVolume', 100);
let userMuted = load('tvMuted', false);
function applyUserVolume() {
  tv.setUserVolume(userMuted ? 0 : userVolume);
  $('vol').value = String(userVolume);
  const icon = userMuted || userVolume === 0 ? '🔇' : userVolume < 50 ? '🔉' : '🔊';
  $('vol-mute').textContent = icon;
  $('mute-btn').textContent = '';
  $('mute-btn').append(icon, Object.assign(document.createElement('kbd'), { textContent: 'M' }));
  $('mute-btn').classList.toggle('active', userMuted);
  save('tvVolume', userVolume);
  save('tvMuted', userMuted);
}
$('vol').addEventListener('input', () => { userVolume = Number($('vol').value); userMuted = false; applyUserVolume(); });
$('vol-mute').onclick = () => toggleMute();
function toggleMute() {
  userMuted = !userMuted;
  applyUserVolume();
  toast(userMuted ? '🔇 TV no mudo (só para você)' : `🔊 Volume da TV: ${userVolume}%`);
}
function changeVolume(delta) {
  userVolume = Math.min(100, Math.max(0, userVolume + delta));
  userMuted = false;
  applyUserVolume();
  toast(`🔊 Volume da TV: ${userVolume}%`);
}
applyUserVolume();

let captions = load('tvCaptions', false);
function applyCaptions() {
  tv.setCaptions(captions);
  $('cc-btn').classList.toggle('active', captions);
  save('tvCaptions', captions);
}
function toggleCaptions() {
  if (!tv.isYouTube) { toast('Legendas só funcionam em vídeos do YouTube.'); return; }
  captions = !captions;
  applyCaptions();
  toast(captions ? 'CC Legendas ligadas (se o vídeo tiver)' : 'Legendas desligadas');
}
$('cc-btn').onclick = toggleCaptions;
applyCaptions();

// ---------- Inventário (I): sons para a sala e bandeiras ----------
const inventory = $('inventory');
function toggleInventory(open = inventory.hidden) {
  if (!game && open) return;
  inventory.hidden = !open;
  if (!open) { document.activeElement?.blur(); return; }
  togglePanel(false);
  document.exitPointerLock();
  keys.clear();
  loadSounds(); // relê a pasta: arquivos novos aparecem na hora
  renderSoundMutes();
  renderFlags();
}
$('inv-btn').onclick = () => toggleInventory();
$('inv-close').onclick = () => toggleInventory(false);
inventory.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    inventory.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    inventory.querySelectorAll('.inv-tab').forEach((t) => { t.hidden = t.id !== `tab-${b.dataset.tab}`; });
  };
});

// Sons: cada um ouve no próprio volume; todos na sala ouvem quando alguém toca
const soundLabel = (file) => file.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
let soundVolume = load('soundVolume', 80);
const playing = new Set();
$('snd-vol').value = String(soundVolume);
$('snd-vol').addEventListener('input', () => {
  soundVolume = Number($('snd-vol').value);
  save('soundVolume', soundVolume);
  for (const a of playing) a.volume = soundVolume / 100;
});
$('snd-stop').onclick = () => { for (const a of playing) a.pause(); playing.clear(); markPlaying(); };

function markPlaying() {
  const names = new Set([...playing].map((a) => a.dataset.name));
  $('sound-grid').querySelectorAll('button').forEach((b) => b.classList.toggle('playing', names.has(b.dataset.name)));
}

function playSound(name) {
  socket.emit('sound:play', { name });
}

async function loadSounds() {
  let sounds = [];
  try { sounds = (await (await fetch('/api/sounds')).json()).sounds; } catch { /* servidor indisponível */ }
  const grid = $('sound-grid');
  if (!sounds.length) {
    grid.innerHTML = '<div class="empty">Nenhum som ainda.<br>Coloque arquivos .mp3 na pasta <code>sounds/</code> do servidor e abra o inventário de novo.</div>';
    return;
  }
  grid.replaceChildren(...sounds.map((name) => {
    const b = document.createElement('button');
    b.dataset.name = name;
    b.textContent = `▶ ${soundLabel(name)}`;
    b.title = name;
    b.onclick = () => playSound(name);
    return b;
  }));
  markPlaying();
}

// Silenciar (só para mim): todos os sons do inventário ou os de pessoas específicas
let soundsMuted = load('soundsMuted', false);
const mutedSenders = new Set(); // ids da sessão atual

function renderSoundMutes() {
  $('snd-mute-all').classList.toggle('active', soundsMuted);
  $('snd-mute-all').textContent = soundsMuted ? '🔊 Sons do inventário silenciados: clique para ouvir de novo' : '🔇 Silenciar todos os sons do inventário';
  const people = [...remotes];
  if (!people.length) {
    $('snd-people').innerHTML = '<li class="empty">Ninguém mais na sala por enquanto.</li>';
    return;
  }
  $('snd-people').replaceChildren(...people.map(([id, r]) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = r.name;
    const b = document.createElement('button');
    const muted = mutedSenders.has(id);
    b.className = muted ? 'muted' : '';
    b.textContent = muted ? '🔇 Silenciado' : '🔊 Ouvindo';
    b.onclick = () => {
      if (mutedSenders.has(id)) mutedSenders.delete(id); else mutedSenders.add(id);
      renderSoundMutes();
    };
    li.append(name, b);
    return li;
  }));
}

$('snd-mute-all').onclick = () => {
  soundsMuted = !soundsMuted;
  save('soundsMuted', soundsMuted);
  if (soundsMuted) $('snd-stop').click(); // corta o que já está tocando
  renderSoundMutes();
};

socket.on('sound:play', ({ name, by, id }) => {
  if (soundsMuted || mutedSenders.has(id)) return; // silenciado por mim: nem toca nem avisa
  const audio = new Audio(`/sounds/${encodeURIComponent(name)}`);
  audio.dataset.name = name;
  audio.volume = soundVolume / 100;
  playing.add(audio);
  audio.onended = audio.onerror = () => { playing.delete(audio); markPlaying(); };
  audio.play().catch(() => { playing.delete(audio); toast('🔇 O navegador bloqueou o som: clique na tela do jogo uma vez.'); });
  markPlaying();
  toast(`🔊 ${by}: ${soundLabel(name)}`);
});

// Bandeiras
function renderFlags() {
  const current = game?.flag ?? '';
  const options = [{ id: '', label: 'Nenhuma' }, ...FLAGS];
  $('flag-grid').replaceChildren(...options.map((f) => {
    const b = document.createElement('button');
    b.className = f.id === current ? 'active' : '';
    let preview;
    if (f.id) preview = drawFlag(f.id, document.createElement('canvas'));
    else { preview = document.createElement('div'); preview.className = 'no-flag'; preview.textContent = '🚫'; }
    const label = document.createElement('span');
    label.textContent = f.label;
    b.append(preview, label);
    b.onclick = () => { setMyFlag(f.id); renderFlags(); };
    return b;
  }));
}

function setMyFlag(id) {
  game.flag = id;
  game.mesh.userData.setFlag(id);
  save('flag', id);
  toast(id ? `🚩 Você está segurando a bandeira: ${FLAGS.find((f) => f.id === id).label}` : '🚩 Bandeira guardada');
}

// ---------- Tomates (G) ----------
const tomatoes = new TomatoSystem(scene, world, {
  getPlayers: () => (game ? [{ id: socket.id, position: game.mesh.position }, ...[...remotes].map(([id, r]) => ({ id, position: r.mesh.position }))] : []),
  getVolume: () => (soundsMuted ? 0 : soundVolume / 100),
  onHit: ({ kind, ownerId, playerId }) => {
    if (kind !== 'player') return;
    if (playerId === socket.id && ownerId !== socket.id) toast(`🍅 Você levou um tomate de ${nameOf(ownerId)}!`);
    else if (ownerId === socket.id && playerId !== socket.id) toast(`🍅 Acertou ${nameOf(playerId)}!`);
  },
});
const TOMATO_COOLDOWN_MS = 600;
let tomatoReadyAt = 0;
// Ponto de mira (invisível): centro da tela em 1ª pessoa; um pouco acima na 3ª, onde o centro é o próprio personagem
const CROSSHAIR_NDC_Y = { first: 0, third: 0.3 };
const aimRay = new THREE.Raycaster();
const _p = new THREE.Vector3();

// O alvo "imantado" fica SEMPRE dentro da tela visível (0,5 m para dentro da borda). Antes ficava 1,5 m para fora,
// além da folga da colisão (0,4 m em tomatoes.js): o tomate mirava ali e passava por baixo da tela sem manchar.
const SCREEN_AIM_INSET = 0.5;
// A tela é enorme (52x29 m) e fica alta: olhando "reto para a frente" (o pitch padrão da câmera), o jogador
// mira embaixo ou do lado dela, principalmente perto/no meio da plateia. Por isso, se a mira passar perto
// do retângulo da tela (dentro desta distância), "imã" puxa o alvo para a borda mais próxima da tela — como
// jogar uma bola numa cesta grande: quem está olhando na direção geral dela não devia errar por pouco.
const SCREEN_SNAP_RANGE = 9;

/** Primeiro ponto que a linha câmera → mira toca: jogador, telão, chão/degrau (ou bem longe). */
function aimPoint() {
  aimRay.setFromCamera(new THREE.Vector2(0, CROSSHAIR_NDC_Y[game.view]), camera);
  const { origin, direction } = aimRay.ray;
  const s = world.screen;
  const others = [...remotes.values()].map((r) => r.mesh.position);
  const start = game.view === 'first' ? 0.5 : game.dist + 0.8; // na 3ª pessoa a linha passa pelo meu personagem

  // Interseção exata com o plano da tela: muito mais precisa que o passo de 0.4 m do raymarch abaixo,
  // que às vezes "pulava" por cima do retângulo da tela e deixava o tomate voar sem acertar nada.
  // Se a mira passar perto mas fora do retângulo, "agarra" no ponto mais próximo da borda (ver SCREEN_SNAP_RANGE).
  let screenPoint = null;
  if (direction.z < -1e-6) {
    const t = (s.position.z - origin.z) / direction.z;
    if (t > start) {
      const halfW = s.width / 2 - SCREEN_AIM_INSET, halfH = s.height / 2 - SCREEN_AIM_INSET;
      const rawX = origin.x + direction.x * t, rawY = origin.y + direction.y * t;
      const x = THREE.MathUtils.clamp(rawX, s.position.x - halfW, s.position.x + halfW);
      const y = THREE.MathUtils.clamp(rawY, s.position.y - halfH, s.position.y + halfH);
      if (Math.hypot(rawX - x, rawY - y) <= SCREEN_SNAP_RANGE) screenPoint = new THREE.Vector3(x, y, s.position.z);
    }
  }

  // Jogador no caminho sempre é atingido primeiro. O chão só conta quando a mira NÃO está na tela:
  // a linha reta da câmera (3ª pessoa, olhando um pouco para baixo) "bate" no carpete uns 10 m antes
  // da tela, mas o tomate voa em arco e passa por cima do chão plano — era isso que fazia o tomate
  // às vezes cair no chão em vez de manchar a tela.
  const limit = screenPoint ? origin.distanceTo(screenPoint) : 150;
  for (let d = start; d < limit; d += 0.4) {
    _p.copy(origin).addScaledVector(direction, d);
    for (const o of others) if (_p.distanceToSquared(o.clone().setY(o.y + 0.75)) < 0.5) return _p.clone();
    if (!screenPoint && _p.y <= world.groundHeight(_p.x, _p.z)) return _p.clone();
  }
  if (screenPoint) return screenPoint;
  return origin.clone().addScaledVector(direction, 120); // mirando para o vazio: joga longe na direção, sem alvo certo
}

/**
 * Velocidade para o tomate (rapidez fixa) cair no alvo: ângulo do lançamento oblíquo, arco baixo.
 * Se o alvo estiver longe demais para essa rapidez, joga a 45° (alcance máximo).
 */
function ballisticVelocity(from, to) {
  const dx = to.x - from.x, dz = to.z - from.z, dy = to.y - from.y;
  const d = Math.hypot(dx, dz);
  const v = THROW_SPEED, g = TOMATO_GRAVITY;
  if (d < 0.01) return new THREE.Vector3(0, Math.sign(dy) * v, 0);
  const disc = v ** 4 - g * (g * d * d + 2 * dy * v * v);
  const angle = disc < 0 ? Math.PI / 4 : Math.atan((v * v - Math.sqrt(disc)) / (g * d));
  return new THREE.Vector3((dx / d) * Math.cos(angle) * v, Math.sin(angle) * v, (dz / d) * Math.cos(angle) * v);
}

/** Joga um tomate exatamente onde a mira aponta. */
function throwTomato() {
  if (!game || cinema || Date.now() < tomatoReadyAt) return;
  tomatoReadyAt = Date.now() + TOMATO_COOLDOWN_MS;
  const pos = game.mesh.position;
  const sitting = game.seat !== null;
  const target = aimPoint();
  target.y += 0.13; // mira o centro do tomate um raio acima: a borda encosta exatamente no ponto da mira
  const origin = new THREE.Vector3(pos.x, pos.y + (sitting ? EYE_HEIGHT_SIT : EYE_HEIGHT) - 0.1, pos.z);
  origin.addScaledVector(target.clone().sub(origin).setY(0).normalize(), 0.5); // sai um pouco à frente do corpo
  const velocity = ballisticVelocity(origin, target);
  const round = (v) => v.toArray().map((n) => Math.round(n * 100) / 100);
  tomatoes.throw(round(origin), round(velocity), socket.id); // simula na hora para mim; os outros recebem pelo servidor
  socket.emit('tomato:throw', { o: round(origin), v: round(velocity) });
}
$('tomato-btn').onclick = () => throwTomato();
$('tv-btn').onclick = () => togglePanel();
$('cinema-btn').onclick = () => setCinema(!cinema);
$('flash-btn').onclick = () => toggleFlashlight();
$('mute-btn').onclick = () => toggleMute();
$('view-btn').onclick = () => setView(game.view === 'first' ? 'third' : 'first');
// Padrão: 3D leve (sem sombras, resolução 1x) para priorizar o vídeo. "3D caprichado" (✨) liga sombras e
// resolução maior para quem tem computador forte. Fica salvo para a próxima vez.
let fancyGraphics = load('fancyGraphics', false);
function applyGraphics(announce) {
  renderer.setPixelRatio(fancyGraphics ? Math.min(devicePixelRatio, 1.5) : 1);
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = fancyGraphics;
  sun.castShadow = fancyGraphics;
  scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); }); // liga/desliga sombra nos shaders
  $('fancy-btn').classList.toggle('active', fancyGraphics);
  save('fancyGraphics', fancyGraphics);
  if (announce) toast(fancyGraphics ? '✨ 3D caprichado: sombras e resolução maior (o vídeo não muda)' : '⚡ 3D leve: mais fluido (o vídeo não muda)');
}
$('fancy-btn').onclick = () => { fancyGraphics = !fancyGraphics; applyGraphics(true); };

function toggleMoon() {
  game.moon = !game.moon;
  $('moon-btn').classList.toggle('active', game.moon);
  toast(game.moon ? '🌕 Gravidade da lua: pulos altos e queda lenta (K para voltar)' : '🌍 Gravidade normal');
}
$('moon-btn').onclick = () => game && toggleMoon();
applyGraphics(false);
let namesPinned = false;
$('names-btn').onclick = () => {
  namesPinned = !namesPinned;
  showNames(namesPinned);
  $('names-btn').classList.toggle('active', namesPinned);
};
socket.on('tomato:throw', ({ o, v, id }) => tomatoes.throw(o, v, id));

const TV_ACTIONS = { load: 'colocou um vídeo', play: 'deu play', pause: 'pausou', seek: 'pulou o vídeo' };
socket.on('tv:state', ({ by, action, ...state }) => {
  tv.applyState(state);
  updateToggleButton();
  if (!by) return;
  const name = action === 'load' && state.media?.name;
  toast(`📺 ${by} ${name ? `colocou "${name}"` : TV_ACTIONS[action] ?? ''}`);
});

// ---------- Jogadores ----------
let game = null;
const remotes = new Map(); // id -> { mesh, name, target, anim }
const keys = new Set();

// ---------- Papéis: admin 👑 (dono da sala) e controle da TV 🎮 ----------
let roles = { admin: null, controller: null };
const isAdmin = () => roles.admin === socket.id;
const isController = () => roles.controller === socket.id;
const nameOf = (id) => (id === socket.id ? game?.name : remotes.get(id)?.name) ?? '?';
const badges = (id) => (id === roles.admin ? '👑 ' : '') + (id === roles.controller ? '🎮 ' : '');

function applyRoles(next, by) {
  const changed = next.controller !== roles.controller;
  roles = { admin: next.admin, controller: next.controller };
  updateRolesUI();
  updateShareUI();
  if (by && changed) toast(`🎮 ${by} passou o controle da TV para ${isController() ? 'você' : nameOf(roles.controller)}`);
}

function updateRolesUI() {
  if (!game) return;
  game.mesh.userData.setTitle(badges(socket.id) + game.name);
  for (const [id, r] of remotes) r.mesh.userData.setTitle(badges(id) + r.name);
  $('roles').textContent = `👑 ${nameOf(roles.admin)} · 🎮 TV: ${nameOf(roles.controller)}`;
  $('roles-line').textContent = isController()
    ? '🎮 Você tem o controle da TV.'
    : `🎮 Quem controla a TV: ${nameOf(roles.controller)}${isAdmin() ? ' (você é o admin 👑)' : ''}`;

  $('tv-controls').classList.toggle('locked', !isController());
  $('tv-lock').hidden = isController();
  $('tv-lock').textContent = `🔒 Só ${nameOf(roles.controller)} pode mudar o que passa no telão. Peça o controle!`;

  // Passar o controle: quem tem o controle (ou o admin) escolhe outro jogador
  const targets = [...remotes.entries()].filter(([id]) => id !== roles.controller);
  const canPass = (isController() || isAdmin()) && targets.length > 0;
  $('pass-to').replaceChildren(...targets.map(([id, r]) => new Option(`${badges(id)}${r.name}`, id)));
  $('pass-btn').hidden = !canPass;
  $('pass-to').hidden = !canPass;
  $('take-btn').hidden = !(isAdmin() && !isController());
  $('pass-row').hidden = $('pass-btn').hidden && $('take-btn').hidden;
  $('time-row').hidden = !isAdmin();
}

socket.on('room:roles', ({ by, ...next }) => applyRoles(next, by));
socket.on('room:time', ({ value, by }) => {
  setTimeOfDay(value);
  toast(value === 'night' ? `🌙 ${by} apagou as luzes: sessão de cinema!` : `☀️ ${by} mudou para dia`);
});

$('pass-btn').onclick = () => { if ($('pass-to').value) socket.emit('room:pass-control', { to: $('pass-to').value }); };
$('take-btn').onclick = () => socket.emit('room:pass-control', { to: socket.id });
document.querySelectorAll('#time-row button').forEach((b) => {
  b.onclick = () => socket.emit('room:time', { value: b.dataset.time });
});

function addRemote(p) {
  const mesh = createCharacter(p.appearance, p.name);
  mesh.position.set(p.x, p.y, p.z);
  mesh.rotation.y = p.ry;
  scene.add(mesh);
  mesh.userData.setFlashlight(!!p.fl);
  mesh.userData.setFlag(p.fg ?? '');
  queueMicrotask(() => { if (!inventory.hidden) renderSoundMutes(); });
  remotes.set(p.id, {
    mesh, name: p.name, anim: p.anim, fx: createFlashlight(), fl: !!p.fl, ly: p.ly ?? 0, lp: p.lp ?? 0,
    snap: true, // a 1ª posição recebida é aplicada direto (quem acabou de entrar ainda está no ponto neutro)
    target: { x: p.x, y: p.y, z: p.z, ry: p.ry, fl: !!p.fl, ly: p.ly ?? 0, lp: p.lp ?? 0 },
  });
  updateCount();
  updateRolesUI();
}

function removeRemote(id) {
  const r = remotes.get(id);
  if (!r) return;
  scene.remove(r.mesh);
  r.mesh.userData.dispose();
  r.fx.dispose();
  remotes.delete(id);
  mutedSenders.delete(id);
  updateCount();
  updateRolesUI();
  if (!inventory.hidden) renderSoundMutes();
}

socket.on('player:joined', (p) => { addRemote(p); toast(`${p.name} entrou na sala`); });
socket.on('player:left', removeRemote);
socket.on('player:state', (s) => {
  const r = remotes.get(s.id);
  if (!r) return;
  if (r.snap) { // sem isso o personagem "deslizaria" pelo mapa até o ponto de entrada
    r.mesh.position.set(s.x, s.y, s.z);
    r.mesh.rotation.y = s.ry;
    r.snap = false;
  }
  r.target = s;
  r.anim = s.anim;
});

function startGame({ code, self, players, tv: tvState, screen, roles: initialRoles, time }) {
  preview.dispose();
  $('lobby').remove();
  $('hud').hidden = false;
  $('room-code').textContent = code;
  $('copy').onclick = async () => {
    const link = `${location.origin}${location.pathname}?sala=${code}`;
    try { await navigator.clipboard.writeText(link); $('copy').textContent = 'Link copiado!'; }
    catch { $('copy').textContent = code; }
    setTimeout(() => ($('copy').textContent = 'Copiar'), 1500);
  };

  document.body.append(cssRenderer.domElement, renderer.domElement, labelRenderer.domElement);
  const mesh = createCharacter(self.appearance, self.name);
  const spawn = spawnPoint(); // na frente da plateia; a posição vai para os outros no primeiro envio de estado
  mesh.position.set(spawn.x, 0, spawn.z);
  mesh.rotation.y = spawn.ry;
  scene.add(mesh);

  game = {
    mesh, name: self.name, velY: 0, grounded: true, yaw: spawn.ry + Math.PI, pitch: 0.35, dist: 7, view: 'third', // câmera atrás, olhando as cadeiras
    anim: 'idle', seat: null, sitPending: false, lastSent: 0, lastState: '', flashlight: false, fx: createFlashlight(),
    flag: '', moon: false,
  };
  $('moon-btn').classList.remove('active');
  setView(load('view', 'third'));
  players.forEach(addRemote);
  updateCount();
  tv.applyState(tvState);
  updateToggleButton();
  screenShare.init(screen);
  applyRoles(initialRoles);
  setTimeOfDay(time, true);
  const savedFlag = load('flag', '');
  if (FLAGS.some((f) => f.id === savedFlag)) { game.flag = savedFlag; mesh.userData.setFlag(savedFlag); }

  renderer.domElement.addEventListener('click', () => { if (!cinema) renderer.domElement.requestPointerLock(); });
  clock.start();
  renderer.setAnimationLoop(loop);
}

// ---------- Cadeiras ----------
function nearestSeat(pos, maxDist = 1.4) {
  let best = -1;
  world.seats.forEach((s, i) => {
    if (Math.abs(s.floor - pos.y) > 0.5) return; // só cadeiras da fileira (degrau) em que estou
    const d = Math.hypot(s.x - pos.x, s.z - pos.z);
    if (d < maxDist) { maxDist = d; best = i; }
  });
  return best;
}

function trySit() {
  const i = nearestSeat(game.mesh.position);
  if (i < 0 || game.sitPending) return;
  game.sitPending = true;
  socket.emit('seat:sit', { seat: i }, (res) => {
    game.sitPending = false;
    if (!res.ok) { toast(res.error); return; }
    const s = world.seats[i];
    game.seat = i;
    game.velY = 0;
    game.mesh.position.set(s.x, s.floor + SEAT_TOP + SIT_OFFSET, s.z);
    game.mesh.rotation.y = s.ry;
  });
}

function standUp() {
  const s = world.seats[game.seat];
  game.seat = null;
  socket.emit('seat:stand');
  // levanta no espaço livre à frente da cadeira, no mesmo degrau
  game.mesh.position.set(s.x + Math.sin(s.ry) * 0.95, s.floor, s.z + Math.cos(s.ry) * 0.95);
}

// ---------- Câmera: 1ª/3ª pessoa ----------
// 3ª pessoa: a câmera orbita até ORBIT_MIN_PITCH (mais baixo ela entraria no chão); passando disso o mouse
// só inclina o OLHAR para cima. Sem isso a mira não subia mais que ~20°, e da plateia a metade de cima
// da tela (até 31 m de altura) ficava fora de alcance para os tomates.
const ORBIT_MIN_PITCH = -0.2;
const PITCH_LIMITS = { third: [-1.1, 1.3], first: [-1.4, 1.4] };

function setView(view) {
  game.view = view;
  game.mesh.userData.setFirstPerson(view === 'first');
  game.pitch = THREE.MathUtils.clamp(view === 'first' ? 0 : 0.35, ...PITCH_LIMITS[view]);
  save('view', view);
  $('view-btn').textContent = '';
  $('view-btn').append('👁', Object.assign(document.createElement('kbd'), { textContent: 'V' }));
  $('view-btn').title = view === 'first' ? '1ª pessoa (V)' : '3ª pessoa (V)';
}

// ---------- Modo cinema (vídeo ocupando a tela) ----------
let cinema = false;
let cinemaFill = load('cinemaFill', false);

function setCinema(on) {
  if (on === cinema) return;
  cinema = on;
  document.body.classList.toggle('cinema', on);
  keys.clear();
  wakeCinemaUI();
  tomatoes.setVisible(!on); // no modo cinema não aparecem tomates nem manchas por cima do filme
  if (on) {
    document.exitPointerLock();
    tv.enterCinema(cinemaFill);
    toast(screenShare.live ? '🎬 Transmissão ao vivo · ↑↓ volume · Z ajustar/preencher · F ou Esc para sair'
      : '🎬 Espaço pausa · ← → 10s · ↑↓ volume · C legendas · F ou Esc para sair');
    if (!document.fullscreenElement) {
      const req = document.documentElement.requestFullscreen?.();
      if (!req) toast('Seu navegador não suporta tela cheia: aperte F11.');
      else req.catch(() => toast('O navegador bloqueou a tela cheia: aperte F11.'));
    }
  } else {
    tv.exitCinema();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
}

function toggleCinemaFill() {
  cinemaFill = !cinemaFill;
  save('cinemaFill', cinemaFill);
  tv.layoutCinema(cinemaFill);
  toast(cinemaFill ? 'Preencher: tela toda (corta as bordas)' : 'Ajustar: vídeo inteiro');
}

// No cinema, esconde botões e cursor depois de 3 s parado; qualquer movimento do mouse traz de volta
let idleTimer = 0;
function wakeCinemaUI() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  if (cinema) idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
}
addEventListener('mousemove', wakeCinemaUI);

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) setCinema(false); // saiu da tela cheia pelo Esc do navegador
});

function tvControl(action, delta = 0) {
  if (!isController()) { toast(`🔒 Só ${nameOf(roles.controller)} pode controlar a TV.`); return; }
  if (screenShare.live) { toast('Durante a transmissão, quem transmite controla o vídeo na própria aba.'); return; }
  if (!tv.state.media) { toast('Carregue um vídeo primeiro (T).'); return; }
  const t = tv.expectedTime();
  if (action === 'toggle') socket.emit('tv:control', { action: tv.state.playing ? 'pause' : 'play', time: t });
  else socket.emit('tv:control', { action: 'seek', time: Math.max(0, t + delta) });
}

$('tv-cinema').onclick = () => { togglePanel(false); setCinema(true); };

// ---------- Input ----------
addEventListener('keydown', (e) => {
  if (!game) return;
  if (e.code === 'Escape') { togglePanel(false); toggleInventory(false); setCinema(false); return; }
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Tab') { e.preventDefault(); showNames(true); return; } // segurar Tab mostra os nomes
  if (e.code === 'KeyT') { e.preventDefault(); togglePanel(); return; }
  if (e.code === 'KeyI' && !e.repeat) { toggleInventory(); return; }
  if (e.code === 'KeyG' && !e.repeat && panel.hidden && inventory.hidden && !cinema) { throwTomato(); return; }
  if (!panel.hidden || !inventory.hidden) return;
  if (e.code === 'KeyF' && !e.repeat) { setCinema(!cinema); return; }
  if (e.code === 'KeyM' && !e.repeat) { toggleMute(); return; }
  if (e.code === 'KeyC' && !e.repeat) { toggleCaptions(); return; }
  if (cinema) { // no cinema o teclado controla o vídeo, não o personagem
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) tvControl('toggle'); }
    if (e.code === 'ArrowLeft') tvControl('seek', -10);
    if (e.code === 'ArrowRight') tvControl('seek', 10);
    if (e.code === 'ArrowUp') { e.preventDefault(); changeVolume(10); }
    if (e.code === 'ArrowDown') { e.preventDefault(); changeVolume(-10); }
    if (e.code === 'KeyZ' && !e.repeat) toggleCinemaFill();
    return;
  }
  if (e.code === 'KeyL' && !e.repeat) { toggleFlashlight(); return; }
  if (e.code === 'KeyP' && !e.repeat) { fancyGraphics = !fancyGraphics; applyGraphics(true); return; }
  if (e.code === 'KeyK' && !e.repeat) { toggleMoon(); return; }
  if (e.code === 'KeyV' && !e.repeat) { setView(game.view === 'first' ? 'third' : 'first'); return; }
  if (e.code === 'KeyE' && !e.repeat) { if (game.seat !== null) standUp(); else trySit(); return; }
  keys.add(e.code);
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Tab') showNames(namesPinned);
});
addEventListener('blur', () => { keys.clear(); showNames(false); });

// ---------- Nomes (Tab) ----------
// Os nomes acima das cabeças ficam escondidos; segurando Tab aparecem, junto com a lista de quem está na sala.
function showNames(on) {
  if (!game) return;
  document.body.classList.toggle('show-names', on);
  $('player-list').hidden = !on;
  if (!on) return;
  const people = [[socket.id, game.name], ...[...remotes].map(([id, r]) => [id, r.name])];
  $('player-list-items').replaceChildren(...people.map(([id, name]) => {
    const li = document.createElement('li');
    li.textContent = `${badges(id)}${name}${id === socket.id ? ' (você)' : ''}`;
    return li;
  }));
  $('player-list-title').textContent = `${people.length} na sala`;
  renderShareStatus();
}
addEventListener('mousemove', (e) => {
  if (!game || document.pointerLockElement !== renderer.domElement) return;
  game.yaw -= e.movementX * 0.0025;
  game.pitch = THREE.MathUtils.clamp(game.pitch + e.movementY * 0.0025, ...PITCH_LIMITS[game.view]);
});
addEventListener('wheel', (e) => {
  if (game && panel.hidden && game.view === 'third') game.dist = THREE.MathUtils.clamp(game.dist + e.deltaY * 0.01, 3, 15);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
  cssRenderer.setSize(innerWidth, innerHeight);
  if (cinema) tv.layoutCinema(cinemaFill);
});

// ---------- Física / colisão ----------
const PLAYER_RADIUS = 0.4;
const GRAVITY = -25;
const JUMP_SPEED = 9;
// Gravidade da lua (K): só do próprio personagem; os outros veem os pulos altos porque a posição é sincronizada
const MOON_GRAVITY = -4.5;
const MOON_JUMP_SPEED = 14; // ~21,5 m: do chão alcança 2/3 da altura da tela; ~6 s no ar (na Terra: 1,6 m e 0,7 s)
const MAX_STEP = 0.55; // degraus até essa altura são subidos andando

function resolveCollisions(pos) {
  for (const o of world.obstacles) {
    if (o.maxY !== undefined && pos.y >= o.maxY - 0.01) continue; // está acima (pulando por cima, ou de pé no assento)
    const cx = THREE.MathUtils.clamp(pos.x, o.minX, o.maxX);
    const cz = THREE.MathUtils.clamp(pos.z, o.minZ, o.maxZ);
    const dx = pos.x - cx, dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= PLAYER_RADIUS * PLAYER_RADIUS) continue;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      pos.x = cx + (dx / d) * PLAYER_RADIUS;
      pos.z = cz + (dz / d) * PLAYER_RADIUS;
    } else { // centro dentro da caixa: empurra pelo lado mais próximo
      const pushes = [
        [o.minX - PLAYER_RADIUS - pos.x, 0], [o.maxX + PLAYER_RADIUS - pos.x, 0],
        [0, o.minZ - PLAYER_RADIUS - pos.z], [0, o.maxZ + PLAYER_RADIUS - pos.z],
      ].sort((a, b) => Math.abs(a[0] + a[1]) - Math.abs(b[0] + b[1]));
      pos.x += pushes[0][0]; pos.z += pushes[0][1];
    }
  }
  const b = WORLD_BOUNDS;
  pos.x = THREE.MathUtils.clamp(pos.x, b.minX + PLAYER_RADIUS, b.maxX - PLAYER_RADIUS);
  pos.z = THREE.MathUtils.clamp(pos.z, b.minZ + PLAYER_RADIUS, b.maxZ - PLAYER_RADIUS);
}

function highestGround(x, z) {
  const r = PLAYER_RADIUS * 0.9;
  return Math.max(
    world.groundHeight(x, z),
    world.groundHeight(x + r, z), world.groundHeight(x - r, z),
    world.groundHeight(x, z + r), world.groundHeight(x, z - r),
  );
}

function lerpAngle(a, b, t) {
  const diff = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + diff * t;
}

// ---------- Loop ----------
const clock = new THREE.Clock(false);
const camTarget = new THREE.Vector3();
const camWanted = new THREE.Vector3();
const _camP = new THREE.Vector3();
const CAM_STEPS = 16;
const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];

function loop() {
  const realDt = clock.getDelta();
  const dt = Math.min(realDt, 0.05); // física estável mesmo com quedas de fps
  const g = game;
  const pos = g.mesh.position;

  if (g.seat !== null && MOVE_KEYS.some((k) => keys.has(k))) standUp();

  if (g.seat !== null) {
    g.anim = 'sit';
  } else {
    // Movimento relativo à câmera
    const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const side = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const running = keys.has('ShiftLeft') || keys.has('ShiftRight');
    let moving = false;
    const prevX = pos.x, prevZ = pos.z;
    if (fwd || side) {
      const sin = Math.sin(g.yaw), cos = Math.cos(g.yaw);
      let dx = -sin * fwd + cos * side;
      let dz = -cos * fwd - sin * side;
      const len = Math.hypot(dx, dz);
      dx /= len; dz /= len;
      const speed = running ? 9 : 4.5;
      pos.x += dx * speed * dt;
      pos.z += dz * speed * dt;
      g.mesh.rotation.y = lerpAngle(g.mesh.rotation.y, Math.atan2(dx, dz), 1 - Math.exp(-15 * dt));
      moving = true;
    }

    resolveCollisions(pos);
    // Degrau alto demais (lateral/fundo da arquibancada) funciona como parede; checa as bordas do corpo também
    if (highestGround(pos.x, pos.z) - pos.y > MAX_STEP) { pos.x = prevX; pos.z = prevZ; }

    if (keys.has('Space') && g.grounded) { g.velY = g.moon ? MOON_JUMP_SPEED : JUMP_SPEED; g.grounded = false; }
    const floor = world.groundHeight(pos.x, pos.z);
    if (g.grounded && pos.y - floor <= MAX_STEP) {
      pos.y = floor; // sobe/desce degraus andando, sem "pular"
      g.velY = 0;
    } else {
      g.velY += (g.moon ? MOON_GRAVITY : GRAVITY) * dt;
      pos.y += g.velY * dt;
      g.grounded = pos.y <= floor;
      if (g.grounded) { pos.y = floor; g.velY = 0; }
    }

    if (g.view === 'first') g.mesh.rotation.y = g.yaw + Math.PI;
    // Com a lanterna ligada o corpo vira para onde se está mirando (anda "de lado" como quem procura algo)
    else if (g.flashlight) g.mesh.rotation.y = lerpAngle(g.mesh.rotation.y, g.yaw + Math.PI, 1 - Math.exp(-10 * dt));
    g.anim = !g.grounded ? 'jump' : moving ? (running ? 'run' : 'walk') : 'idle';
  }
  g.mesh.userData.animate(g.anim, dt);

  if (g.view === 'first') {
    // Olhos na altura da cabeça do modelo (sentado o corpo desce, então usa a altura de sentado)
    const eyeY = pos.y + (g.seat !== null ? EYE_HEIGHT_SIT : EYE_HEIGHT);
    const sin = Math.sin(g.yaw), cos = Math.cos(g.yaw), cp = Math.cos(g.pitch);
    camera.position.set(pos.x - sin * 0.12, eyeY, pos.z - cos * 0.12);
    camTarget.set(camera.position.x - sin * cp, eyeY - Math.sin(g.pitch), camera.position.z - cos * cp);
    camera.lookAt(camTarget);
  } else {
    // Terceira pessoa: órbita ao redor do jogador
    camTarget.set(pos.x, pos.y + (g.seat !== null ? CAMERA_TARGET * 0.75 : CAMERA_TARGET), pos.z);
    const orbit = Math.max(g.pitch, ORBIT_MIN_PITCH);
    const horiz = Math.cos(orbit) * g.dist;
    camWanted.set(
      camTarget.x + Math.sin(g.yaw) * horiz,
      Math.max(0.3, camTarget.y + Math.sin(orbit) * g.dist),
      camTarget.z + Math.cos(g.yaw) * horiz,
    );
    // Atrás de quem está na plateia os degraus sobem: se o caminho até a câmera entra no chão, ela se
    // aproxima do personagem (senão a imagem ficava "dentro" da arquibancada de trás)
    let reach = 1;
    for (let i = 1; i <= CAM_STEPS; i++) {
      _camP.lerpVectors(camTarget, camWanted, i / CAM_STEPS);
      if (_camP.y < world.groundHeight(_camP.x, _camP.z) + 0.4) { reach = (i - 1) / CAM_STEPS; break; }
    }
    camera.position.lerpVectors(camTarget, camWanted, Math.max(reach, 0.12));
    if (g.pitch < ORBIT_MIN_PITCH) {
      // olhando para cima além da órbita: mantém a câmera e levanta o ponto para onde ela olha
      const flat = Math.hypot(camTarget.x - camera.position.x, camTarget.z - camera.position.z);
      const elev = Math.atan2(camTarget.y - camera.position.y, flat) + (ORBIT_MIN_PITCH - g.pitch);
      camTarget.y = camera.position.y + Math.tan(elev) * flat;
    }
    camera.lookAt(camTarget);
  }

  if (nightT !== nightTarget) {
    const step = realDt / 2; // 2 s de transição em tempo real, independente do fps
    nightT = nightTarget > nightT ? Math.min(nightTarget, nightT + step) : Math.max(nightTarget, nightT - step);
    applyNight(nightT);
  }

  sun.position.set(pos.x + 30, 50, pos.z + 20);
  sun.target.position.copy(pos);

  tomatoes.listenerPosition = pos;
  tomatoes.update(Math.min(realDt, 0.25)); // tempo real: a trajetória fica igual para todos mesmo com fps diferentes

  const aim = myFlashlightAim();
  updateFlashlight(g.fx, g.mesh, g.flashlight, aim.yaw, aim.pitch, g.view !== 'first'); // em 1ª pessoa o facho cobriria a tela

  tv.updateVolume(cinema ? 0 : Math.hypot(pos.x - world.screen.position.x, pos.z - world.screen.position.z));

  // Jogadores remotos: interpolação suave até o último estado recebido
  const t = 1 - Math.exp(-12 * dt);
  for (const r of remotes.values()) {
    r.mesh.position.x += (r.target.x - r.mesh.position.x) * t;
    r.mesh.position.y += (r.target.y - r.mesh.position.y) * t;
    r.mesh.position.z += (r.target.z - r.mesh.position.z) * t;
    r.mesh.rotation.y = lerpAngle(r.mesh.rotation.y, r.target.ry, t);
    if (r.fl !== !!r.target.fl) { r.fl = !!r.target.fl; r.mesh.userData.setFlashlight(r.fl); }
    r.mesh.userData.setFlag(r.target.fg ?? ''); // não faz nada se não mudou
    r.ly = lerpAngle(r.ly, r.target.ly ?? 0, t);
    r.lp += ((r.target.lp ?? 0) - r.lp) * t;
    r.mesh.userData.animate(r.anim, dt);
    updateFlashlight(r.fx, r.mesh, r.fl, r.ly, r.lp);
  }
  assignFlashLights();

  // Envio de estado a ~20 Hz, só quando muda
  const now = performance.now();
  if (now - g.lastSent > 50) {
    const state = {
      x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2), ry: +g.mesh.rotation.y.toFixed(2), anim: g.anim,
      // direção da lanterna só vai junto quando ligada (evita mandar estado a cada mexida do mouse)
      fl: g.flashlight, ly: g.flashlight ? +aim.yaw.toFixed(2) : 0, lp: g.flashlight ? +aim.pitch.toFixed(2) : 0,
      fg: g.flag,
    };
    const key = JSON.stringify(state);
    if (key !== g.lastState) {
      socket.emit('player:state', state);
      g.lastState = key;
      g.lastSent = now;
    }
  }

  if (!cinema) { // no cinema a cena fica escondida e o vídeo é posicionado em 2D pelo TV
    renderer.render(scene, camera);
    cssRenderer.render(cssScene, camera);
    labelRenderer.render(scene, camera);
  }
}
