// AI upscaling in the browser with Real-ESRGAN (ONNX) on onnxruntime-web.
// Models are trained with real-world degradations (blur, noise, JPEG), so they clean up
// compression artifacts instead of sharpening them. Both models upscale 4x natively;
// 2x output is 4x inference followed by a high-quality downscale per tile.

const ORT_VER = '1.31.1';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist/`;

export const MODELS = {
  balanced: { file: 'models/realesr-general-x4v3.onnx', label: 'Real-ESRGAN General', tile: 192 },
  max:      { file: 'models/realesrgan-x4plus.onnx',    label: 'Real-ESRGAN x4plus',  tile: 128 },
};
const NATIVE = 4;

let ortPromise = null;
function loadOrt() {
  if (!ortPromise) ortPromise = import(`${ORT_BASE}ort.webgpu.min.mjs`).then(ort => {
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    return ort;
  });
  return ortPromise;
}

// Prefer WebGPU; fall back to WASM (CPU). `?backend=wasm` forces CPU for testing.
const forced = new URLSearchParams(location.search).get('backend');
let backend = null;      // 'webgpu' | 'wasm'
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
    if (backend === 'webgpu' && !gpuLabel) gpuLabel = webglRenderer();
    return { backend: backend === 'webgpu' ? 'webgpu' : 'cpu', gpu: gpuLabel };
  })();
  return backendReady;
}

function webglRenderer() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    return gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
  } catch { return ''; }
}

let current = { key: null, session: null };

async function getSession(modelKey) {
  await initBackend();
  const key = modelKey + backend;
  if (current.key === key) return current.session;
  const ort = await loadOrt();
  if (current.session) { try { await current.session.release(); } catch { /* ignore */ } }
  current = { key: null, session: null };
  const m = MODELS[modelKey];
  const session = await ort.InferenceSession.create(m.file, {
    executionProviders: backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
    graphOptimizationLevel: 'all',
  });
  current = { key, session };
  return session;
}

// If WebGPU fails (driver, lost device), switch to WASM and let the caller retry.
export async function fallbackBackend() {
  if (backend === 'wasm') return false;
  backend = 'wasm';
  if (current.session) { try { await current.session.release(); } catch { /* ignore */ } }
  current = { key: null, session: null };
  backendReady = Promise.resolve({ backend: 'cpu', gpu: '' });
  return true;
}

export function currentBackend() { return backend; }

// Upscale a canvas/ImageBitmap to `scale` (2 or 4). onProgress(0..1). signal: AbortSignal.
// Every tile has the same input shape (tile + 2*overlap), padded with edge pixels, so the
// GPU pipeline is built once; overlaps are discarded so tile seams never show.
export async function upscaleImage(src, { modelKey, scale, onProgress, signal, overlap = 16 }) {
  const ort = await loadOrt();
  const session = await getSession(modelKey);
  const inName = session.inputNames[0], outName = session.outputNames[0];
  const tile = MODELS[modelKey].tile;
  const W = src.width, H = src.height;
  const cols = Math.ceil(W / tile), rows = Math.ceil(H / tile);
  const T = tile + 2 * overlap, TO = T * NATIVE;

  // padded source with replicated edges
  const pad = document.createElement('canvas');
  pad.width = cols * tile + 2 * overlap; pad.height = rows * tile + 2 * overlap;
  const pg = pad.getContext('2d');
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
  const input = new Float32Array(3 * T * T);
  const outImg = new ImageData(TO, TO);
  const plane = T * T, oplane = TO * TO;

  let done = 0;
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const x0 = tx * tile, y0 = ty * tile;
    tg.drawImage(pad, x0, y0, T, T, 0, 0, T, T);
    const d = tg.getImageData(0, 0, T, T).data;
    for (let i = 0; i < plane; i++) {
      input[i] = d[i * 4] / 255;
      input[plane + i] = d[i * 4 + 1] / 255;
      input[2 * plane + i] = d[i * 4 + 2] / 255;
    }
    const feeds = { [inName]: new ort.Tensor('float32', input, [1, 3, T, T]) };
    const res = await session.run(feeds);
    const o = res[outName];
    const od = o.data; // Float32Array [1,3,TO,TO]
    const p = outImg.data;
    for (let i = 0; i < oplane; i++) {
      p[i * 4]     = clamp255(od[i]);
      p[i * 4 + 1] = clamp255(od[oplane + i]);
      p[i * 4 + 2] = clamp255(od[2 * oplane + i]);
      p[i * 4 + 3] = 255;
    }
    o.dispose?.();
    px.putImageData(outImg, 0, 0);

    // keep only the core (drop overlaps), clipped to the image; scale 4x -> requested scale
    const cw = Math.min(tile, W - x0), ch = Math.min(tile, H - y0);
    og.drawImage(pix, overlap * NATIVE, overlap * NATIVE, cw * NATIVE, ch * NATIVE,
      x0 * scale, y0 * scale, cw * scale, ch * scale);

    done++;
    onProgress?.(done / (cols * rows));
    await yieldToUI();
  }
  pad.width = pad.height = 0;
  return out;
}

function clamp255(v) { v = v * 255 + 0.5; return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

// setTimeout is clamped to >=1s in background tabs; a MessageChannel post is not.
const channel = new MessageChannel();
const pending = [];
channel.port1.onmessage = () => pending.shift()?.();
function yieldToUI() { return new Promise(r => { pending.push(r); channel.port2.postMessage(0); }); }

// Non-AI path: high-quality browser resize.
export function resizeImage(src, scale) {
  const c = document.createElement('canvas'); c.width = src.width * scale; c.height = src.height * scale;
  const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height); return c;
}

export function tfMemory() { return null; }
