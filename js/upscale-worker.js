// FrameLift engine worker: runs the AI model and all per-pixel work off the main thread,
// so the page (and the phone it runs on) stays responsive while frames upscale.
// Protocol (every request carries an `id`; replies echo it):
//   init   {modelUrl, ortBase, wantGpu, threads}        -> {type:'ready', backend}
//   tile   {rgba, T, tone, sharpen, texture}             -> {type:'tile', rgba}  (4x, T*4 square)
//   filter {rgba, w, h, tone, sharpen}                   -> {type:'filter', rgba}
//   reset  {}                                            -> {type:'reset'}  (drops the session, forces CPU)
// Progress for slow first-time steps is posted as {type:'stage', stage, p}.

const NATIVE = 4;
let ort = null;
let session = null, sessionKey = '', backend = 'wasm', forceCpu = false;

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'init') {
      await ensureSession(m);
      self.postMessage({ type: 'ready', id: m.id, backend });
    } else if (m.type === 'tile') {
      const out = await runTile(m);
      self.postMessage({ type: 'tile', id: m.id, rgba: out.buffer }, [out.buffer]);
    } else if (m.type === 'filter') {
      const out = filterImage(m);
      self.postMessage({ type: 'filter', id: m.id, rgba: out.buffer }, [out.buffer]);
    } else if (m.type === 'reset') {
      await dropSession();
      forceCpu = true; backend = 'wasm';
      self.postMessage({ type: 'reset', id: m.id });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m.id, name: e?.name || 'Error', message: String(e?.message || e) });
  }
};

const stage = (name, p) => { if (name !== 'engine-js') self.postMessage({ type: 'stage', stage: name, p }); };

