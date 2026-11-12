// Notification sounds made in code (no audio files, so no outside licences).
// A note: f = frequency (Hz), s = start (s), d = length (s), k = kind, v = loudness (0-1).
// Kinds: bell (metal bell, many overtones), glass (clear, high), marimba (wooden, short), pluck (string),
// organ (soft steady), drop (a falling "water drop"), sine (plain).
const N = (f, s, d, k = 'bell', v = 1) => ({ f, s, d, k, v });

export const SOUNDS = {
  ding:    { label: 'דינג',          notes: [N(880, 0, 0.9, 'bell')] },
  bell:    { label: 'פעמון',         notes: [N(1047, 0, 0.9, 'bell'), N(1319, 0.14, 1.1, 'bell')] },
  chime:   { label: 'צלצול עולה',    notes: [N(784, 0, 0.8, 'bell', 0.8), N(988, 0.13, 0.8, 'bell', 0.9), N(1319, 0.26, 1.2, 'bell')] },
  glass:   { label: 'זכוכית',        notes: [N(1568, 0, 0.7, 'glass'), N(2093, 0.1, 0.9, 'glass', 0.8)] },
  marimba: { label: 'מרימבה',        notes: [N(523, 0, 0.35, 'marimba'), N(659, 0.1, 0.35, 'marimba'), N(784, 0.2, 0.5, 'marimba')] },
  harp:    { label: 'נבל',           notes: [N(392, 0, 0.9, 'pluck'), N(523, 0.09, 0.9, 'pluck'), N(659, 0.18, 0.9, 'pluck'), N(784, 0.27, 1.2, 'pluck')] },
  drop:    { label: 'טיפת מים',      notes: [N(900, 0, 0.25, 'drop')] },
  bubble:  { label: 'בועה',          notes: [N(500, 0, 0.18, 'drop', 0.9), N(750, 0.12, 0.2, 'drop', 0.8)] },
  pop:     { label: 'פופ',           notes: [N(520, 0, 0.12, 'marimba'), N(360, 0.07, 0.14, 'marimba', 0.8)] },
  soft:    { label: 'עדין',          notes: [N(440, 0, 0.5, 'organ', 0.8), N(660, 0.18, 0.7, 'organ', 0.8)] },
  news:    { label: 'חדשות',         notes: [N(659, 0, 0.18, 'organ'), N(659, 0.2, 0.18, 'organ'), N(880, 0.4, 0.6, 'organ')] },
  sparkle: { label: 'נצנוץ',         notes: [N(1319, 0, 0.5, 'glass', 0.7), N(1568, 0.07, 0.5, 'glass', 0.7), N(1976, 0.14, 0.5, 'glass', 0.7), N(2637, 0.21, 0.9, 'glass', 0.8)] },
  gong:    { label: 'גונג עמוק',     notes: [N(196, 0, 2.2, 'bell'), N(294, 0.02, 1.6, 'bell', 0.5)] },
  piano:   { label: 'מקלדת',         notes: [N(659, 0, 0.9, 'pluck', 0.9), N(988, 0.16, 1.2, 'pluck', 0.9)] },
};

// partials of each kind: [ratio to the base frequency, loudness, decay speed]
const PARTIALS = {
  bell:    [[1, 1, 1], [2.76, 0.45, 1.8], [5.4, 0.22, 2.6], [8.93, 0.1, 3.4]],
  glass:   [[1, 1, 1.2], [2.0, 0.3, 2], [3.0, 0.15, 2.6]],
  marimba: [[1, 1, 1.6], [4, 0.35, 3.5]],
  pluck:   [[1, 1, 1.3], [2, 0.5, 1.8], [3, 0.25, 2.4], [4, 0.12, 3]],
  organ:   [[1, 1, 0.6], [2, 0.3, 0.8]],
  sine:    [[1, 1, 1]],
};

function reverb(ctx) { // a short soft tail, made from decaying noise
  const len = Math.floor(ctx.sampleRate * 0.9);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
  }
  const conv = ctx.createConvolver();
  conv.buffer = buf;
  return conv;
}

export function playSound(name) {
  const def = SOUNDS[name] || SOUNDS.ding;
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.32;
  const wet = ctx.createGain();
  wet.gain.value = 0.22;
  const rev = reverb(ctx);
  master.connect(ctx.destination);
  master.connect(rev);
  rev.connect(wet).connect(ctx.destination);

  const t0 = ctx.currentTime + 0.03;
  let end = 0;
  for (const n of def.notes) {
    const at = t0 + n.s;
    if (n.k === 'drop') { // pitch falls quickly: a water drop
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.f, at);
      osc.frequency.exponentialRampToValueAtTime(n.f * 0.45, at + n.d);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.7 * n.v, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + n.d);
      osc.connect(g).connect(master);
      osc.start(at); osc.stop(at + n.d + 0.05);
    } else {
      for (const [ratio, vol, decay] of PARTIALS[n.k] || PARTIALS.sine) {
        const f = n.f * ratio;
        if (f > 12000) continue;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        const len = n.d / decay;
        const attack = n.k === 'organ' ? 0.05 : 0.004;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * n.v * 0.6), at + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, at + attack + len);
        osc.connect(g).connect(master);
        osc.start(at); osc.stop(at + attack + len + 0.05);
      }
    }
    end = Math.max(end, n.s + n.d);
  }
  setTimeout(() => ctx.close().catch(() => {}), (end + 1.6) * 1000);
}
