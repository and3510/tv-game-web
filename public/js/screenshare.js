/**
 * Transmissão de tela/aba para o telão via SFU (LiveKit).
 * Quem transmite publica a tela UMA vez; o LiveKit repassa para cada espectador. Antes (conexão direta com
 * cada um) o upload de quem transmitia era multiplicado pelo número de espectadores.
 * O servidor do jogo decide quem pode transmitir (screen:start) e entrega o token de acesso (screen:token).
 */
export const QUALITY = {
  normal: { label: 'Normal · 720p', width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  alta: { label: 'Alta · 1080p', width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 },
  maxima: { label: 'Máxima · 1080p 60fps', width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 },
};
const AUDIO_BITRATE = 128_000; // Opus estéreo com qualidade de música (o padrão do WebRTC é voz, ~32 kbps mono)
const JITTER_BUFFER_MS = 800; // espectador segura ~0,8 s de buffer: absorve oscilações da internet sem travar (num filme ninguém nota)
// No Linux (Wayland/PipeWire), pedir o áudio do sistema ao compartilhar a tela inteira pode derrubar o Chrome
// inteiro (as ligações de áudio do PipeWire falham e o processo principal trava). O áudio de aba não é afetado.
const IS_LINUX = /linux/i.test(navigator.userAgentData?.platform ?? navigator.platform) && !/android/i.test(navigator.userAgent);

/**
 * Codec mais leve para o computador de quem transmite: com aceleração de hardware a codificação quase não
 * usa o processador. Sem hardware, VP9 com 3 camadas pesa demais e o vídeo trava; VP8 é bem mais leve.
 * - VP9 com hardware: SVC (o LiveKit escolhe a camada de cada espectador), melhor qualidade por bit;
 * - H.264 com hardware (a maioria dos PCs com Intel/NVIDIA/AMD e Macs): simulcast 1080p + 540p;
 * - sem hardware: VP8, simulcast 1080p + 540p.
 */
async function pickCodec(q) {
  const info = (codec) => navigator.mediaCapabilities?.encodingInfo({
    type: 'webrtc', video: { contentType: `video/${codec}`, width: q.width, height: q.height, bitrate: q.bitrate, framerate: q.fps },
  }).catch(() => null);
  const [vp9, h264] = await Promise.all([info('VP9'), info('H264')]);
  if (vp9?.powerEfficient) return 'vp9';
  if (h264?.powerEfficient) return 'h264';
  return 'vp8';
}

// O SDK (~1,4 MB) só é baixado na primeira transmissão: não pesa na entrada no jogo.
let sdk = null;
const loadSdk = () => (sdk ??= import('/vendor/livekit/livekit-client.esm.mjs'));

export class ScreenShare {
  broadcaster = null; // { id, by } de quem está transmitindo na sala
  #socket;
  #tv;
  #notify;
  #quality;
  #local = null; // MediaStream que eu estou transmitindo
  #room = null; // conexão com o LiveKit (transmissor ou espectador)
  #published = []; // LocalTracks publicadas (só o transmissor)
  #session = 0; // invalida conexões antigas quando a transmissão acaba no meio do caminho
  #statsTimer = 0;
  #lastBytes = null;

  constructor(socket, tv, { onChange, onStats, toast, quality = 'alta' }) {
    this.#socket = socket;
    this.#tv = tv;
    this.#notify = { onChange, onStats, toast };
    this.#quality = QUALITY[quality] ? quality : 'alta';
    socket.on('screen:started', (s) => this.#onStarted(s));
    socket.on('screen:stopped', () => {
      if (this.#local) { // o servidor encerrou: quem transmitia perdeu o controle da TV
        this.#stopLocal();
        this.#notify.toast('Sua transmissão foi encerrada porque o controle da TV mudou de mão.');
      }
      this.#reset();
    });
  }

  get sharing() { return !!this.#local; }
  get live() { return !!this.broadcaster; }
  get quality() { return this.#quality; }

  /** Ao entrar na sala: entra numa transmissão que já esteja em andamento. */
  init(screen) {
    if (screen) this.#onStarted(screen);
  }

  /** Troca a qualidade; durante a transmissão republica o vídeo (meio segundo de pausa para quem assiste). */
  async setQuality(key) {
    if (!QUALITY[key]) return;
    this.#quality = key;
    if (!this.#local || !this.#room) return;
    const q = QUALITY[key];
    const [video] = this.#local.getVideoTracks();
    await video?.applyConstraints({ width: { max: q.width }, height: { max: q.height }, frameRate: { max: q.fps } }).catch(() => {});
    const old = this.#published.find((t) => t.kind === 'video');
    if (!old) return;
    await this.#room.localParticipant.unpublishTrack(old, false);
    this.#published = this.#published.filter((t) => t !== old);
    await this.#publishVideo(video);
  }

  async start() {
    if (!window.isSecureContext) {
      throw new Error(`Para transmitir, abra o jogo pelo endereço seguro: https://${location.hostname}`);
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Este navegador não permite transmitir a tela. Use Chrome, Edge ou Firefox no computador.');
    }
    const q = QUALITY[this.#quality];
    const [stream] = await Promise.all([
      navigator.mediaDevices.getDisplayMedia({
        // max (e não ideal): reduz abas maiores que o limite, sem ampliar as menores
        video: { width: { max: q.width }, height: { max: q.height }, frameRate: { ideal: q.fps, max: q.fps } },
        // Som do filme sem os filtros de voz do navegador (eles abafam música e efeitos)
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
        selfBrowserSurface: 'exclude', // não oferecer a própria aba do jogo
        surfaceSwitching: 'include',
        systemAudio: IS_LINUX ? 'exclude' : 'include',
      }),
      loadSdk(), // baixa enquanto a pessoa escolhe a aba
    ]);
    const res = await this.#socket.emitWithAck('screen:start');
    if (!res.ok) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(res.error);
    }
    const [video] = stream.getVideoTracks();
    video.contentHint = 'motion'; // prioriza fluidez (filme), não nitidez de texto
    video.addEventListener('ended', () => this.stop()); // botão "Parar compartilhamento" do navegador
    this.#local = stream;
    this.broadcaster = { id: this.#socket.id, by: 'Você' };
    this.#tv.showStream(stream, { local: true });
    this.#notify.onChange();

    try {
      const room = await this.#connect();
      if (!room) return; // parou antes de conectar
      const { Track, AudioPresets } = await loadSdk();
      await this.#publishVideo(video);
      const [audio] = stream.getAudioTracks();
      if (audio) {
        const pub = await room.localParticipant.publishTrack(audio, {
          source: Track.Source.ScreenShareAudio, name: 'som', stream: 'tela', dtx: false, red: false, forceStereo: true,
          audioPreset: { ...AudioPresets.musicHighQualityStereo, maxBitrate: AUDIO_BITRATE },
        });
        this.#published.push(pub.track);
      }
    } catch (err) {
      this.stop();
      throw new Error(`Não foi possível conectar ao servidor de transmissão: ${err.message ?? err}`);
    }
    this.#statsTimer = setInterval(() => this.#reportStats(), 2000);
    if (!stream.getAudioTracks().length) {
      const surface = video.getSettings().displaySurface; // 'browser' (aba) | 'window' | 'monitor'
      this.#notify.toast(surface === 'browser'
        ? 'Transmitindo sem som: marque "Compartilhar áudio da guia" na próxima vez.'
        : 'Tela/janela vai sem som. Para transmitir com som, escolha uma aba e marque "Compartilhar áudio da guia".');
    }
  }

  stop() {
    if (!this.#local) return;
    this.#stopLocal();
    this.#socket.emit('screen:stop');
    this.#reset();
  }

  /**
   * Publica o vídeo com camadas: o LiveKit entrega a cada espectador a que a internet dele aguenta
   * (1080p para quem tem banda, 540p para quem não tem), sem quem transmite enviar uma cópia por pessoa.
   */
  async #publishVideo(video) {
    const { Track, VideoPreset } = await loadSdk();
    const q = QUALITY[this.#quality];
    const codec = await pickCodec(q);
    const layers = codec === 'vp9' ? {} : { // VP9 já faz camadas sozinho (SVC)
      simulcast: true,
      screenShareSimulcastLayers: [new VideoPreset(960, 540, Math.min(1_200_000, q.bitrate / 2), Math.min(q.fps, 30))],
    };
    const pub = await this.#room.localParticipant.publishTrack(video, {
      source: Track.Source.ScreenShare, name: 'tela', stream: 'tela', videoCodec: codec,
      backupCodec: codec === 'vp9', // navegador sem VP9 (Safari antigo) recebe uma cópia VP8
      screenShareEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps, priority: 'high' },
      degradationPreference: 'maintain-framerate', // filme: melhor perder resolução do que travar
      ...layers,
    });
    this.#published.push(pub.track);
  }

  #stopLocal() {
    this.#local.getTracks().forEach((t) => t.stop());
    this.#local = null;
    this.#published = [];
    clearInterval(this.#statsTimer);
    this.#lastBytes = null;
  }

  /** Entra na sala do LiveKit com o token do servidor (publicar ou só assistir, o servidor decide). */
  async #connect() {
    const session = ++this.#session;
    const [{ Room, RoomEvent, Track }, res] = await Promise.all([
      loadSdk(),
      this.#socket.timeout(8000).emitWithAck('screen:token').catch(() => ({ ok: false, error: 'servidor não respondeu' })),
    ]);
    if (session !== this.#session) return null;
    if (!res.ok) throw new Error(res.error);
    const room = new Room({ adaptiveStream: false, dynacast: true });
    if (!this.#local) {
      // Espectador: só aceita mídia de quem o jogo diz que está transmitindo.
      room.on(RoomEvent.TrackSubscribed, (_track, _pub, participant) => {
        if (participant.identity === this.broadcaster?.id) this.#showRemote(participant, Track);
      });
      room.on(RoomEvent.TrackUnsubscribed, (_track, _pub, participant) => {
        if (participant.identity === this.broadcaster?.id) this.#showRemote(participant, Track);
      });
    }
    room.on(RoomEvent.Disconnected, () => { if (this.#room === room) this.#room = null; });
    const url = res.url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/livekit`;
    this.#room = room;
    await room.connect(url, res.token, { autoSubscribe: true });
    if (session !== this.#session) { room.disconnect(); return null; }
    return room;
  }

  /** Junta vídeo e som do transmissor num MediaStream para o telão. */
  #showRemote(participant, Track) {
    const tracks = [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]
      .map((src) => participant.getTrackPublication(src)?.track)
      .filter((t) => t?.mediaStreamTrack);
    if (!tracks.some((t) => t.kind === 'video')) return;
    for (const t of tracks) {
      const receiver = t.receiver;
      if (receiver && 'jitterBufferTarget' in receiver) receiver.jitterBufferTarget = JITTER_BUFFER_MS;
    }
    this.#tv.showStream(new MediaStream(tracks.map((t) => t.mediaStreamTrack)), { local: false });
  }

  /** Resolução/fps/bitrate realmente enviados ao LiveKit e o que está limitando, se algo. */
  async #reportStats() {
    const video = this.#published.find((t) => t.kind === 'video');
    const stats = await video?.sender?.getStats().catch(() => null);
    if (!stats) { this.#notify.onStats(null); return; }
    let out = null;
    let bytes = 0;
    stats.forEach((r) => {
      if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
      bytes += r.bytesSent;
      if (!out || (r.frameHeight ?? 0) > (out.frameHeight ?? 0)) out = r; // camada mais alta
    });
    if (!out) return;
    const now = out.timestamp;
    const mbps = this.#lastBytes ? ((bytes - this.#lastBytes.bytes) * 8) / ((now - this.#lastBytes.at) * 1000) : 0;
    this.#lastBytes = { bytes, at: now };
    const codec = stats.get(out.codecId)?.mimeType?.split('/')[1];
    this.#notify.onStats({
      height: out.frameHeight, fps: Math.round(out.framesPerSecond ?? 0), mbps,
      codec, viewers: this.#room?.remoteParticipants.size ?? 0, limit: out.qualityLimitationReason, // 'none' | 'bandwidth' | 'cpu'
    });
  }

  #reset() {
    this.#session++;
    this.#room?.disconnect();
    this.#room = null;
    this.broadcaster = null;
    this.#tv.hideStream();
    this.#notify.onChange();
  }

  async #onStarted(s) {
    this.broadcaster = s;
    this.#notify.onChange();
    this.#notify.toast(`📡 ${s.by} começou a transmitir`);
    try {
      await this.#connect();
    } catch (err) {
      console.warn('[livekit]', err);
      if (this.broadcaster === s) this.#notify.toast(`Não foi possível receber a transmissão: ${err.message ?? err}`);
    }
  }
}
