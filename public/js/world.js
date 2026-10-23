import * as THREE from 'three';

// Cenário usa MeshLambertMaterial (iluminação simples, bem mais barata por pixel que o Standard/PBR):
// a prioridade é sobrar placa de vídeo para o vídeo da tela, que não depende da qualidade do 3D.
export const SEAT_TOP = 0.32; // altura do assento: o quadril dos personagens fica a ~0,39 m do chão
// Telão 16:9 de 52 m (estilo sala premium/XE); a base fica a ~2 m do chão
const SCREEN = { position: new THREE.Vector3(0, 16.6, -75), width: 52, height: 29.25 };

// Plateia em arquibancada: fileiras de cadeiras sobre degraus, com corredor central.
const ROWS = 10;
const ROW_PITCH = 2.0; // profundidade de cada degrau (cadeira + espaço para passar na frente)
const RISER = 0.7; // arquibancada íngreme: todos veem por cima das cabeças, mesmo perto da tela (sobe-se pelas escadas dos corredores)
const FIRST_ROW_Z = SCREEN.position.z + 22; // primeira fileira a ~0,42× a largura da tela, como nas salas premium: a tela passa da visão periférica
const SEATS_PER_BLOCK = 12; // plateia acompanha a largura do telão
const AISLE = 1.4;
const CHAIR_OFFSET_Z = 0.35; // cadeira no fundo do degrau; a frente fica livre para circular
// Cadeira dimensionada pelo personagem sentado (medido na animação "sit", já na escala do jogo):
// braços abertos ~1,46 m de largura e as costas ~0,38 m atrás do quadril.
const SEAT_W = 1.5; // largura de cada lugar (de braço a braço da cadeira)
const CUSHION_DEPTH = 0.8;
const CUSHION_FRONT = -0.4; // frente do assento, relativa ao quadril de quem senta (frente = -Z)
const BACKREST_Z = 0.5; // centro do encosto: face da frente em +0,44, atrás das costas do personagem
const BACKREST_H = 0.75; // cobre as costas até os ombros e fica ~0,4 m abaixo dos olhos de quem senta atrás
const ARM_H = 0.28; // braço da cadeira acima do assento
const SIDE_AISLE = 1.4;
const BLOCK_EDGE = AISLE / 2 + SEATS_PER_BLOCK * SEAT_W; // onde termina cada bloco de cadeiras
const PLATFORM_HALF_W = BLOCK_EDGE + SIDE_AISLE; // blocos de cadeiras + corredor lateral
const STAIR_DEPTH = 0.6; // escadinha de meio degrau no fim de cada fileira, só nos corredores
const CINEMA_BACK_Z = FIRST_ROW_Z + ROWS * ROW_PITCH; // fundo da arquibancada
// Área andável: só o cinema com uma folga para circular (antes era um campo de 180x180 m quase todo vazio)
const CINEMA_HALF_W = Math.max(PLATFORM_HALF_W, SCREEN.width / 2);
export const WORLD_BOUNDS = {
  minX: -(CINEMA_HALF_W + 8), maxX: CINEMA_HALF_W + 8,
  minZ: SCREEN.position.z - 6, maxZ: CINEMA_BACK_Z + 10,
};
const DECOR_BAND = 18; // faixa de árvores decorativas em volta, fora da área andável

// Mundo gerado com seed fixa: todos os clientes veem o mesmo cenário.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildWorld(scene) {
  const obstacles = []; // AABBs no plano XZ para colisão simples
  const seats = [];

  // Chão cobre a área andável + a faixa das árvores (assim a borda não fica "no vazio")
  const b = WORLD_BOUNDS;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(b.maxX - b.minX + DECOR_BAND * 2, b.maxZ - b.minZ + DECOR_BAND * 2),
    new THREE.MeshLambertMaterial({ color: 0x5f9e4f }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
  ground.receiveShadow = true;
  scene.add(ground);

  buildScenery(scene);
  const setNight = buildCinema(scene, obstacles, seats);
  return { obstacles, seats, screen: SCREEN, groundHeight, setNight };
}

