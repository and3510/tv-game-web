import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { flagTexture } from './flags.js';

// Personagens "Mini Characters" do Kenney (CC0) — public/models/characters/LICENSE-Kenney.txt
export const CHARACTERS = {
  male: ['male-a', 'male-b', 'male-c', 'male-d', 'male-e', 'male-f'],
  female: ['female-a', 'female-b', 'female-c', 'female-d', 'female-e', 'female-f'],
};
export const ALL_CHARACTERS = [...CHARACTERS.male, ...CHARACTERS.female];
export const DEFAULT_CHARACTER = 'male-a';
export const previewUrl = (id) => `/models/characters/previews/character-${id}.png`;

const MODEL_SCALE = 2.2; // modelo original tem 0,67 de altura → ~1,5 m no jogo
// Medidas tiradas das próprias animações do modelo (unidades originais × escala)
export const SIT_OFFSET = -0.026 * MODEL_SCALE; // na animação "sit" o quadril fica 0,026 acima da raiz
export const EYE_HEIGHT = 0.48 * MODEL_SCALE;
export const EYE_HEIGHT_SIT = 0.33 * MODEL_SCALE; // sentado, o corpo desce 0,15
export const CAMERA_TARGET = 0.45 * MODEL_SCALE; // ponto que a câmera em 3ª pessoa acompanha
const NAMETAG_Y = 0.8 * MODEL_SCALE;

// Nossos estados → animações do pacote
const ANIM_MAP = { idle: 'idle', walk: 'walk', run: 'sprint', jump: 'jump', sit: 'sit' };
const TIME_SCALE = { walk: 1.15 };
const FADE = 0.15;
const ARM_R = 'arm-right'; // lanterna
const ARM_L = 'arm-left'; // bandeira
const HAND_L = new THREE.Vector3(0.24, 0, 0); // mão esquerda no espaço do osso (o braço esquerdo aponta para +X)

/** id → { scene, clips: { nome: clip }, variants: Map, holdR, holdL } */
const assets = new Map();
let loading = null;

/**
 * Carrega os 12 personagens uma vez. Para segurar a lanterna (mão direita) e a bandeira (mão esquerda),
 * cada animação ganha versões sem um ou os dois braços, que ficam por conta das poses "holding-right/left"
 * (assim dá para andar/correr/sentar segurando as coisas).
 */
export function loadCharacters() {
  loading ??= Promise.all(ALL_CHARACTERS.map(async (id) => {
    const gltf = await new GLTFLoader().loadAsync(`/models/characters/character-${id}.glb`);
    // Troca o material PBR do arquivo por Lambert (mesma textura, iluminação bem mais barata):
    // com muita gente na sala, sobra placa de vídeo para o vídeo da tela.
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const old = o.material;
      o.material = new THREE.MeshLambertMaterial({ map: old.map, color: old.color });
      old.dispose();
    });
    const byName = Object.fromEntries(gltf.animations.map((c) => [c.name, c]));
    const armOnly = (clip, arm, name) => new THREE.AnimationClip(name, clip.duration, clip.tracks.filter((t) => t.name.startsWith(`${arm}.`)));
    const clips = Object.fromEntries([...new Set(Object.values(ANIM_MAP))].map((name) => [name, byName[name]]));
    assets.set(id, {
      scene: gltf.scene,
      clips,
      variants: new Map(),
      holdR: armOnly(byName['holding-right'], ARM_R, 'lanterna'),
      holdL: armOnly(byName['holding-left'], ARM_L, 'bandeira'),
    });
  }));
  return loading;
}

/** Animação sem os braços que estão segurando algo (versões criadas uma vez e reaproveitadas). */
function variant(asset, name, noRight, noLeft) {
  const key = `${name}:${noRight}:${noLeft}`;
  if (!asset.variants.has(key)) {
    const full = asset.clips[name];
    const tracks = full.tracks.filter((t) => !(noRight && t.name.startsWith(`${ARM_R}.`)) && !(noLeft && t.name.startsWith(`${ARM_L}.`)));
    asset.variants.set(key, new THREE.AnimationClip(key, full.duration, tracks));
  }
  return asset.variants.get(key);
}

/** Bandeira num mastro: fica de pé na mão esquerda e o pano balança. Medidas em metros. */
function createFlag() {
  const group = new THREE.Group();
  group.visible = false;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.7, 8), new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.7 }));
  pole.position.y = 0.85;
  const geo = new THREE.PlaneGeometry(1.0, 0.625, 12, 4);
  geo.translate(0.5 + 0.025, 0, 0); // o pano sai do mastro para o lado esquerdo do personagem
  const base = geo.attributes.position.array.slice();
  // frente e verso com texturas próprias (o verso é espelhado para o texto não aparecer invertido)
  const cloth = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ side: THREE.FrontSide, roughness: 0.8 }));
  const back = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ side: THREE.BackSide, roughness: 0.8 }));
  cloth.position.y = back.position.y = 1.7 - 0.32;
  pole.castShadow = cloth.castShadow = true;
  group.add(pole, cloth, back);

  let t = Math.random() * 10;
  return {
    group,
    setFlag(id) {
      const tex = flagTexture(id);
      group.visible = !!tex;
      cloth.material.map = tex;
      back.material.map = tex && flagTexture(id, true);
      cloth.material.needsUpdate = back.material.needsUpdate = true;
    },
    wave(dt) {
      if (!group.visible) return;
      t += dt;
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = base[i * 3];
        const u = (x - 0.025) / 1.0; // 0 no mastro, 1 na ponta
        pos.setZ(i, Math.sin(t * 5 - u * 4) * 0.09 * u);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
    },
    dispose() {
      pole.geometry.dispose();
      geo.dispose();
      pole.material.dispose();
      cloth.material.dispose();
      back.material.dispose();
    },
  };
}