// Download with progress. Content-Length may be the compressed size, so progress is clamped.
async function fetchBytes(url, stageName) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url.split('/').pop()} (HTTP ${res.status})`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) { stage(stageName, 1); return new Uint8Array(await res.arrayBuffer()); }
  const reader = res.body.getReader();
  const chunks = []; let got = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    const now = performance.now();
    if (now - last > 120) { last = now; stage(stageName, Math.min(0.99, got / total)); }
  }
  const buf = new Uint8Array(got); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  stage(stageName, 1);
  return buf;
}

// Supply-chain guard: the engine comes from a public CDN, so every file is checked against the
// SHA-256 published for onnxruntime-web 1.31.1 before it runs. A tampered file is refused.
const ORT_SHA256 = {
  'ort.webgpu.min.mjs': 'MpzZVncjl6Gu3WaOkRGV05r++xgvb8FKr6TwisjY83k=',
  'ort-wasm-simd-threaded.asyncify.mjs': 'Wc94FTDhoW3yopHXh5jj7BFSRn7a7EAtb5WZ2FBHwwI=',
  'ort-wasm-simd-threaded.asyncify.wasm': 'yjGelTnNDx4pHPVgdHYBIerzllD12/hLblLAf0spROw=',
};
async function verified(bytes, name) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let bin = ''; for (const b of digest) bin += String.fromCharCode(b);
  if (btoa(bin) !== ORT_SHA256[name]) throw new Error(`Integrity check failed for ${name}: the downloaded AI engine does not match the expected version, so it was not run.`);
  return bytes;
}
const moduleUrl = bytes => URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));

async function loadOrt(base, threads) {
  if (ort) return ort;
  const main = await verified(await fetchBytes(base + 'ort.webgpu.min.mjs', 'engine-js'), 'ort.webgpu.min.mjs');
  const glue = await verified(await fetchBytes(base + 'ort-wasm-simd-threaded.asyncify.mjs', 'engine-js'), 'ort-wasm-simd-threaded.asyncify.mjs');
  // Fetched here (not by onnxruntime) so the ~29 MB download shows progress and can be verified.
  const wasm = await verified(await fetchBytes(base + 'ort-wasm-simd-threaded.asyncify.wasm', 'engine'), 'ort-wasm-simd-threaded.asyncify.wasm');
  const mod = await import(moduleUrl(main));
  mod.env.wasm.wasmPaths = { mjs: moduleUrl(glue) };
  mod.env.wasm.wasmBinary = wasm;
  mod.env.wasm.numThreads = threads;
  ort = mod;
  return ort;
}

async function dropSession() {
  if (session) { try { await session.release(); } catch { /* ignore */ } }
  session = null; sessionKey = '';
}

async function ensureSession({ modelUrl, ortBase, wantGpu, threads }) {
  const lib = await loadOrt(ortBase, threads);
  const gpuOk = wantGpu && !forceCpu && !!self.navigator?.gpu;
  // A session that fell back to the CPU also satisfies a later CPU request (no second load).
  if (session && (sessionKey === modelUrl + (gpuOk ? '|webgpu' : '|wasm') || (!gpuOk && sessionKey === modelUrl + '|wasm'))) return;
  await dropSession();
  const model = await fetchBytes(modelUrl, 'model');
  stage('start', 0);
  const opts = { graphOptimizationLevel: 'all' };
  if (gpuOk) {
    try {
      // WebGPU only: if it can't start we want to know, not silently run on the CPU.
      session = await lib.InferenceSession.create(model, { ...opts, executionProviders: ['webgpu'] });
      backend = 'webgpu';
    } catch (e) {
      console.warn('WebGPU session failed, using CPU', e);
      session = null;
    }
  }
  if (!session) {
    session = await lib.InferenceSession.create(model, { ...opts, executionProviders: ['wasm'] });
    backend = 'wasm';
  }
  sessionKey = modelUrl + '|' + backend;
  stage('start', 1);
}

// ---------- tone (auto enhance) ----------
// tone = {black, white, gamma, contrast, saturation, gains:[r,g,b]} or null
function buildLuts(tone) {
  const luts = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
  const { black = 0, white = 1, gamma = 1, contrast = 0, gains = [1, 1, 1] } = tone;
  const span = Math.max(0.05, white - black);
  for (let c = 0; c < 3; c++) for (let v = 0; v < 256; v++) {
    let x = (v / 255) * gains[c];
    x = (x - black) / span;
    x = x <= 0 ? 0 : x >= 1 ? 1 : x;
    if (gamma !== 1) x = Math.pow(x, gamma);
    if (contrast) x = x - (contrast * Math.sin(2 * Math.PI * x)) / (2 * Math.PI); // gentle S-curve
    luts[c][v] = x * 255 + 0.5;
  }
  return luts;
}

function applyTone(px, tone) {
  if (!tone) return;
  const [lr, lg, lb] = buildLuts(tone);
  const sat = tone.saturation ?? 1;
  for (let i = 0; i < px.length; i += 4) {
    let r = lr[px[i]], g = lg[px[i + 1]], b = lb[px[i + 2]];
    if (sat !== 1) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
    }
    px[i] = r; px[i + 1] = g; px[i + 2] = b; // Uint8ClampedArray rounds and clamps
  }
}

// ---------- sharpen: unsharp mask on a planar float image (values 0..1) ----------
const K5 = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
const K3 = [1 / 4, 2 / 4, 1 / 4];
let tmpA = null, tmpB = null;
function unsharpPlane(src, off, w, h, amount, kernel) {
  const n = w * h, r = kernel.length >> 1;
  if (!tmpA || tmpA.length < n) { tmpA = new Float32Array(n); tmpB = new Float32Array(n); }
  for (let y = 0; y < h; y++) { // horizontal blur
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) { const xx = x + k < 0 ? 0 : x + k >= w ? w - 1 : x + k; s += src[off + row + xx] * kernel[k + r]; }
      tmpA[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) { // vertical blur
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) { const yy = y + k < 0 ? 0 : y + k >= h ? h - 1 : y + k; s += tmpA[yy * w + x] * kernel[k + r]; }
      tmpB[y * w + x] = s;
    }
  }
  const thr = 1.5 / 255; // leave flat areas (and noise) alone
  for (let i = 0; i < n; i++) {
    const d = src[off + i] - tmpB[i];
    if (d > thr || d < -thr) src[off + i] += amount * d;
  }
}

// ---------- one AI tile ----------
let input = null, refUp = null;
async function runTile({ rgba, T, tone, sharpen = 0, texture = 0 }) {
  if (!session) throw new Error('AI model is not loaded');
  const px = new Uint8ClampedArray(rgba);
  applyTone(px, tone);
  const plane = T * T;
  if (!input || input.length !== 3 * plane) input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = px[i * 4] / 255;
    input[plane + i] = px[i * 4 + 1] / 255;
    input[2 * plane + i] = px[i * 4 + 2] / 255;
  }
  const inName = session.inputNames[0], outName = session.outputNames[0];
  const res = await session.run({ [inName]: new ort.Tensor('float32', input, [1, 3, T, T]) });
  const o = res[outName];
  const TO = T * NATIVE, oplane = TO * TO;
  const od = new Float32Array(o.data); // own copy before releasing the tensor (fast typed-array copy)
  o.dispose?.();

  // Keep some of the original detail: blend with a smooth 4x enlargement of the (toned) input.
  if (texture > 0) {
    if (!refUp || refUp.length !== oplane) refUp = new Float32Array(oplane);
    for (let c = 0; c < 3; c++) {
      bilinear4x(px, c, T, refUp);
      const base = c * oplane;
      for (let i = 0; i < oplane; i++) od[base + i] = od[base + i] * (1 - texture) + refUp[i] * texture;
    }
  }
  if (sharpen > 0) for (let c = 0; c < 3; c++) unsharpPlane(od, c * oplane, TO, TO, sharpen * 1.4, K5);

  const out = new Uint8ClampedArray(oplane * 4);
  for (let i = 0; i < oplane; i++) {
    out[i * 4] = od[i] * 255;
    out[i * 4 + 1] = od[oplane + i] * 255;
    out[i * 4 + 2] = od[2 * oplane + i] * 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

function bilinear4x(px, c, T, dst) {
  const TO = T * NATIVE;
  for (let Y = 0; Y < TO; Y++) {
    let sy = (Y + 0.5) / NATIVE - 0.5; if (sy < 0) sy = 0;
    const y0 = sy | 0, y1 = y0 + 1 < T ? y0 + 1 : T - 1, fy = sy - y0;
    for (let X = 0; X < TO; X++) {
      let sx = (X + 0.5) / NATIVE - 0.5; if (sx < 0) sx = 0;
      const x0 = sx | 0, x1 = x0 + 1 < T ? x0 + 1 : T - 1, fx = sx - x0;
      const a = px[(y0 * T + x0) * 4 + c], b = px[(y0 * T + x1) * 4 + c];
      const d = px[(y1 * T + x0) * 4 + c], e = px[(y1 * T + x1) * 4 + c];
      dst[Y * TO + X] = ((a + (b - a) * fx) * (1 - fy) + (d + (e - d) * fx) * fy) / 255;
    }
  }
}

// ---------- enhance without AI (original size) ----------
function filterImage({ rgba, w, h, tone, sharpen = 0 }) {
  const px = new Uint8ClampedArray(rgba);
  applyTone(px, tone);
  if (sharpen > 0) {
    const n = w * h, f = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) { f[i] = px[i * 4] / 255; f[n + i] = px[i * 4 + 1] / 255; f[2 * n + i] = px[i * 4 + 2] / 255; }
    for (let c = 0; c < 3; c++) unsharpPlane(f, c * n, w, h, sharpen * 1.2, K3);
    for (let i = 0; i < n; i++) { px[i * 4] = f[i] * 255; px[i * 4 + 1] = f[n + i] * 255; px[i * 4 + 2] = f[2 * n + i] * 255; }
  }
  return px;
}