/** Moldura de árvores em volta do cinema, fora da área andável (só decoração: ninguém chega nelas). */
function buildScenery(scene) {
  const rand = mulberry32(1337);
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2b });
  const leafMat = new THREE.MeshLambertMaterial({ color: 0x2f7a3a });
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 2);
  const leafGeo = new THREE.ConeGeometry(1.6, 3.5, 8);
  const b = WORLD_BOUNDS;
  const spots = [];
  for (let i = 0; i < 400 && spots.length < 45; i++) {
    const x = b.minX - DECOR_BAND + rand() * (b.maxX - b.minX + DECOR_BAND * 2);
    const z = b.minZ - DECOR_BAND + rand() * (b.maxZ - b.minZ + DECOR_BAND * 2);
    const inside = x > b.minX - 3 && x < b.maxX + 3 && z > b.minZ - 3 && z < b.maxZ + 3;
    if (!inside) spots.push([x, z, 0.8 + rand() * 0.6]);
  }
  // Uma malha instanciada por peça: 45 árvores custam 2 chamadas de desenho
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, spots.length);
  const dummy = new THREE.Object3D();
  spots.forEach(([x, z, s], i) => {
    dummy.scale.setScalar(s);
    dummy.position.set(x, 1 * s, z);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x, 3.5 * s, z);
    dummy.updateMatrix();
    leaves.setMatrixAt(i, dummy.matrix);
  });
  for (const m of [trunks, leaves]) {
    m.computeBoundingSphere();
    m.castShadow = true;
    scene.add(m);
  }
}

/** Altura do piso em (x, z): os degraus da plateia; o resto do mapa é plano. */
/**
 * Onde o jogador aparece ao entrar: no carpete entre a tela e a primeira fileira, a ~4 m das cadeiras,
 * espalhado um pouco para ninguém nascer em cima do outro. ry = 0 → virado para a plateia (+Z).
 */
export function spawnPoint() {
  return {
    x: (Math.random() - 0.5) * 10,
    z: FIRST_ROW_Z - ROW_PITCH / 2 - 4 + (Math.random() - 0.5) * 2,
    ry: 0,
  };
}

export function groundHeight(x, z) {
  const ax = Math.abs(x);
  if (ax > PLATFORM_HALF_W) return 0;
  const rel = z - (FIRST_ROW_Z - ROW_PITCH / 2);
  const row = Math.floor(rel / ROW_PITCH);
  if (row < 0 || row >= ROWS) return 0;
  // Corredores têm escada: meio degrau no fim de cada fileira. Entre as cadeiras o degrau inteiro (0,7 m)
  // é alto demais para subir andando, então se circula pelos corredores, como num cinema de verdade.
  const inAisle = ax < AISLE / 2 || ax > BLOCK_EDGE;
  if (inAisle && row < ROWS - 1 && rel - row * ROW_PITCH > ROW_PITCH - STAIR_DEPTH) return (row + 0.5) * RISER;
  // Em cima dos assentos dá para ficar de pé (sobe-se pulando: a colisão do assento barra quem só anda)
  const chairZ = FIRST_ROW_Z + row * ROW_PITCH + CHAIR_OFFSET_Z;
  if (!inAisle && z >= chairZ + CUSHION_FRONT && z < chairZ + BACKREST_Z - 0.06) return row * RISER + SEAT_TOP;
  return row * RISER;
}

