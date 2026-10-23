import * as THREE from 'three';

// Bandeiras que os jogadores podem segurar. Desenhadas em canvas.
// Para adicionar uma nova: inclua aqui e o id em FLAG_IDS no server.js.
const W = 512;
const H = 320;

export const FLAGS = [
  {
    id: 'brasil',
    label: 'Brasil',
    draw(ctx) {
      ctx.fillStyle = '#009739';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fedd00';
      ctx.beginPath();
      ctx.moveTo(W / 2, 28); ctx.lineTo(W - 36, H / 2); ctx.lineTo(W / 2, H - 28); ctx.lineTo(36, H / 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#012169';
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, 82, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.arc(W / 2, H / 2 + 120, 150, Math.PI * 1.32, Math.PI * 1.68);
      ctx.stroke();
    },
  },
];

const byId = new Map(FLAGS.map((f) => [f.id, f]));
const textures = new Map();

/** Desenha a bandeira num canvas (usado na textura 3D e nas miniaturas do inventário). */
export function drawFlag(id, canvas) {
  const flag = byId.get(id);
  canvas.width = W;
  canvas.height = H;
  if (flag) flag.draw(canvas.getContext('2d'));
  return canvas;
}

/** Textura da bandeira; mirror = true é a do verso (invertida, para o texto ser legível dos dois lados). */
export function flagTexture(id, mirror = false) {
  if (!byId.has(id)) return null;
  const key = `${id}:${mirror}`;
  if (!textures.has(key)) {
    const tex = mirror ? flagTexture(id).clone() : new THREE.CanvasTexture(drawFlag(id, document.createElement('canvas')));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    if (mirror) { tex.repeat.x = -1; tex.offset.x = 1; }
    tex.needsUpdate = true;
    textures.set(key, tex);
  }
  return textures.get(key);
}
