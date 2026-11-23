import { loadVideo, seekTo, seekSharpest, drawFrame, planTimestamps, canvasToBlob } from './extract.js';
import { analyze, filterFrames } from './analyze.js';
import { upscaleImage, resizeImage, initBackend, fallbackBackend, currentBackend } from './upscale.js';

const $ = id => document.getElementById(id);
const MAX_OUTPUT_SIDE = 8192;      // browser canvas + memory safety
const ZIP_PART_BYTES = 1.5e9;      // split ZIP downloads so a single Blob stays manageable

const state = {
  file: null, video: null, frames: [], running: false, abort: null,
};

// ---------- loading ----------
const drop = $('drop'), fileInput = $('file');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) openFile(f); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) openFile(fileInput.files[0]); fileInput.value = ''; });
const pickVideo = () => { if (!state.running) fileInput.click(); };
$('changeVideo').addEventListener('click', pickVideo);
$('newVideoBtn').addEventListener('click', pickVideo);

async function openFile(file) {
  showError(null);
  if (state.running) return;
  try {
    const v = await loadVideo(file);
    if (state.video) URL.revokeObjectURL(state.video.src);
    state.file = file; state.video = v; state.ranOnce = false;
    clearGallery();
    const player = $('video');
    player.src = v.src;
    $('start').value = 0;
    $('end').value = v.duration.toFixed(2);
    $('start').max = $('end').max = v.duration.toFixed(2);
    $('meta').textContent = `${(file.size / 1e6).toFixed(1)} MB`;
    $('fileChipText').textContent = file.name;
    $('fileChip').classList.add('has');
    updateHints();
    goStep(2);
  } catch (e) { showError(e.message); }
}

// ---------- wizard navigation ----------
const STEPS = {
  1: { title: 'Upload video', crumb: 'Convert / Step 1 of 4' },
  2: { title: 'Choose frames', crumb: 'Convert / Step 2 of 4' },
  3: { title: 'HD quality', crumb: 'Convert / Step 3 of 4' },
  4: { title: 'Download', crumb: 'Convert / Step 4 of 4' },
  info: { title: 'Help', crumb: 'Help / Privacy, AI and speed' },
};
state.step = 1;

function canGo(n) {
  if (n === 1 || n === 'info') return true;
  if (!state.video) return false;
  if (n === 4) return state.ranOnce;
  return true;
}

function goStep(n, { scrollTo } = {}) {
  if (!canGo(n)) return;
  state.step = n;
  document.querySelectorAll('.step').forEach(s => { s.hidden = String(s.dataset.step) !== String(n); });
  $('pageTitle').textContent = STEPS[n].title;
  $('pageCrumb').textContent = STEPS[n].crumb;
  document.querySelectorAll('[data-show]').forEach(b => { b.hidden = String(b.dataset.show) !== String(n) || (b.id === 'run' && state.running); });
  $('backBtn').hidden = !(n === 2 || n === 3 || n === 4 || n === 'info');
  $('stats').hidden = !(state.video && (n === 2 || n === 3 || n === 4));
  document.querySelectorAll('.side-item[data-nav]').forEach(it => {
    const k = +it.dataset.nav;
    it.classList.toggle('active', k === n);
    it.classList.toggle('done', typeof n === 'number' && k < n);
    it.disabled = !canGo(k);
  });
  document.querySelectorAll('.side-item[data-info]').forEach(it => it.classList.toggle('active', n === 'info' && it.dataset.info === scrollTo));
  updateStats();
  closeMenu();
  if (scrollTo) $('info-' + scrollTo)?.closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  else window.scrollTo({ top: 0 });
}

