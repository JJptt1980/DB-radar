// 雷達縮放按鈕的音效：用 Web Audio 現場合成（喀一聲＋三聲嗶），沒有任何音檔。
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** 按下去的「喀」：很短的高頻雜訊 */
function click(a: AudioContext, t: number) {
  const len = Math.round(a.sampleRate * 0.025);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const src = a.createBufferSource();
  src.buffer = buf;
  const hp = a.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1800;
  const g = a.createGain();
  g.gain.value = 0.9;
  src.connect(hp).connect(g).connect(a.destination);
  src.start(t);
}

function beep(a: AudioContext, t: number, freq: number, dur = 0.07) {
  const o = a.createOscillator();
  o.type = 'square';
  o.frequency.value = freq;
  const lp = a.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3500;
  const g = a.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.12, t + 0.005);
  g.gain.setValueAtTime(0.12, t + dur - 0.01);
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(lp).connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.01);
}

/** 靠近目標：越近嗶越多、越快、越高（band 1～3） */
export function playNear(band: number): void {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + 0.01;
  const n = [0, 2, 3, 5][band] ?? 2;
  const gap = [0, 0.22, 0.16, 0.1][band] ?? 0.2;
  const freq = 1900 + band * 250;
  for (let i = 0; i < n; i++) beep(a, t + i * gap, freq, 0.06);
}

/** stage：放大後是第幾段（0 = 回到全範圍）。段數越高，嗶聲越高 */
export function playZoom(stage: number): void {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + 0.01;
  click(a, t);
  const base = stage === 0 ? 1500 : 1700 + stage * 300;
  for (let i = 0; i < 3; i++) beep(a, t + 0.14 + i * 0.13, base);
}
