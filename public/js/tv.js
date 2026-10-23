import { CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

// Full HD: o elemento é escalado pelo CSS3D, então resolução maior evita borrão no modo cinema.
const PX_W = 1920;
const PX_H = 1080;
const YT_ERRORS = {
  2: 'Link do YouTube inválido.',
  5: 'O YouTube não conseguiu reproduzir esse vídeo.',
  100: 'Vídeo não encontrado ou privado.',
  101: 'O dono do vídeo não permite reprodução fora do YouTube.',
  150: 'O dono do vídeo não permite reprodução fora do YouTube.',
};

let ytApi;
function loadYouTubeAPI() {
  ytApi ??= new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.append(s);
  });
  return ytApi;
}

// Adaptadores: mesma interface para o player do YouTube e para <video>.
function youtubeAdapter(player) {
  return {
    ready: false,
    time: () => player.getCurrentTime?.() ?? 0,
    playing: () => [1, 3].includes(player.getPlayerState?.()), // tocando ou carregando
    buffering: () => [-1, 3].includes(player.getPlayerState?.()), // ainda não começou ou baixando
    ended: () => player.getPlayerState?.() === 0,
    play: () => player.playVideo(),
    pause: () => player.pauseVideo(),
    seek: (t) => player.seekTo(t, true),
    setVolume: (v) => player.setVolume?.(v),
    muted: () => player.isMuted(),
    mute: () => player.mute(),
    unmute: () => player.unMute(),
    duration: () => player.getDuration?.() ?? 0,
    // Legendas do YouTube: prefere português; senão a primeira faixa disponível no vídeo.
    // stillWanted(): as ações atrasadas só rodam se o jogador não mudou de ideia nesse meio-tempo.
    setCaptions: (on, stillWanted = () => true) => {
      try {
        if (!on) {
          // alguns vídeos já vêm com legenda ligada pelo YouTube: limpa a faixa e descarrega os dois nomes do módulo
          const off = () => {
            try { player.setOption('captions', 'track', {}); } catch { /* módulo não carregado */ }
            player.unloadModule('captions');
            player.unloadModule('cc');
          };
          off();
          setTimeout(() => { if (stillWanted()) off(); }, 2000); // o YouTube pode religar logo depois de começar a tocar
          return;
        }
        player.loadModule('captions');
        // a lista de faixas só aparece depois que o módulo carrega: tenta por até ~6 s
        let tries = 0;
        const pick = () => {
          if (!stillWanted()) return;
          const list = player.getOption('captions', 'tracklist') ?? [];
          if (!list.length && ++tries < 20) { setTimeout(pick, 300); return; }
          const track = list.find((t) => t.languageCode?.startsWith('pt')) ?? list[0];
          if (track) player.setOption('captions', 'track', { languageCode: track.languageCode });
        };
        setTimeout(pick, 300);
      } catch { /* player ainda não pronto */ }
    },
    destroy: () => { try { player.destroy(); } catch { /* já destruído */ } },
  };
}

function videoAdapter(video) {
  return {
    // Só mexe no vídeo depois dos metadados: seek antes disso reinicia o download e atrasa o início.
    get ready() { return video.readyState >= 1; },
    time: () => video.currentTime,
    playing: () => !video.paused,
    buffering: () => video.readyState < 3, // sem dados para seguir tocando
    ended: () => video.ended,
    play: () => video.play().catch(() => {}),
    pause: () => video.pause(),
    seek: (t) => { video.currentTime = t; },
    setVolume: (v) => { video.volume = v / 100; },
    muted: () => video.muted,
    mute: () => { video.muted = true; },
    unmute: () => { video.muted = false; },
    duration: () => (Number.isFinite(video.duration) ? video.duration : 0),
    setCaptions: () => {}, // arquivos .mp4 não trazem legendas
    destroy: () => { video.pause(); video.removeAttribute('src'); video.load(); },
  };
}

// Correção de deriva: em rede lenta o vídeo fica atrás do tempo da sala enquanto baixa. Pular
// para frente nessa hora recomeça o download (e o YouTube baixa a qualidade a cada travada), o
// que vira um ciclo: nunca engrena. Então só corrige com o vídeo já tocando, com folga e espaçado.
const DRIFT_TOLERANCE = 2; // s de diferença aceitos entre jogadores
const SEEK_COOLDOWN_MS = 6000; // tempo para o vídeo voltar a tocar depois de um pulo

const sameMedia = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Telão: o vídeo é um elemento HTML posicionado em 3D (CSS3DRenderer) atrás do canvas WebGL.
 * O estado (mídia, play/pause, tempo) vem do servidor; cada cliente corrige a deriva sozinho.
 */