let lastStep = 1;
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => goStep(+b.dataset.go)));
// (dataset is read on each click, so the empty-state button can retarget itself)
document.querySelectorAll('.side-item[data-nav]').forEach(b => b.addEventListener('click', () => goStep(+b.dataset.nav)));
document.querySelectorAll('.side-item[data-info]').forEach(b => b.addEventListener('click', () => {
  if (state.step !== 'info') lastStep = state.step;
  goStep('info', { scrollTo: b.dataset.info });
}));
$('backBtn').addEventListener('click', () => {
  if (state.step === 'info') return goStep(lastStep);
  goStep(Math.max(1, state.step - 1));
});

// mobile menu
function closeMenu() { $('sidebar').classList.remove('open'); $('scrim').hidden = true; }
$('menuBtn').addEventListener('click', () => { $('sidebar').classList.add('open'); $('scrim').hidden = false; });
$('scrim').addEventListener('click', closeMenu);

// theme toggle (remembered per browser; works without storage too)
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('themeBtn').querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
}
try { applyTheme(localStorage.getItem('fl-theme')); } catch { applyTheme(null); }
$('themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('fl-theme', next); } catch { /* ignore */ }
});

// Testing / linking: ?video=<same-origin url>
const qs = new URLSearchParams(location.search);
if (qs.get('video')) {
  fetch(qs.get('video')).then(r => r.blob()).then(b => openFile(new File([b], qs.get('video').split('/').pop(), { type: b.type })));
}

// ---------- settings ----------
const settingIds = ['every', 'count', 'fps', 'start', 'end', 'maxFrames', 'quality', 'skipBlurry', 'dedupe', 'bestFrame'];
settingIds.forEach(id => $(id).addEventListener('input', updateHints));
document.querySelectorAll('input[name=mode], input[name=scale], input[name=model], input[name=format]')
  .forEach(r => r.addEventListener('change', updateHints));
const radio = name => document.querySelector(`input[name=${name}]:checked`).value;
$('setStart').addEventListener('click', () => { $('start').value = $('video').currentTime.toFixed(2); updateHints(); });
$('setEnd').addEventListener('click', () => { $('end').value = $('video').currentTime.toFixed(2); updateHints(); });

function readSettings() {
  const v = state.video;
  const start = clamp(+$('start').value || 0, 0, v.duration);
  const end = clamp(+$('end').value || v.duration, start, v.duration);
  return {
    mode: radio('mode'),
    every: +$('every').value || 1, count: Math.round(+$('count').value || 1), fps: +$('fps').value || 30,
    start, end, maxFrames: clamp(Math.round(+$('maxFrames').value || 60), 1, 1000),
    scale: +radio('scale'), model: radio('model'),
    format: radio('format'), quality: +$('quality').value / 100,
    skipBlurry: $('skipBlurry').checked, dedupe: $('dedupe').value, bestFrame: $('bestFrame').checked,
  };
}

function effectiveScale(s) {
  const v = state.video;
  let scale = s.scale;
  while (scale > 1 && Math.max(v.videoWidth, v.videoHeight) * scale > MAX_OUTPUT_SIDE) scale /= 2;
  return scale;
}

