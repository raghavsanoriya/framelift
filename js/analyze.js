// Cheap per-frame analysis used to skip blurry frames and near-duplicates BEFORE upscaling,
// which is the slow step.

const AW = 160; // analysis width

export function analyze(canvas) {
  const ah = Math.max(9, Math.round((canvas.height / canvas.width) * AW));
  const c = document.createElement('canvas'); c.width = AW; c.height = ah;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(canvas, 0, 0, AW, ah);
  const d = g.getImageData(0, 0, AW, ah).data;
  const gray = new Float32Array(AW * ah);
  let mean = 0;
  for (let i = 0; i < gray.length; i++) { gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; mean += gray[i]; }
  mean /= gray.length;

  // sharpness = variance of the Laplacian
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < ah - 1; y++) for (let x = 1; x < AW - 1; x++) {
    const i = y * AW + x;
    const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - AW] - gray[i + AW];
    s += l; s2 += l * l; n++;
  }
  const sharpness = s2 / n - (s / n) ** 2;

  // difference hash (9x8 -> 64 bits) for duplicate detection
  const h = document.createElement('canvas'); h.width = 9; h.height = 8;
  const hg = h.getContext('2d', { willReadFrequently: true });
  hg.drawImage(c, 0, 0, 9, 8);
  const hd = hg.getImageData(0, 0, 9, 8).data;
  const bits = new Uint8Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const a = hd[(y * 9 + x) * 4], b = hd[(y * 9 + x + 1) * 4];
    bits[y * 8 + x] = a > b ? 1 : 0;
  }
  return { sharpness, hash: bits, mean, tone: autoTone(toneStats(d)) };
}

// ---------- auto enhance (our version of an "analyze, then fix" enhancer) ----------
// Statistics of a small RGBA thumbnail: luma percentiles, spread, colour cast, saturation.
function toneStats(d) {
  const hist = new Uint32Array(256);
  let n = 0, sum = 0, sum2 = 0, satSum = 0, mr = 0, mg = 0, mb = 0, mn = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    hist[l | 0]++; n++; sum += l; sum2 += l * l;
    const mx = Math.max(r, g, b), mi = Math.min(r, g, b);
    satSum += mx ? (mx - mi) / mx : 0;
    if (l > 40 && l < 215) { mr += r; mg += g; mb += b; mn++; } // midtones only for white balance
  }
  const pct = q => { let acc = 0; const target = q * n; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v / 255; } return 1; };
  const mean = sum / n / 255;
  return {
    lo: pct(0.005), hi: pct(0.995), mean,
    std: Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2)) / 255,
    sat: satSum / n,
    cast: mn > n * 0.05 ? [mr / mn, mg / mn, mb / mn] : null,
  };
}

const clampN = (v, a, b) => Math.min(b, Math.max(a, v));

// Gentle, bounded corrections (like a photo app's auto button), plus which ones are active.
export function autoTone(st) {
  const fixes = [];
  // Levels: stretch the black and white points, but never clip much.
  let black = clampN(st.lo - 0.01, 0, 0.1), white = clampN(st.hi + 0.01, 0.85, 1);
  if (black < 0.015) black = 0;
  if (white > 0.985) white = 1;
  if (black > 0 || white < 1) fixes.push('levels');
  const span = white - black;
  // Exposure: pull the average toward a mid tone with a gamma curve, half strength.
  const m = clampN((st.mean - black) / span, 0.02, 0.98);
  let gamma = clampN(Math.log(0.46) / Math.log(m), 0.7, 1.4);
  gamma = 1 + (gamma - 1) * 0.5;
  if (Math.abs(gamma - 1) < 0.03) gamma = 1; else fixes.push('exposure');
  // Contrast: flat images get a soft S-curve.
  const stdN = st.std / span;
  const contrast = stdN < 0.2 ? clampN((0.2 - stdN) * 2.5, 0, 0.35) : 0;
  if (contrast > 0.03) fixes.push('contrast');
  // Colour: lift dull colour a little; leave black-and-white footage alone.
  let saturation = 1;
  if (st.sat > 0.05 && st.sat < 0.3) { saturation = 1 + clampN((0.3 - st.sat) * 0.8, 0, 0.2); fixes.push('color'); }
  // Warmth: weak grey-world white balance, capped at ±6% per channel.
  let gains = [1, 1, 1];
  if (st.cast) {
    const avg = (st.cast[0] + st.cast[1] + st.cast[2]) / 3;
    gains = st.cast.map(c => clampN(1 + (avg / c - 1) * 0.35, 0.94, 1.06));
    if (Math.max(...gains.map(g => Math.abs(g - 1))) < 0.012) gains = [1, 1, 1]; else fixes.push('warmth');
  }
  return { black, white, gamma, contrast: contrast > 0.03 ? contrast : 0, saturation, gains, fixes };
}

// What the source needs, for the Enhance panel.
export function classify(w, h, sharpness) {
  if (Math.min(w, h) < 720) return 'low_res';
  if (sharpness < 60) return 'soft';
  return 'good';
}

export function hamming(a, b) { let d = 0; for (let i = 0; i < 64; i++) d += a[i] !== b[i]; return d; }

export const DEDUPE = { off: -1, light: 3, medium: 6, strong: 10 };

// Decide which frames to keep. Mutates frame.skipReason.
// Blur is judged against neighbouring frames OF THE SAME SCENE (similar hash), so a sharp but
// plain frame (title card, sky) is not mistaken for a blurry one.
function isBlurry(frames, i) {
  const f = frames[i], a = f.analysis;
  let best = 0;
  for (const j of [i - 2, i - 1, i + 1, i + 2]) {
    const n = frames[j];
    if (!n || hamming(n.analysis.hash, a.hash) > 20) continue; // different scene
    best = Math.max(best, n.analysis.sharpness);
  }
  return best > 0 && a.sharpness < best * 0.4;
}

export function filterFrames(frames, { skipBlurry, dedupe }) {
  const thr = DEDUPE[dedupe] ?? -1;
  const kept = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    f.skipReason = null;
    if (skipBlurry && (f.analysis.mean < 6 || f.analysis.mean > 250)) f.skipReason = 'blank';
    else if (skipBlurry && isBlurry(frames, i)) f.skipReason = 'blurry';
    else if (thr >= 0 && kept.length) {
      const last = kept[kept.length - 1];
      if (hamming(last.analysis.hash, f.analysis.hash) <= thr) f.skipReason = 'duplicate';
      else if (kept.some(k => hamming(k.analysis.hash, f.analysis.hash) <= Math.floor(thr / 2))) f.skipReason = 'duplicate';
    }
    if (!f.skipReason) kept.push(f);
  }
  return kept;
}