export class TV {
  state = { media: null, playing: false, time: 0 };
  #receivedAt = performance.now();
  #lastSeekAt = 0;
  #adapter = null;
  #token = 0;
  #volume = -1;
  #blockTimer = 0;
  #cinema = null; // estilos do CSS3D salvos enquanto o modo cinema está ativo
  #live = null; // <video> da transmissão de tela, sobreposto ao conteúdo normal
  #liveLocal = false;
  #userVolume = 100; // volume pessoal (0–100), multiplica o volume pela distância
  #captions = false; // legendas do YouTube ligadas (preferência local)
  #distanceFactor = 1; // último fator de volume pela distância (0–1)

  constructor(cssScene, screen, { onMuted, onError }) {
    this.onMuted = onMuted;
    this.onError = onError;
    this.el = document.createElement('div');
    this.el.className = 'tv-screen';
    Object.assign(this.el.style, { width: `${PX_W}px`, height: `${PX_H}px` });
    // Conteúdo sincronizado (YouTube/vídeo/aviso) fica num contêiner próprio, para a camada ao vivo sobreviver às trocas.
    this.content = document.createElement('div');
    this.content.className = 'tv-content';
    this.el.append(this.content);
    this.#showPlaceholder();

    const obj = new CSS3DObject(this.el);
    obj.position.copy(screen.position);
    obj.scale.setScalar(screen.width / PX_W);
    cssScene.add(obj);
    this.el.style.pointerEvents = 'none'; // cliques no player do YouTube dessincronizariam a sala

    setInterval(() => this.#sync(false), 1000);
  }

  /** Onde o vídeo deveria estar agora, segundo o último estado recebido. */
  expectedTime() {
    const elapsed = this.state.playing ? (performance.now() - this.#receivedAt) / 1000 : 0;
    return this.state.time + elapsed;
  }

  applyState(state) {
    const changed = !sameMedia(this.state.media, state.media);
    this.state = { media: state.media, playing: state.playing, time: state.time };
    this.#receivedAt = performance.now();
    if (changed) this.#load(state.media);
    else this.#sync(true);
  }

  get isYouTube() { return this.state.media?.kind === 'youtube'; }
  get isLive() { return !!this.#live; }

  /** Duração do vídeo atual em segundos (0 enquanto não carregou). */
  duration() {
    return this.#adapter?.ready ? this.#adapter.duration() : 0;
  }

  /** Volume só deste jogador (não afeta os outros). */
  setUserVolume(v) {
    this.#userVolume = v;
    this.#applyVolume(true); // aplica na hora (mudo tem que ser imediato)
  }

  /** Legendas só deste jogador; valem para vídeos do YouTube. */
  setCaptions(on) {
    this.#captions = on;
    if (this.#adapter?.ready) this.#adapter.setCaptions(on, () => this.#captions === on);
  }

  unmute() {
    if (this.#live && !this.#liveLocal) this.#live.muted = false;
    this.#adapter?.unmute();
  }

  /** Transmissão ao vivo por cima do telão; o vídeo sincronizado fica pausado por baixo até ela acabar. */
  showStream(stream, { local }) {
    if (!this.#live) {
      this.#live = document.createElement('video');
      this.#live.className = 'tv-live';
      this.#live.playsInline = true;
      this.el.append(this.#live);
    }
    const v = this.#live;
    this.#liveLocal = local;
    if (v.srcObject !== stream) v.srcObject = stream;
    v.muted = local; // quem transmite já ouve a própria aba
    v.play().catch(() => {
      v.muted = true;
      v.play().catch(() => {});
      if (!local) this.onMuted();
    });
    if (this.#adapter?.ready && this.#adapter.playing()) this.#adapter.pause();
  }

  hideStream() {
    if (!this.#live) return;
    this.#live.srcObject = null;
    this.#live.remove();
    this.#live = null;
    this.#sync(true); // retoma o vídeo da sala no ponto em que ele deveria estar
  }

  /**
   * Modo cinema: o elemento do vídeo sai da perspectiva 3D e vira uma camada 2D cobrindo a janela.
   * Só os estilos mudam (o elemento não sai do lugar no DOM), então o iframe do YouTube não recarrega.
   * Enquanto ativo, o CSS3DRenderer não deve renderizar.
   */
  enterCinema(fill) {
    const cameraEl = this.el.parentElement; // elemento "câmera" do CSS3DRenderer (perspectiva + matriz da câmera)
    this.#cinema ??= { cameraEl, cam: cameraEl.style.transform, el: this.el.style.transform };
    cameraEl.style.transform = 'none';
    this.layoutCinema(fill);
  }

  /** fill = true cobre a janela inteira (corta as bordas); false mostra o vídeo inteiro. */
  layoutCinema(fill) {
    const scale = (fill ? Math.max : Math.min)(innerWidth / PX_W, innerHeight / PX_H);
    this.el.style.transform = `translate(-50%, -50%) translate(${innerWidth / 2}px, ${innerHeight / 2}px) scale(${scale})`;
  }

  exitCinema() {
    if (!this.#cinema) return;
    // Restaura exatamente o último estilo do CSS3DRenderer (ele só reescreve quando a câmera muda).
    this.#cinema.cameraEl.style.transform = this.#cinema.cam;
    this.el.style.transform = this.#cinema.el;
    this.#cinema = null;
  }

  /** Volume cai com a distância até a tela. */
  updateVolume(distance) {
    this.#distanceFactor = Math.min(1, Math.max(0, 1 - (distance - 55) / 50)); // cheio até o fundo da plateia (~52 m)
    this.#applyVolume(false);
  }

  #applyVolume(force) {
    const v = Math.round(this.#distanceFactor * this.#userVolume);
    if (this.#live) this.#live.volume = v / 100;
    if (this.#adapter?.ready && (force || Math.abs(v - this.#volume) >= 2)) {
      this.#volume = v;
      this.#adapter.setVolume(v);
    }
  }

  #showPlaceholder() {
    this.content.innerHTML = '<div class="tv-idle">📺<br>Pressione <b>T</b> para colocar um vídeo</div>';
  }

  async #load(media) {
    const token = ++this.#token;
    this.#adapter?.destroy();
    this.#adapter = null;
    this.#volume = -1;
    this.content.replaceChildren();
    if (!media) return this.#showPlaceholder();

    if (media.kind === 'youtube') {
      const YT = await loadYouTubeAPI();
      if (token !== this.#token) return;
      const target = document.createElement('div');
      this.content.append(target);
      const player = new YT.Player(target, {
        width: PX_W,
        height: PX_H,
        videoId: media.id,
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0 },
        events: {
          onReady: () => {
            if (token !== this.#token) return;
            adapter.ready = true;
            this.#sync(true);
          },
          // legendas só podem ser ligadas depois que o vídeo começa a tocar
          onStateChange: (e) => {
            if (e.data === 1 && !captionsApplied && token === this.#token) { captionsApplied = true; const on = this.#captions; adapter.setCaptions(on, () => this.#captions === on); }
          },
          onError: (e) => this.onError(YT_ERRORS[e.data] ?? 'Erro ao carregar o vídeo do YouTube.'),
        },
      });
      const adapter = youtubeAdapter(player);
      let captionsApplied = false;
      this.#adapter = adapter;
    } else {
      const video = document.createElement('video');
      video.src = media.url;
      video.playsInline = true;
      video.preload = 'auto';
      video.onerror = () => this.onError('Não foi possível carregar o vídeo.');
      const loading = document.createElement('div');
      loading.className = 'tv-loading';
      loading.textContent = 'Carregando…';
      const setLoading = (on) => () => loading.classList.toggle('show', on);
      video.addEventListener('loadstart', setLoading(true));
      video.addEventListener('waiting', setLoading(true));
      video.addEventListener('playing', setLoading(false));
      video.addEventListener('pause', setLoading(false));
      video.addEventListener('error', setLoading(false));
      this.content.append(video, loading);
      this.#adapter = videoAdapter(video);
      video.addEventListener('loadedmetadata', () => this.#sync(true), { once: true });
      this.#sync(true);
    }
  }

  #sync(force) {
    const a = this.#adapter;
    if (!a?.ready) return;
    if (this.#live) { // durante a transmissão o vídeo da sala espera pausado
      if (a.playing()) a.pause();
      return;
    }
    const want = this.expectedTime();
    // force = comando da sala (carregar, play, pause, pular): obedece na hora.
    const settled = !a.buffering() && performance.now() - this.#lastSeekAt > SEEK_COOLDOWN_MS;
    const seeked = force ? Math.abs(a.time() - want) > 0.5 : settled && Math.abs(a.time() - want) > DRIFT_TOLERANCE;
    if (seeked) {
      a.seek(want);
      this.#lastSeekAt = performance.now();
    }
    if (!seeked && a.ended()) return; // não reinicia o vídeo quando ele acaba

    if (this.state.playing && !a.playing()) {
      a.play();
      // Navegadores bloqueiam autoplay com som: se não começou, toca mudo e oferece botão para ativar.
      clearTimeout(this.#blockTimer);
      this.#blockTimer = setTimeout(() => {
        if (this.state.playing && !a.playing() && !a.muted()) {
          a.mute();
          a.play();
          this.onMuted();
        }
      }, 2500);
    } else if (!this.state.playing && a.playing()) {
      a.pause();
    }
  }
}
