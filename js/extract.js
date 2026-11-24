// Frame extraction: <video> seek -> wait for the decoded frame -> draw at native resolution.
// Everything stays in the browser.

export function loadVideo(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = URL.createObjectURL(file);
    const fail = () => { URL.revokeObjectURL(v.src); reject(new Error(
      'Your browser cannot decode this video (often HEVC/H.265 or ProRes). ' +
      'Try Chrome or Edge, or convert it to H.264 MP4 or WebM first.')); };
    v.onerror = fail;
    v.onloadeddata = async () => {
      if (!v.videoWidth || !v.videoHeight) return fail();
      // Some WebM files report Infinity duration until we seek to the end.
      if (!isFinite(v.duration)) {
        v.currentTime = 1e7;
        await new Promise(r => { v.addEventListener('seeked', r, { once: true }); setTimeout(r, 5000); });
        if (!isFinite(v.duration)) return fail();
        v.currentTime = 0;
      }
      resolve(v);
    };
  });
}

// Seek and resolve only once a frame for that time has actually been presented.
export function seekTo(video, t, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = ok => { if (done) return; done = true; clearTimeout(timer); ok ? resolve() : reject(new Error('seek timeout at ' + t.toFixed(3) + 's')); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    video.addEventListener('seeked', () => {
      if ('requestVideoFrameCallback' in video) {
        // seeked fires before the new frame is guaranteed to be composited
        video.requestVideoFrameCallback(() => finish(true));
        // rVFC may not fire for a paused video in some browsers; fall back shortly after.
        setTimeout(() => finish(true), 250);
      } else finish(true);
    }, { once: true });
    video.currentTime = Math.min(Math.max(0, t), Math.max(0, video.duration - 0.001));
  });
}

// Best-frame picking: look at `n` frames spread across [t - win, t + win] and settle on the
// sharpest (motion blur and heavily compressed in-between frames score low).
// Returns the chosen time; the video is left showing that frame.
const scoreCanvas = document.createElement('canvas');
export function quickSharpness(video) {
  const w = 256, h = Math.max(16, Math.round(video.videoHeight / video.videoWidth * w));
  scoreCanvas.width = w; scoreCanvas.height = h;
  const g = scoreCanvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(video, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
    s += l; s2 += l * l; n++;
  }
  return s2 / n - (s / n) ** 2;
}

export async function seekSharpest(video, t, win, n = 5) {
  if (!(win > 0) || n < 2) { await seekTo(video, t); return t; }
  const lo = Math.max(0, t - win), hi = Math.min(video.duration - 0.001, t + win);
  let best = t, bestScore = -1;
  for (let i = 0; i < n; i++) {
    const tt = lo + ((hi - lo) * i) / (n - 1);
    try { await seekTo(video, tt); } catch { continue; }
    const sc = quickSharpness(video);
    if (sc > bestScore) { bestScore = sc; best = tt; }
  }
  await seekTo(video, best);
  return best;
}

