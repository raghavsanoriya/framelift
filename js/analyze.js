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
  return { sharpness, hash: bits, mean };
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