/** Cria várias cópias de uma peça com uma única malha (InstancedMesh): 60 cadeiras custam poucas chamadas de desenho. */
function instanced(scene, geo, mat, transforms) {
  const mesh = new THREE.InstancedMesh(geo, mat, transforms.length);
  const dummy = new THREE.Object3D();
  transforms.forEach(([x, y, z, rx = 0], i) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(rx, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.computeBoundingSphere(); // abrange todas as cópias (senão o frustum culling some com elas)
  // As 240 cadeiras não projetam sombra (só recebem): ficam sobre a arquibancada e a sombra delas quase não
  // aparecia, mas custava desenhar todas de novo no mapa de sombra a cada quadro.
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

/** Monta o cinema e devolve setNight(t) para misturar dia (0) e noite (1). */
function buildCinema(scene, obstacles, seats) {
  const { position: p, width: w, height: h } = SCREEN;

  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.8, h + 0.8, 0.4),
    new THREE.MeshLambertMaterial({ color: 0x1a1a1f }),
  );
  frame.position.set(p.x, p.y, p.z - 0.22); // face frontal logo atrás da tela
  frame.castShadow = frame.receiveShadow = true;
  scene.add(frame);

  // "Furo" transparente no canvas WebGL: deixa aparecer o vídeo (camada CSS3D) que fica atrás dele.
  // Como escreve profundidade, jogadores que passam na frente da tela continuam visíveis.
  const hole = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    // transparent: true é obrigatório; sem ele o three.js força alpha = 1 (OPAQUE) e a tela fica preta.
    new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 0, transparent: true, blending: THREE.NoBlending, fog: false }),
  );
  hole.position.copy(p);
  // Desenhado antes de tudo que é transparente (manchas de tomate, partículas, fachos de lanterna).
  // Sem isso o three.js ordena pela distância até a câmera: como a câmera fica abaixo do centro da tela,
  // as manchas da metade de CIMA ficavam "mais longe" que o furo, eram desenhadas antes e o furo as apagava.
  hole.renderOrder = -1;
  scene.add(hole);

  const pillarH = p.y - h / 2 - 0.4;
  const pillarMat = new THREE.MeshLambertMaterial({ color: 0x2a2a30 });
  for (const sx of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.7, pillarH, 0.7), pillarMat);
    pillar.position.set(p.x + sx * w * 0.35, pillarH / 2, p.z - 0.22);
    pillar.castShadow = true;
    scene.add(pillar);
  }
  obstacles.push({ minX: p.x - w / 2 - 0.4, maxX: p.x + w / 2 + 0.4, minZ: p.z - 0.6, maxZ: p.z });

  // Piso acarpetado entre a tela e a plateia
  const carpet = new THREE.Mesh(
    new THREE.PlaneGeometry(PLATFORM_HALF_W * 2 + 6, FIRST_ROW_Z - p.z + ROWS * ROW_PITCH),
    new THREE.MeshLambertMaterial({ color: 0x4a1820 }),
  );
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.set(p.x, 0.01, (p.z + FIRST_ROW_Z + ROWS * ROW_PITCH) / 2);
  carpet.receiveShadow = true;
  scene.add(carpet);

  // Degraus da arquibancada + faixa de luz na quina de cada um (acende à noite)
  const riserMat = new THREE.MeshLambertMaterial({ color: 0x3a1418 });
  const stepLightMat = new THREE.MeshLambertMaterial({ color: 0x331a00, emissive: 0xffa040, emissiveIntensity: 0.3 });
  for (let row = 0; row < ROWS; row++) {
    const rowZ = FIRST_ROW_Z + row * ROW_PITCH;
    const height = row * RISER;
    if (height > 0) {
      const riser = new THREE.Mesh(new THREE.BoxGeometry(PLATFORM_HALF_W * 2, height, ROW_PITCH), riserMat);
      riser.position.set(0, height / 2, rowZ);
      riser.castShadow = riser.receiveShadow = true;
      scene.add(riser);
    }
    const strip = new THREE.Mesh(new THREE.BoxGeometry(PLATFORM_HALF_W * 2, 0.04, 0.05), stepLightMat);
    strip.position.set(0, height + 0.02, rowZ - ROW_PITCH / 2 + 0.03);
    scene.add(strip);

    // Escadinhas (meio degrau) nos corredores central e laterais, no fim da fileira
    if (row < ROWS - 1) {
      const stairH = (row + 0.5) * RISER;
      const stairZ = rowZ + ROW_PITCH / 2 - STAIR_DEPTH / 2;
      for (const [x, w] of [[0, AISLE], [-(BLOCK_EDGE + SIDE_AISLE / 2), SIDE_AISLE], [BLOCK_EDGE + SIDE_AISLE / 2, SIDE_AISLE]]) {
        const stair = new THREE.Mesh(new THREE.BoxGeometry(w, stairH, STAIR_DEPTH), riserMat);
        stair.position.set(x, stairH / 2, stairZ);
        stair.castShadow = stair.receiveShadow = true;
        const edge = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, 0.05), stepLightMat);
        edge.position.set(x, stairH + 0.02, stairZ - STAIR_DEPTH / 2 + 0.03);
        scene.add(stair, edge);
      }
    }
  }

  // Cadeiras de cinema (estofado vermelho, encosto inclinado, braços compartilhados)
  const cushions = [], backs = [], bases = [], arms = [], armPosts = [];
  for (let row = 0; row < ROWS; row++) {
    const floor = row * RISER;
    const z = FIRST_ROW_Z + row * ROW_PITCH + CHAIR_OFFSET_Z;
    for (const side of [-1, 1]) {
      const inner = AISLE / 2;
      for (let k = 0; k < SEATS_PER_BLOCK; k++) {
        const x = side * (inner + SEAT_W / 2 + k * SEAT_W);
        const cushionZ = z + CUSHION_FRONT + CUSHION_DEPTH / 2;
        cushions.push([x, floor + SEAT_TOP - 0.06, cushionZ]);
        backs.push([x, floor + SEAT_TOP + BACKREST_H / 2, z + BACKREST_Z, 0.1]); // encosto levemente inclinado
        bases.push([x, floor + (SEAT_TOP - 0.12) / 2, cushionZ]);
        seats.push({ x, z, ry: Math.PI, floor }); // quadril de quem senta; virado para a tela (-Z)
      }
      for (let k = 0; k <= SEATS_PER_BLOCK; k++) {
        const x = side * (inner + k * SEAT_W);
        arms.push([x, floor + SEAT_TOP + ARM_H, z + 0.05]);
        armPosts.push([x, floor + (SEAT_TOP + ARM_H) / 2, z + 0.2]);
      }
      // Colisão com altura (maxY): andando, a fileira é uma barreira; pulando dá para subir no assento
      // e passar por cima do encosto para a fileira de trás (ou da frente).
      const minX = Math.min(side * inner, side * (inner + SEATS_PER_BLOCK * SEAT_W)) - 0.05;
      const maxX = minX + SEATS_PER_BLOCK * SEAT_W + 0.1;
      obstacles.push(
        { minX, maxX, minZ: z + CUSHION_FRONT, maxZ: z + BACKREST_Z - 0.06, maxY: floor + SEAT_TOP }, // assento
        { minX, maxX, minZ: z + BACKREST_Z - 0.06, maxZ: z + BACKREST_Z + 0.1, maxY: floor + SEAT_TOP + BACKREST_H }, // encosto
      );
    }
  }
  const red = new THREE.MeshLambertMaterial({ color: 0x9e1b24 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x1c1c22 });
  instanced(scene, new THREE.BoxGeometry(SEAT_W - 0.12, 0.12, CUSHION_DEPTH), red, cushions);
  instanced(scene, new THREE.BoxGeometry(SEAT_W - 0.12, BACKREST_H, 0.12), red, backs);
  instanced(scene, new THREE.BoxGeometry(0.24, SEAT_TOP - 0.12, 0.45), dark, bases);
  instanced(scene, new THREE.BoxGeometry(0.1, 0.07, 0.8), dark, arms);
  instanced(scene, new THREE.BoxGeometry(0.07, SEAT_TOP + ARM_H, 0.1), dark, armPosts);

  return (t) => {
    stepLightMat.emissiveIntensity = 0.3 + t * 2.7;
  };
}
