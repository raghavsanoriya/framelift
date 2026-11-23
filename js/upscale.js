// AI upscaling in the browser with Real-ESRGAN (ONNX) on onnxruntime-web.
// The model runs in a Web Worker (js/upscale-worker.js), so the page never freezes: this file
// only cuts the frame into tiles, sends them to the worker and stitches the results.
// Both models upscale 4x natively; 2x output is 4x inference plus a high-quality downscale.

// Release number comes from this module's own URL (?v=N, set in app.js) so the worker file
// is never served stale from cache after a deploy.
const VERSION = new URL(import.meta.url).searchParams.get('v') || 'dev';

const ORT_VER = '1.31.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;

export const MODELS = {
  balanced: { file: 'models/realesr-general-x4v3.onnx', label: 'Real-ESRGAN General', tile: 192, mobileTile: 128 },
  max:      { file: 'models/realesrgan-x4plus.onnx',    label: 'Real-ESRGAN x4plus',  tile: 128, mobileTile: 96 },
};
const NATIVE = 4;

export const isMobile = !!(navigator.userAgentData?.mobile ||
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

// Prefer WebGPU; fall back to WASM (CPU). `?backend=wasm` forces CPU for testing.
const forced = new URLSearchParams(location.search).get('backend');
let backend = null;      // 'webgpu' | 'wasm' (what the worker actually runs on, once known)
let gpuLabel = '';
let backendReady = null;

export function initBackend() {
  if (!backendReady) backendReady = (async () => {
    backend = 'wasm';
    if (forced !== 'wasm' && navigator.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (adapter) {
          backend = 'webgpu';
          const i = adapter.info || (await adapter.requestAdapterInfo?.());
          gpuLabel = i ? [i.vendor, i.architecture, i.description].filter(Boolean).join(' ') : '';
        }
      } catch { /* no WebGPU */ }
    }
    return { backend: backend === 'webgpu' ? 'webgpu' : 'cpu', gpu: gpuLabel };
  })();
  return backendReady;
}

export function currentBackend() { return backend; }
export function gpuName() { return backend === 'webgpu' ? gpuLabel : ''; }

// ---------- worker plumbing ----------
let worker = null, nextId = 1, readyKey = '';
const pending = new Map();
let stageListener = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL(`./upscale-worker.js?v=${VERSION}`, import.meta.url), { type: 'module' });
  worker.onmessage = ({ data: m }) => {
    if (m.type === 'stage') { stageListener?.(m.stage, m.p); return; }
    const p = pending.get(m.id); if (!p) return;
    pending.delete(m.id);
    if (m.type === 'error') { const e = new Error(m.message); e.name = m.name || 'Error'; p.reject(e); }
    else p.resolve(m);
  };
  worker.onerror = e => { e.preventDefault?.(); killWorker(new Error('The AI engine could not start: ' + (e.message || 'worker error'))); };
  return worker;
}

