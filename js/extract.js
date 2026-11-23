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
