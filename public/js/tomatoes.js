import * as THREE from 'three';

/**
 * Tomates: lançados em arco, estouram no que acertarem (chão/degraus, telão, jogadores),
 * espalham pedaços e deixam uma mancha que some aos poucos.
 * Cada cliente simula o mesmo lançamento (origem + velocidade vêm do servidor), então todos veem igual.
 */
export const THROW_SPEED = 34; // m/s — com a gravidade abaixo, alcança ~100 m: chega na tela de qualquer lugar
export const TOMATO_GRAVITY = 9.8;
const GRAVITY = TOMATO_GRAVITY;
const STEP = 1 / 120; // passos curtos para não atravessar nada entre um quadro e outro
const MAX_LIFE = 8;
const TOMATO_RADIUS = 0.13;
const PLAYER_HIT_RADIUS = 0.6; // os personagens são "cabeçudos": esfera generosa no centro do corpo
const PLAYER_HIT_HEIGHT = 0.75;
const OWNER_GRACE = 0.25; // s sem colidir com quem jogou (sai da mão dele)
const MAX_PARTICLES = 700;
const MAX_SPLATS = 60;
const SPLAT_LIFE = 9;

const tomatoGeo = new THREE.SphereGeometry(TOMATO_RADIUS, 14, 10);
const tomatoMat = new THREE.MeshStandardMaterial({ color: 0xd8261c, roughness: 0.35 });
const leafGeo = new THREE.ConeGeometry(0.06, 0.05, 5);
const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f8a2f, roughness: 0.8 });

// Pedaços: polpa vermelha, laranja, sementes amarelas e verde do cabinho
const PARTICLE_COLORS = [0xd8261c, 0xd8261c, 0xb51912, 0xff5a36, 0xff8c42, 0xf4d35e, 0x3f9b3a];

export class TomatoSystem {
  #scene;
  #world;
  #getPlayers;
  #onHit;
  #tomatoes = [];
  #particles;
  #pData = [];
  #splats = [];
  #audio = null;
  #dummy = new THREE.Object3D();
  #color = new THREE.Color();

  /**
   * @param getPlayers () => [{ id, position: Vector3 }] — todos os personagens (eu e os outros)
   * @param onHit ({ kind: 'player'|'screen'|'ground', ownerId, playerId, point }) => void
   */
  constructor(scene, world, { getPlayers, onHit, getVolume }) {
    this.#scene = scene;
    this.#world = world;
    this.#getPlayers = getPlayers;
    this.#onHit = onHit;
    this.getVolume = getVolume;

    this.#particles = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.6 }), MAX_PARTICLES);
    this.#particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#particles.frustumCulled = false;
    this.#particles.setColorAt(0, this.#color.set(0xffffff)); // cria o buffer de cores já (evita recompilar o material no 1º estouro)
    this.#particles.count = 0;
    scene.add(this.#particles);
  }

  /** Lança um tomate. origin/velocity: Vector3 (ou arrays [x,y,z]). */
  throw(origin, velocity, ownerId) {
    const mesh = new THREE.Group();
    const ball = new THREE.Mesh(tomatoGeo, tomatoMat);
    const leaf = new THREE.Mesh(leafGeo, leafMat);
    leaf.position.y = TOMATO_RADIUS;
    ball.castShadow = true;
    mesh.add(ball, leaf);
    const pos = new THREE.Vector3().fromArray(Array.isArray(origin) ? origin : origin.toArray());
    const vel = new THREE.Vector3().fromArray(Array.isArray(velocity) ? velocity : velocity.toArray());
    mesh.position.copy(pos);
    this.#scene.add(mesh);
    this.#tomatoes.push({ mesh, pos, vel, prev: pos.clone(), age: 0, ownerId, spin: new THREE.Vector3(Math.random() * 12, Math.random() * 12, 0) });
  }

  update(dt) {
    this.#updateTomatoes(dt);
    this.#updateParticles(dt);
    this.#updateSplats(dt);
  }

  #updateTomatoes(dt) {
    for (let i = this.#tomatoes.length - 1; i >= 0; i--) {
      const t = this.#tomatoes[i];
      let hit = null;
      for (let left = dt; left > 0 && !hit; left -= STEP) {
        const h = Math.min(STEP, left);
        t.prev.copy(t.pos);
        t.vel.y -= GRAVITY * h;
        t.pos.addScaledVector(t.vel, h);
        t.age += h;
        hit = this.#collide(t);
      }
      t.mesh.position.copy(t.pos);
      t.mesh.rotation.x += t.spin.x * dt;
      t.mesh.rotation.y += t.spin.y * dt;
      if (hit) {
        // no telão (52 m) tudo é maior para aparecer de qualquer lugar da plateia
        this.#splash(hit.point, hit.normal, hit.kind !== 'player', hit.kind === 'screen' ? 3 : 1);
        this.#onHit?.({ ...hit, ownerId: t.ownerId });
      }
      if (hit || t.age > MAX_LIFE) {
        this.#scene.remove(t.mesh);
        this.#tomatoes.splice(i, 1);
      }
    }
  }