function call(msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

function killWorker(reason) {
  worker?.terminate(); worker = null; readyKey = '';
  for (const p of pending.values()) p.reject(reason);
  pending.clear();
}

// Cancel must be instant even in the middle of a long CPU tile: terminate the worker.
function watchAbort(signal) {
  if (!signal) return () => {};
  const onAbort = () => killWorker(new DOMException('Cancelled', 'AbortError'));
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

async function ensureModel(modelKey) {
  await initBackend();
  const modelUrl = new URL(MODELS[modelKey].file, document.baseURI).href;
  const key = modelUrl + '|' + backend;
  if (readyKey === key && worker) return;
  const r = await call({
    type: 'init', modelUrl, ortBase: ORT_BASE, wantGpu: backend === 'webgpu',
    threads: self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1,
  });
  backend = r.backend;
  readyKey = modelUrl + '|' + backend;
}

// If WebGPU fails mid-run (driver, lost device), switch to the CPU and let the caller retry.
export async function fallbackBackend() {
  if (backend === 'wasm') return false;
  backend = 'wasm'; readyKey = '';
  try { await call({ type: 'reset' }); } catch { killWorker(new Error('reset')); }
  return true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Upscale a canvas/ImageBitmap to `scale` (2 or 4).
// opts: modelKey, scale, onProgress(0..1), onStage(stage, p), signal, tone, sharpen (0..1), texture (0..1)
// Every tile has the same input shape (tile + 2*overlap), padded with edge pixels, so the GPU
// pipeline is built once; overlaps are discarded so tile seams never show.
export async function upscaleImage(src, { modelKey, scale, onProgress, onStage, signal, tone = null, sharpen = 0, texture = 0, overlap = 16 }) {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const unwatch = watchAbort(signal);
  stageListener = onStage || null;
  try {
    await ensureModel(modelKey);
    const m = MODELS[modelKey];
    const gentle = isMobile && backend === 'webgpu';
    const tile = gentle ? m.mobileTile : m.tile;
    const W = src.width, H = src.height;
    const cols = Math.ceil(W / tile), rows = Math.ceil(H / tile);
    const T = tile + 2 * overlap, TO = T * NATIVE;

    // padded source with replicated edges
    const pad = document.createElement('canvas');
    pad.width = cols * tile + 2 * overlap; pad.height = rows * tile + 2 * overlap;
    const pg = pad.getContext('2d', { willReadFrequently: true }); // edges are copied canvas-to-itself
    pg.imageSmoothingEnabled = false;
    pg.drawImage(src, overlap, overlap);
    pg.drawImage(src, 0, 0, 1, H, 0, overlap, overlap, H);
    pg.drawImage(src, W - 1, 0, 1, H, overlap + W, overlap, pad.width - overlap - W, H);
    pg.drawImage(pad, 0, overlap, pad.width, 1, 0, 0, pad.width, overlap);
    pg.drawImage(pad, 0, overlap + H - 1, pad.width, 1, 0, overlap + H, pad.width, pad.height - overlap - H);

    const out = document.createElement('canvas'); out.width = W * scale; out.height = H * scale;
    const og = out.getContext('2d');
    og.imageSmoothingEnabled = true; og.imageSmoothingQuality = 'high';
    const tileCanvas = document.createElement('canvas'); tileCanvas.width = T; tileCanvas.height = T;
    const tg = tileCanvas.getContext('2d', { willReadFrequently: true });
    const pix = document.createElement('canvas'); pix.width = TO; pix.height = TO;
    const px = pix.getContext('2d');

    let done = 0;
    for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const x0 = tx * tile, y0 = ty * tile;
      tg.drawImage(pad, x0, y0, T, T, 0, 0, T, T);
      const d = tg.getImageData(0, 0, T, T).data;
      const r = await call({ type: 'tile', rgba: d.buffer, T, tone, sharpen, texture }, [d.buffer]);
      px.putImageData(new ImageData(new Uint8ClampedArray(r.rgba), TO, TO), 0, 0);
      // keep only the core (drop overlaps), clipped to the image; scale 4x -> requested scale
      const cw = Math.min(tile, W - x0), ch = Math.min(tile, H - y0);
      og.drawImage(pix, overlap * NATIVE, overlap * NATIVE, cw * NATIVE, ch * NATIVE,
        x0 * scale, y0 * scale, cw * scale, ch * scale);
      done++;
      onProgress?.(done / (cols * rows));
      // On phones, leave the GPU a moment between tiles so scrolling and taps stay smooth.
      if (gentle && !document.hidden) await sleep(24);
    }
    pad.width = pad.height = 0; pix.width = pix.height = 0;
    return out;
  } finally {
    unwatch(); stageListener = null;
  }
}

// Enhance at original size (no AI): tone + sharpen, done in the worker.
export async function enhanceImage(src, { tone = null, sharpen = 0, signal }) {
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0);
  if (!tone && !(sharpen > 0)) return c;
  const unwatch = watchAbort(signal);
  try {
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const r = await call({ type: 'filter', rgba: d.buffer, w: c.width, h: c.height, tone, sharpen }, [d.buffer]);
    g.putImageData(new ImageData(new Uint8ClampedArray(r.rgba), c.width, c.height), 0, 0);
    return c;
  } finally { unwatch(); }
}

// Non-AI path: high-quality browser resize.
export function resizeImage(src, scale) {
  const c = document.createElement('canvas'); c.width = src.width * scale; c.height = src.height * scale;
  const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height); return c;
}

// Rough number of AI tiles for one frame (for time warnings).
export function tileCount(w, h, modelKey) {
  const m = MODELS[modelKey], t = isMobile && backend === 'webgpu' ? m.mobileTile : m.tile;
  return Math.ceil(w / t) * Math.ceil(h / t);
}