function updateHints() {
  if (!state.video) return;
  const s = readSettings();
  document.querySelectorAll('[data-mode]').forEach(el => { el.hidden = el.dataset.mode !== s.mode; });
  $('qualityWrap').hidden = s.format === 'png';
  $('qualityVal').textContent = Math.round(s.quality * 100);
  const plan = planTimestamps(s);
  $('planHint').textContent = `${plan.timestamps.length} frame${plan.timestamps.length === 1 ? '' : 's'} will be extracted` +
    (plan.truncated ? ` (capped from ${plan.total}; raise “Max frames” for more)` : '') +
    (s.skipBlurry || s.dedupe !== 'off' ? ', then blurry/duplicate ones are skipped before upscaling.' : '.');
  const v = state.video, eff = effectiveScale(s);
  const hint = $('sizeHint');
  hint.classList.toggle('warn', eff !== s.scale);
  hint.textContent = s.scale === 1
    ? `Images will be saved at the original ${v.videoWidth}×${v.videoHeight}.`
    : eff !== s.scale
      ? `${s.scale}× would exceed ${MAX_OUTPUT_SIDE}px, so ${eff === 1 ? 'upscaling is skipped' : eff + '× is used'}: ${v.videoWidth * eff}×${v.videoHeight * eff}.`
      : `Each image: ${v.videoWidth}×${v.videoHeight} → ${v.videoWidth * eff}×${v.videoHeight * eff}.`;
  document.querySelectorAll('[data-size]').forEach(el => {
    const k = +el.dataset.size; el.textContent = `${v.videoWidth * k}×${v.videoHeight * k}`;
  });
  $('modelWrap').style.opacity = s.scale === 1 ? .5 : 1;
  $('modelNote').textContent = s.scale === 1 ? 'Not used at original size.'
    : { balanced: 'Real-ESRGAN General: cleans compression blocks and noise. Fast.', max: 'Real-ESRGAN x4plus: richest texture, about 10× slower, 67 MB download.' }[s.model]
      + (s.model === 'max' && currentBackend() === 'wasm' ? ' Without WebGPU this takes minutes per frame.' : '');
  $('formatNote').textContent = { png: 'PNG is lossless: best quality, larger files.', jpg: 'JPG is smaller; great for sharing.', webp: 'WebP is small and modern; not every app opens it.' }[s.format];
  updateStats();
}