// Multi-frame grain reduction. Sensor grain changes from frame to frame while real detail stays
// put, so averaging a frame with its neighbours removes grain without blurring. (Measured: about
// +1 dB on grainy, high-bitrate footage; no gain on low-bitrate video, because the encoder copies
// still areas forward and their compression error is the same in every frame. Off by default.) Each neighbour pixel only counts where the local area matches the centre frame;
// anything that moved (people, a camera pan) falls back to the single frame, so nothing ghosts.
// `canvas` holds the frame at time `at`; it is updated in place. Returns how many neighbours helped.
const STEP = 1 / 24; // lands on a different frame for any video of 24 fps or more
function pixelsOf(video, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(video, 0, 0);
  return g.getImageData(0, 0, w, h).data;
}
export async function mergeNeighbours(video, at, canvas, { radius = 2, signal } = {}) {
  const w = canvas.width, h = canvas.height, n = w * h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, w, h), c = img.data;
  const sum = new Float32Array(n * 3), wsum = new Float32Array(n);
  for (let i = 0; i < n; i++) { sum[i * 3] = c[i * 4]; sum[i * 3 + 1] = c[i * 4 + 1]; sum[i * 3 + 2] = c[i * 4 + 2]; wsum[i] = 1; }
  const diff = new Float32Array(n), tmp = new Float32Array(n);
  let used = 0;
  for (let k = -radius; k <= radius; k++) {
    if (!k) continue;
    if (signal?.aborted) break;
    const t = at + k * STEP;
    if (t < 0 || t > video.duration - 0.001) continue;
    try { await seekTo(video, t); } catch { continue; }
    const p = pixelsOf(video, w, h);
    // luma difference, 7x7 box blur so noise alone doesn't look like motion, then spread it 4 px
    // so the soft edges of moving things are excluded too (tuned against a clean reference)
    let same = true;
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      const d = Math.abs(0.299 * (p[j] - c[j]) + 0.587 * (p[j + 1] - c[j + 1]) + 0.114 * (p[j + 2] - c[j + 2]));
      diff[i] = d; if (d) same = false;
    }
    if (same) continue; // seek landed on the same frame (low frame rate video)
    boxBlur(diff, tmp, w, h, 3);
    maxFilter(diff, tmp, w, h, 4);
    let helped = 0;
    for (let i = 0; i < n; i++) {
      const d = diff[i];
      const wt = d <= 2 ? 1 : d >= 6 ? 0 : (6 - d) / 4;
      if (!wt) continue;
      const j = i * 4, q = i * 3;
      sum[q] += p[j] * wt; sum[q + 1] += p[j + 1] * wt; sum[q + 2] += p[j + 2] * wt; wsum[i] += wt;
      helped += wt;
    }
    if (helped > n * 0.05) used++;
  }
  if (used) {
    for (let i = 0; i < n; i++) {
      const q = i * 3, j = i * 4, ws = wsum[i];
      c[j] = sum[q] / ws; c[j + 1] = sum[q + 1] / ws; c[j + 2] = sum[q + 2] / ws;
    }
    g.putImageData(img, 0, 0);
  }
  return used;
}
// separable max filter (dilation), radius r, in place on `a`
function maxFilter(a, t, w, h, r) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0; const x1 = Math.min(w - 1, x + r);
      for (let xx = Math.max(0, x - r); xx <= x1; xx++) if (a[row + xx] > m) m = a[row + xx];
      t[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = 0; const y1 = Math.min(h - 1, y + r);
    for (let yy = Math.max(0, y - r); yy <= y1; yy++) if (t[yy * w + x] > m) m = t[yy * w + x];
    a[y * w + x] = m;
  }
}
// separable box blur, radius r, in place on `a`
function boxBlur(a, t, w, h, r) {
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w; let s = 0;
    for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      t[row + x] = s / win;
      s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      a[y * w + x] = s / win;
      s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
    }
  }
}

export function drawFrame(video) {
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  // read back three times (analysis, PNG, thumbnail), so keep it in CPU memory
  c.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0);
  return c;
}

// Build the list of timestamps for the selected mode.
export function planTimestamps({ mode, every, count, fps, start, end, maxFrames }) {
  const span = Math.max(0, end - start);
  let ts = [];
  if (mode === 'interval') {
    const step = Math.max(0.04, every);
    for (let t = start; t <= end + 1e-6; t += step) ts.push(t);
  } else if (mode === 'count') {
    const n = Math.max(1, count);
    if (n === 1) ts = [start + span / 2];
    else for (let i = 0; i < n; i++) ts.push(start + (span * i) / (n - 1));
  } else { // every frame
    const step = 1 / Math.max(1, fps);
    for (let t = start; t < end; t += step) ts.push(t + step / 2); // middle of each frame interval
  }
  const truncated = ts.length > maxFrames;
  return { timestamps: ts.slice(0, maxFrames), truncated, total: ts.length };
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality));
}