  #collide(t) {
    const { pos, prev } = t;
    // Jogadores
    {
      for (const p of this.#getPlayers()) {
        if (p.id === t.ownerId && t.age < OWNER_GRACE) continue;
        const cx = p.position.x, cy = p.position.y + PLAYER_HIT_HEIGHT, cz = p.position.z;
        const dx = pos.x - cx, dy = pos.y - cy, dz = pos.z - cz;
        if (dx * dx + dy * dy + dz * dz < (PLAYER_HIT_RADIUS + TOMATO_RADIUS) ** 2) {
          const normal = new THREE.Vector3(dx, dy, dz).normalize();
          return { kind: 'player', playerId: p.id, point: pos.clone(), normal };
        }
      }
    }
    // Telão (plano voltado para +Z): cruzou a frente da tela dentro da moldura
    const s = this.#world.screen;
    if (prev.z > s.position.z && pos.z <= s.position.z) {
      const k = (prev.z - s.position.z) / (prev.z - pos.z);
      const x = prev.x + (pos.x - prev.x) * k, y = prev.y + (pos.y - prev.y) * k;
      if (Math.abs(x - s.position.x) <= s.width / 2 + 0.4 && Math.abs(y - s.position.y) <= s.height / 2 + 0.4) {
        return { kind: 'screen', point: new THREE.Vector3(x, y, s.position.z + 0.06), normal: new THREE.Vector3(0, 0, 1) };
      }
    }
    // Chão e degraus da arquibancada
    const floor = this.#world.groundHeight(pos.x, pos.z);
    if (pos.y - TOMATO_RADIUS <= floor) {
      return { kind: 'ground', point: new THREE.Vector3(pos.x, floor + 0.015, pos.z), normal: new THREE.Vector3(0, 1, 0) };
    }
    return null;
  }

  /** Estouro: pedaços voando para fora da superfície + mancha (exceto em jogadores) + som. */
  #splash(point, normal, withSplat, scale = 1) {
    const count = scale > 1 ? 40 : 30;
    for (let i = 0; i < count; i++) {
      if (this.#pData.length >= MAX_PARTICLES) this.#pData.shift();
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      if (dir.dot(normal) < 0) dir.reflect(normal); // só para o lado de fora
      dir.addScaledVector(normal, 0.6).normalize();
      this.#pData.push({
        pos: point.clone().addScaledVector(normal, 0.05),
        vel: dir.multiplyScalar((2 + Math.random() * 4.5) * Math.sqrt(scale)),
        rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, 0),
        spin: (Math.random() - 0.5) * 20,
        size: (0.05 + Math.random() * 0.09) * scale,
        life: 0.7 + Math.random() * 0.6,
        age: 0,
        color: PARTICLE_COLORS[(Math.random() * PARTICLE_COLORS.length) | 0],
      });
    }
    if (withSplat) this.#addSplat(point, normal, scale);
    this.#playSplatSound(point);
  }

  #updateParticles(dt) {
    const data = this.#pData;
    for (let i = data.length - 1; i >= 0; i--) {
      const p = data[i];
      p.age += dt;
      if (p.age >= p.life) { data.splice(i, 1); continue; }
      p.vel.y -= GRAVITY * 1.6 * dt;
      p.pos.addScaledVector(p.vel, dt);
      const floor = this.#world.groundHeight(p.pos.x, p.pos.z);
      if (p.pos.y < floor + 0.01) { p.pos.y = floor + 0.01; p.vel.set(0, 0, 0); } // pedaço caiu no chão e fica
      p.rot.x += p.spin * dt;
      p.rot.y += p.spin * 0.7 * dt;
    }
    const mesh = this.#particles;
    data.forEach((p, i) => {
      const fade = 1 - Math.max(0, (p.age - p.life * 0.6) / (p.life * 0.4)); // encolhe no fim da vida
      this.#dummy.position.copy(p.pos);
      this.#dummy.rotation.copy(p.rot);
      this.#dummy.scale.setScalar(p.size * fade);
      this.#dummy.updateMatrix();
      mesh.setMatrixAt(i, this.#dummy.matrix);
      mesh.setColorAt(i, this.#color.setHex(p.color));
    });
    mesh.count = data.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** Mancha irregular de tomate (algumas gotas sobrepostas) que desbota até sumir. */
  #addSplat(point, normal, scale = 1) {
    if (this.#splats.length >= MAX_SPLATS) this.#removeSplat(0);
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xb3170f, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    const blobs = 5 + ((Math.random() * 4) | 0);
    for (let i = 0; i < blobs; i++) {
      const r = i === 0 ? 0.32 + Math.random() * 0.15 : 0.06 + Math.random() * 0.14;
      const blob = new THREE.Mesh(new THREE.CircleGeometry(r, 14), mat);
      if (i > 0) {
        const a = Math.random() * Math.PI * 2, d = 0.3 + Math.random() * 0.35;
        blob.position.set(Math.cos(a) * d, Math.sin(a) * d, 0.001 * i);
      }
      group.add(blob);
    }
    group.position.copy(point);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    group.rotateZ(Math.random() * Math.PI * 2);
    group.scale.setScalar(scale);
    this.#scene.add(group);
    this.#splats.push({ group, mat, age: 0 });
  }

  #removeSplat(i) {
    const s = this.#splats[i];
    this.#scene.remove(s.group);
    s.group.children.forEach((c) => c.geometry.dispose());
    s.mat.dispose();
    this.#splats.splice(i, 1);
  }

  #updateSplats(dt) {
    for (let i = this.#splats.length - 1; i >= 0; i--) {
      const s = this.#splats[i];
      s.age += dt;
      if (s.age >= SPLAT_LIFE) { this.#removeSplat(i); continue; }
      s.mat.opacity = 0.85 * Math.min(1, (SPLAT_LIFE - s.age) / 3); // desbota nos últimos 3 s
    }
  }

  /** "Splat" curto feito na hora (ruído filtrado), mais baixo quanto mais longe. */
  #playSplatSound(point) {
    try {
      this.#audio ??= new AudioContext();
      const ctx = this.#audio;
      const listener = this.listenerPosition;
      const dist = listener ? listener.distanceTo(point) : 10;
      const vol = (this.getVolume?.() ?? 1) * Math.max(0, 1 - dist / 60) * 0.5;
      if (vol <= 0.01) return;
      const len = 0.18;
      const buf = ctx.createBuffer(1, ctx.sampleRate * len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900 + Math.random() * 500;
      const gain = ctx.createGain();
      gain.gain.value = vol;
      src.connect(filter).connect(gain).connect(ctx.destination);
      src.start();
    } catch { /* sem áudio disponível */ }
  }

  /** Visibilidade (no modo cinema nada disso aparece). */
  setVisible(v) {
    this.#particles.visible = v;
    for (const t of this.#tomatoes) t.mesh.visible = v;
    for (const s of this.#splats) s.group.visible = v;
  }
}