// Dashboard stat cards
function setStat(i, label, value, sub) {
  $(`s${i}l`).textContent = label; $(`s${i}v`).textContent = value; $(`s${i}s`).innerHTML = sub || '';
}
function updateStats() {
  const v = state.video; if (!v) return;
  if (state.step === 4) {
    const done = state.frames.filter(f => f.status === 'done');
    const skipped = state.frames.filter(f => f.status === 'skipped').length;
    const total = done.reduce((a, f) => a + f.result.size, 0);
    const run = window.__lastRun;
    const upscaled = done[0] && done[0].outW > done[0].width;
    setStat(1, 'Ready', String(done.length), `${upscaled ? '<span class="chip">HD</span> ' : ''}of ${state.frames.length} extracted`);
    setStat(2, 'Skipped', String(skipped), skipped ? 'blurry or duplicate' : 'none');
    setStat(3, 'Speed', run?.avgMs >= 50 ? `${(run.avgMs / 1000).toFixed(1)} s` : run ? '< 0.1 s' : state.running ? '…' : 'Not yet', upscaled || state.running ? 'per frame (AI)' : 'per frame');
    setStat(4, 'Total size', total ? fmtBytes(total) : '0 KB', done[0] ? `${done[0].outW}×${done[0].outH} each` : '');
    return;
  }
  const s = readSettings(), eff = effectiveScale(s), plan = planTimestamps(s);
  setStat(1, 'Source', `${v.videoWidth}×${v.videoHeight}`, resLabel(v.videoHeight));
  setStat(2, 'Duration', fmtTime(v.duration), `${fmtTime(s.start)} – ${fmtTime(s.end)} selected`);
  setStat(3, 'Frames', String(plan.timestamps.length), plan.truncated ? `<span class="chip warn">capped</span> of ${plan.total}` : 'before skipping');
  setStat(4, 'Output', `${v.videoWidth * eff}×${v.videoHeight * eff}`, eff > 1 ? `<span class="chip accent">${eff}× AI</span> ${resLabel(v.videoHeight * eff)}` : 'original size');
}
function resLabel(h) { return h >= 4320 ? '8K' : h >= 2160 ? '4K' : h >= 1440 ? '1440p' : h >= 1080 ? 'Full HD' : h >= 720 ? 'HD' : 'SD'; }
function fmtBytes(b) { return b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB'; }

// ---------- pipeline ----------
$('run').addEventListener('click', () => run());
$('grabNow').addEventListener('click', () => run({ single: $('video').currentTime }));
$('cancel').addEventListener('click', () => state.abort?.abort());

async function run({ single } = {}) {
  if (state.running || !state.video) return;
  showError(null);
  const s = readSettings();
  const scale = effectiveScale(s);
  const plan = single != null ? { timestamps: [single] } : planTimestamps(s);
  const ac = new AbortController(); state.abort = ac;
  window.__lastRun = null; state.lastError = null;
  state.ranOnce = true;
  setRunning(true);
  goStep(4);
  // A manual capture adds to the gallery; a batch run starts fresh.
  if (single == null || !state.frames.length) clearGallery();
  const indexBase = single != null ? state.frames.length : 0;
  const t0 = performance.now();
  try {
    // 1) extract at native resolution, picking the sharpest frame near each timestamp
    const v = state.video;
    v.pause();
    const gap = plan.timestamps.length > 1 ? plan.timestamps[1] - plan.timestamps[0] : Infinity;
    const win = single != null || !s.bestFrame || s.mode === 'all' ? 0 : Math.min(0.25, gap / 2.5);
    const frames = [];
    for (let i = 0; i < plan.timestamps.length; i++) {
      if (ac.signal.aborted) throw abortErr();
      const t = plan.timestamps[i];
      setStatus(`${win ? 'Finding the sharpest frame' : 'Extracting frame'} ${i + 1} / ${plan.timestamps.length}`, (i / plan.timestamps.length) * 0.2);
      let at = t;
      try { at = await seekSharpest(v, t, win); } catch { await seekTo(v, t + 0.01); at = t + 0.01; } // one retry slightly later
      const canvas = drawFrame(v);
      const f = {
        index: indexBase + i, time: at, width: canvas.width, height: canvas.height,
        analysis: analyze(canvas),
        source: await canvasToBlob(canvas, 'image/png'),
        thumb: await thumbBlob(canvas),
        result: null, status: 'queued',
      };
      frames.push(f);
      addCard(f);
    }
    state.frames = single != null ? state.frames.concat(frames) : frames;

    // 2) skip blurry / duplicates (not for a single manual capture)
    const kept = single != null ? frames : filterFrames(frames, s);
    frames.forEach(f => { if (f.skipReason) { f.status = 'skipped'; updateCard(f); } });

    // 3) upscale + encode
    const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[s.format];
    let firstMs = null, upMsTotal = 0;
    const tUp0 = performance.now();
    for (let k = 0; k < kept.length; k++) {
      if (ac.signal.aborted) throw abortErr();
      const f = kept[k];
      f.status = 'working'; updateCard(f);
      const base = 0.2 + (k / kept.length) * 0.8;
      const perFrame = k ? (performance.now() - tUp0) / k : 0;
      const eta = k ? `. ${(perFrame / 1000).toFixed(1)} s per frame, about ${fmtTime(perFrame * (kept.length - k) / 1000)} left` : '';
      setStatus(`${scale > 1 ? 'Upscaling' : 'Encoding'} frame ${k + 1} / ${kept.length}${eta}`, base);
      const bmp = await createImageBitmap(f.source);
      const t1 = performance.now();
      let out;
      if (scale > 1) {
        const opts = {
          modelKey: s.model, scale, signal: ac.signal,
          onProgress: p => { setCardProgress(f, p); setStatus(`Upscaling frame ${k + 1} / ${kept.length}: ${Math.round(p * 100)}%${eta}`, base + (p * 0.8) / kept.length); },
        };
        try {
          out = await upscaleImage(bmp, opts);
        } catch (e) {
          if (e.name === 'AbortError' || !isGpuError(e) || !(await fallbackBackend())) throw e;
          console.warn('GPU backend failed, switched to', currentBackend(), e);
          showGpuInfo();
          out = await upscaleImage(bmp, opts);
        }
      } else {
        out = resizeImage(bmp, 1);
      }
      bmp.close();
      f.result = await canvasToBlob(out, mime, s.format === 'png' ? undefined : s.quality);
      f.outW = out.width; f.outH = out.height; f.ext = s.format;
      out.width = out.height = 0; // free canvas memory
      f.status = 'done'; updateCard(f);
      const ms = performance.now() - t1;
      if (firstMs == null) firstMs = ms;
      upMsTotal += ms;
    }
    const skipped = frames.length - kept.length;
    const avg = kept.length && scale > 1 ? ` (${(upMsTotal / kept.length / 1000).toFixed(1)} s per frame)` : '';
    setStatus(`Done: ${kept.length} ${scale > 1 ? 'HD ' : ''}image${kept.length === 1 ? '' : 's'}${skipped ? `, ${skipped} skipped (turn on “Show skipped” to see them)` : ''} in ${fmtTime((performance.now() - t0) / 1000)}${avg}.`, 1);
    window.__lastRun = { kept: kept.length, skipped, avgMs: kept.length ? upMsTotal / kept.length : 0, firstMs };
  } catch (e) {
    if (e.name === 'AbortError') setStatus('Cancelled. Finished frames are still available below.', null);
    else { console.error(e); state.lastError = friendlyError(e); showError(state.lastError); }
  } finally {
    setRunning(false);
    $('zipBtn').disabled = !state.frames.some(f => f.result);
    updateStats();
    updateEmpty();
  }
}

function isGpuError(e) { return /shader|context|webgl|webgpu|gpu|program|link|fenceSync|device|backend|validation/i.test(String(e?.message || e)); }

function friendlyError(e) {
  if (isGpuError(e)) return 'Your browser’s GPU backend failed (' + String(e.message).slice(0, 80) + '). Try updating your browser or graphics driver, or use Chrome/Edge.';
  const m = String(e.message || e);
  if (/memory|OOM|allocate|context lost/i.test(m)) return 'The GPU ran out of memory. Try 2× instead of 4×, the Fast model, or a lower-resolution video.';
  if (/load|fetch|network/i.test(m)) return 'Could not download the AI model. Check your internet connection (the model is fetched once from a public CDN).';
  return 'Something went wrong: ' + m;
}

// ---------- gallery ----------
const gallery = $('gallery');
$('showSkipped').addEventListener('change', () => gallery.classList.toggle('hide-skipped', !$('showSkipped').checked));
gallery.classList.add('hide-skipped');

function clearGallery() {
  state.frames.forEach(f => { if (f.thumbUrl) URL.revokeObjectURL(f.thumbUrl); });
  state.frames = []; gallery.innerHTML = '';
  $('results').hidden = false; $('zipBtn').disabled = true; updateEmpty();
}

function addCard(f) {
  f.thumbUrl = URL.createObjectURL(f.thumb);
  const el = document.createElement('div');
  el.className = 'frame'; el.id = 'f' + f.index;
  el.innerHTML = `<img alt="Frame at ${fmtTime(f.time, true)}" src="${f.thumbUrl}"><div class="fbar"><div></div></div>
    <div class="info"><span>${fmtTime(f.time, true)}</span><span class="state">Queued</span>
    <button class="btn small dl" disabled>Save</button></div>`;
  el.querySelector('img').addEventListener('click', () => openCompare(f));
  el.querySelector('.dl').addEventListener('click', () => f.result && saveBlob(f.result, fileName(f)));
  gallery.appendChild(el);
  updateResultsTitle();
}

function updateCard(f) {
  const el = $('f' + f.index); if (!el) return;
  const st = el.querySelector('.state');
  el.classList.toggle('skipped', f.status === 'skipped');
  st.className = 'state' + (f.status === 'done' ? ' ok' : f.status === 'skipped' ? ' skip' : '');
  st.textContent = f.status === 'done' ? `${f.outW}×${f.outH}` : f.status === 'skipped' ? `Skipped (${f.skipReason})` : f.status === 'working' ? 'Working…' : 'Queued';
  el.querySelector('.dl').disabled = !f.result;
  if (f.status === 'done') setCardProgress(f, 1);
  updateResultsTitle();
  updateStats();
}

function setCardProgress(f, p) { const b = document.querySelector(`#f${f.index} .fbar > div`); if (b) b.style.transform = `scaleX(${p})`; }

function updateEmpty() {
  const done = state.frames.filter(f => f.status === 'done').length;
  const el = $('emptyState');
  let show = false, title = '', text = '', action = null;
  if (!state.running && !state.frames.length) {
    show = true; title = 'No images yet'; text = 'Choose your frames and quality, then convert.'; action = ['Choose frames', 2];
  } else if (!state.running && !done && state.lastError) {
    show = true; title = 'Conversion stopped'; text = state.lastError; action = ['Change settings', 3];
  } else if (!state.running && !done && state.frames.length && state.frames.every(f => f.status === 'skipped')) {
    show = true; title = 'Every frame was skipped'; text = 'They all looked blurry or duplicated. Turn the filters down and try again.'; action = ['Change frame settings', 2];
  }
  el.hidden = !show;
  if (show) {
    $('emptyTitle').textContent = title; $('emptyText').textContent = text;
    $('emptyAction').textContent = action[0]; $('emptyAction').dataset.go = action[1];
  }
}

function updateResultsTitle() {
  const done = state.frames.filter(f => f.status === 'done').length;
  const skipped = state.frames.filter(f => f.status === 'skipped').length;
  $('resultsTitle').textContent = `HD images: ${done} ready${skipped ? `, ${skipped} skipped` : ''}`;
  updateEmpty();
}

// ---------- before / after ----------
const dlg = $('compare');
{
  const after = document.createElement('img'); after.id = 'cmpAfter'; after.alt = 'HD version';
  const before = document.createElement('img'); before.id = 'cmpBefore'; before.alt = 'Original frame';
  $('compareStage').prepend(after); $('cmpBeforeWrap').append(before);
  // drag anywhere on the image to move the split (the range below stays for keyboard users)
  const stage = $('compareStage');
  const fromPointer = e => { const r = stage.getBoundingClientRect(); const v = clamp(((e.clientX - r.left) / r.width) * 100, 0, 100); $('cmpSlider').value = v; setSplit(v); };
  stage.addEventListener('pointerdown', e => { stage.setPointerCapture(e.pointerId); fromPointer(e); });
  stage.addEventListener('pointermove', e => { if (stage.hasPointerCapture(e.pointerId)) fromPointer(e); });
}
let cmpUrls = [];
async function openCompare(f) {
  cmpUrls.forEach(u => URL.revokeObjectURL(u)); cmpUrls = [];
  const before = URL.createObjectURL(f.source), after = URL.createObjectURL(f.result || f.source);
  cmpUrls = [before, after];
  $('cmpBefore').src = before; $('cmpAfter').src = after;
  $('compareTitle').textContent = `Frame at ${fmtTime(f.time, true)}: original ${f.width}×${f.height}` + (f.result && f.outW > f.width ? `, HD ${f.outW}×${f.outH}` : '');
  const dl = $('compareDl');
  dl.hidden = !f.result; if (f.result) { dl.href = after; dl.download = fileName(f); }
  dlg.showModal();
  await $('cmpAfter').decode().catch(() => {});
  sizeBefore(); setSplit($('cmpSlider').value);
}
function sizeBefore() { const a = $('cmpAfter'); $('cmpBefore').style.width = a.clientWidth + 'px'; $('cmpBefore').style.height = a.clientHeight + 'px'; }
function setSplit(v) { $('cmpBeforeWrap').style.width = v + '%'; }
$('cmpSlider').addEventListener('input', e => setSplit(e.target.value));
$('compareClose').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
window.addEventListener('resize', () => dlg.open && sizeBefore());

// ---------- ZIP ----------
$('zipBtn').addEventListener('click', async () => {
  const done = state.frames.filter(f => f.result);
  if (!done.length) return;
  const btn = $('zipBtn'); btn.disabled = true;
  const label = btn.innerHTML;
  try {
    const parts = []; let cur = [], bytes = 0;
    for (const f of done) {
      if (cur.length && bytes + f.result.size > ZIP_PART_BYTES) { parts.push(cur); cur = []; bytes = 0; }
      cur.push(f); bytes += f.result.size;
    }
    if (cur.length) parts.push(cur);
    const baseName = (state.file?.name || 'video').replace(/\.[^.]+$/, '');
    for (let p = 0; p < parts.length; p++) {
      const zip = new JSZip();
      // images are already compressed; STORE avoids wasting CPU
      parts[p].forEach(f => zip.file(fileName(f), f.result, { compression: 'STORE' }));
      btn.textContent = `Zipping${parts.length > 1 ? ` part ${p + 1}/${parts.length}` : ''}…`;
      const blob = await zip.generateAsync({ type: 'blob', streamFiles: true });
      saveBlob(blob, `${baseName}-hd-frames${parts.length > 1 ? `-part${p + 1}` : ''}.zip`);
    }
  } finally { btn.innerHTML = label; btn.disabled = false; }
});

// ---------- helpers ----------
function fileName(f) {
  const base = (state.file?.name || 'frame').replace(/\.[^.]+$/, '');
  return `${base}_${String(f.index + 1).padStart(4, '0')}_${fmtTime(f.time, true).replace(/[:.]/g, '-')}_${f.outW}x${f.outH}.${f.ext || 'png'}`;
}
function saveBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
async function thumbBlob(canvas) {
  const w = 400, h = Math.round(canvas.height / canvas.width * w);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(canvas, 0, 0, w, h);
  return canvasToBlob(c, 'image/jpeg', 0.8);
}
function setRunning(on) {
  state.running = on;
  $('cancel').hidden = !on;
  ['grabNow', 'changeVideo', 'setStart', 'setEnd', 'newVideoBtn'].forEach(id => $(id).disabled = on);
  document.querySelectorAll('.side-item[data-nav]').forEach(it => { if (+it.dataset.nav !== 4) it.disabled = on || !canGo(+it.dataset.nav); });
}
function setStatus(text, p) { $('status').textContent = text; if (p != null) $('bar').style.transform = `scaleX(${clamp(p, 0, 1)})`; }
function showError(msg) { const e = $('error'); e.hidden = !msg; e.textContent = msg || ''; }
function abortErr() { return new DOMException('Cancelled', 'AbortError'); }
function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
function fmtTime(sec, precise) {
  sec = Math.max(0, sec); const m = Math.floor(sec / 60), s = sec - m * 60;
  return precise ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

// Show which GPU the browser picked (helps users with dual-GPU laptops).
function showGpuInfo() {
  initBackend().then(({ backend, gpu }) => {
    const cpu = backend === 'cpu';
    $('gpuInfo').textContent = cpu
      ? 'WebGPU is not available in this browser, so the AI runs on the CPU and is slow. Use a current Chrome or Edge with hardware acceleration on.'
      : `This browser is using: ${gpu || 'unknown GPU'} (${backend}).`;
    $('gpuName').textContent = cpu ? 'No WebGPU available' : shortGpu(gpu) || 'GPU';
    $('gpuName').title = gpu || '';
    $('gpuBackend').textContent = cpu ? 'AI runs on the CPU (slow)' : 'WebGPU, on this device';
    document.querySelector('.side-card').classList.toggle('warn', cpu);
  }).catch(() => {});
}
// "ANGLE (Intel, Intel(R) UHD Graphics (0x00009BC4) Direct3D11 ...)" -> "Intel UHD Graphics"
function shortGpu(g) {
  if (!g) return '';
  const m = g.match(/ANGLE \([^,]+,\s*([^(,]+?)(?:\s*\(0x|\s*Direct3D|,|\))/);
  return (m ? m[1] : g).replace(/\((R|TM)\)/g, '').replace(/\s+/g, ' ').trim();
}
showGpuInfo();
goStep(1);

window.__app = { state, readSettings }; // for debugging/tests