export function createCharacter({ model }, name) {
  const asset = assets.get(model) ?? assets.get(DEFAULT_CHARACTER);
  const root = new THREE.Group();
  const avatar = cloneSkinned(asset.scene);
  avatar.scale.setScalar(MODEL_SCALE);
  avatar.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    o.frustumCulled = false; // a caixa do modelo é da pose original; animado ele poderia "sumir" na borda da tela
  });
  root.add(avatar);
  const head = avatar.getObjectByName('head-mesh');

  // Lanterna presa à mão direita (coordenadas do osso, antes da escala; o braço aponta para -X do osso)
  const torch = new THREE.Group();
  torch.position.set(-0.26, 0, 0);
  torch.rotation.z = Math.PI / 2; // eixo do cilindro (Y) → direção do braço
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.021, 0.09, 12), new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.4 }));
  body.position.y = 0.045;
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.006, 12), new THREE.MeshBasicMaterial({ color: 0xfff4d6 }));
  lens.position.y = 0.092;
  body.castShadow = true;
  torch.add(body, lens);
  torch.visible = false;
  avatar.getObjectByName(ARM_R).add(torch);
  const armLeft = avatar.getObjectByName(ARM_L);
  const flag = createFlag();
  root.add(flag.group);
  let flagId = '';
  const handPos = new THREE.Vector3();
  const TORCH_TIP = new THREE.Vector3(0, 0.1, 0);

  // Animações com transição suave
  const mixer = new THREE.AnimationMixer(avatar);
  const holdR = mixer.clipAction(asset.holdR);
  const holdL = mixer.clipAction(asset.holdL);
  let current = null;
  let currentKey = '';
  let flashlight = false;

  function play(anim) {
    const clipName = ANIM_MAP[anim] ?? 'idle';
    const holdingFlag = !!flagId;
    const key = `${clipName}:${flashlight}:${holdingFlag}`;
    if (key === currentKey) return;
    currentKey = key;
    const next = mixer.clipAction(variant(asset, clipName, flashlight, holdingFlag));
    next.reset();
    next.timeScale = TIME_SCALE[clipName] ?? 1;
    const once = clipName === 'jump';
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat);
    next.clampWhenFinished = once;
    next.fadeIn(FADE).play();
    if (current && current !== next) current.fadeOut(FADE);
    current = next;
    const hold = (action, on) => {
      if (on && !action.isRunning()) action.reset().fadeIn(FADE).play();
      if (!on && action.isRunning()) action.fadeOut(FADE);
    };
    hold(holdR, flashlight);
    hold(holdL, holdingFlag);
  }

  let tag = null;
  let label = null;
  if (name) {
    tag = document.createElement('div');
    tag.className = 'nametag';
    tag.textContent = name;
    label = new CSS2DObject(tag);
    label.position.y = NAMETAG_Y;
    root.add(label);
  }

  root.userData.animate = (anim, dt) => {
    play(anim);
    mixer.update(dt);
    if (flagId) {
      // mastro de pé na mão esquerda; sentado fica menor para não tapar a tela de quem está atrás
      armLeft.updateWorldMatrix(true, false);
      root.worldToLocal(armLeft.localToWorld(handPos.copy(HAND_L)));
      flag.group.position.copy(handPos);
      flag.group.scale.setScalar(anim === 'sit' ? 0.5 : 1);
      flag.wave(dt);
    }
  };

  /** Bandeira na mão esquerda ('' = nenhuma). */
  root.userData.setFlag = (id) => {
    if (id === flagId) return;
    flagId = flagTexture(id) ? id : '';
    flag.setFlag(flagId);
    currentKey = ''; // troca para a animação sem o braço esquerdo
  };

  root.userData.setFlashlight = (on) => {
    if (on === flashlight) return;
    flashlight = on;
    torch.visible = on;
    currentKey = ''; // troca para as versões com/sem braço na próxima atualização
  };

  /** Posição (no mundo) da ponta da lanterna, de onde sai a luz. */
  root.userData.flashlightTip = (target) => {
    torch.updateWorldMatrix(true, false);
    return torch.localToWorld(target.copy(TORCH_TIP));
  };

  /** Texto da etiqueta acima da cabeça (nome + 👑 admin / 🎮 controle da TV). */
  root.userData.setTitle = (text) => { if (tag) tag.textContent = text; };

  /** Primeira pessoa: some a cabeça (a câmera fica nela) e o nome; corpo e sombra continuam. */
  root.userData.setFirstPerson = (on) => {
    head.visible = !on;
    if (label) label.visible = !on;
  };

  root.userData.dispose = () => {
    // geometria/material/texturas são compartilhados entre os clones: só solta o que é deste personagem
    mixer.stopAllAction();
    mixer.uncacheRoot(avatar);
    flag.dispose();
    body.geometry.dispose();
    lens.geometry.dispose();
    tag?.remove();
  };
  return root;
}
