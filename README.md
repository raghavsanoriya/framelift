# FrameLift: video to HD images

**Live:** <https://raghavsanoriya.github.io/framelift/>

Free, no-login web app that turns a video into **HD still images**:

1. **Extract** frames at the video's native resolution (lossless PNG, not screenshots).
2. **Filter**: skip blurry frames and near-duplicates *before* the slow step.
3. **Upscale** each kept frame with an AI super-resolution model (Real-ESRGAN) at 2× or 4×, after picking the sharpest frame near each moment.
4. **Download** single images or a ZIP.

Everything runs **inside the browser tab**. The video is never uploaded. The model files are served with the app (`models/`); the AI engine (onnxruntime-web, ~30 MB once, then cached) and JSZip come from jsDelivr.

## Run locally

Any static file server works (ES modules don't load from `file://`):

```powershell
python -m http.server 5500 --bind 127.0.0.1
```

Then open <http://localhost:5500>.

## Deploy

It's a static site, so you can host it free on GitHub Pages, Netlify or Vercel. Upload the folder as-is. There's no backend and no build step. Note: `models/realesrgan-x4plus.onnx` is 67 MB, over Cloudflare Pages' 25 MB per-file limit (host that file elsewhere or drop the Best detail option there).

## How it works

| Step | File | Notes |
|---|---|---|
| Decode + seek | `js/extract.js` | `<video>` seek → wait for `seeked` + `requestVideoFrameCallback` → `drawImage` at `videoWidth×videoHeight` |
| Frame modes | `js/extract.js` | every N seconds · N evenly spaced · every frame (with fps) · start/end range · max-frames cap |
| Blur / duplicate filter | `js/analyze.js` | Laplacian variance (relative to the clip's median) + 64-bit difference hash with Hamming distance |
| Best-frame picking | `js/extract.js` | For each timestamp, scores 5 frames within ±0.25 s (Laplacian variance) and keeps the sharpest, which dodges motion blur and the most compressed in-between frames |
| AI upscale | `js/upscale.js` | **Real-ESRGAN** (ONNX) on [onnxruntime-web](https://onnxruntime.ai) 1.31.1, WebGPU with a WASM (CPU) fallback. *Standard* = `realesr-general-x4v3` (4.9 MB), *Best detail* = `realesrgan-x4plus` (67 MB, loaded only when chosen). Trained on real-world degradations (blur, noise, JPEG), so compression blocks are cleaned instead of sharpened. Native 4×; 2× output = 4× inference + high-quality downscale per tile |
| Tiling | `js/upscale.js` | Frame is padded with replicated edges and cut into identical tiles (192 px, or 128 px for x4plus, plus 16 px overlap). Constant shape keeps the GPU pipeline warm; overlaps hide seams; memory stays bounded at 4× |
| Output | `js/app.js` | PNG / JPG / WebP (quality slider), before/after slider, ZIP via JSZip (STORE, split into ~1.5 GB parts) |

Output is capped at 8192 px on the long side; 4× automatically drops to 2× if it would exceed that.

## Performance tips

- The browser chooses the GPU. On laptops with integrated + dedicated GPUs, set your browser to **High performance** in *Windows Settings → System → Display → Graphics*. The app shows which GPU it's using at the bottom of the page.
- Keep the tab visible while processing. Browsers heavily throttle background tabs.
- Default is HD 2× with the Standard model. 4× and Best detail are much slower; Best detail needs WebGPU to be practical.

## Honest limits

- AI upscaling adds *plausible* detail; it can't recover detail that was never recorded. Check faces, small text and logos.
- Real-ESRGAN removes most compression blocking, but very low-bitrate video can still show some artifacts.
- Codecs depend on the browser: HEVC/H.265 and ProRes may not decode. Use H.264 MP4 or WebM.

## Credits

- Real-ESRGAN models © Xintao Wang et al., BSD-3-Clause. ONNX exports from [jonathanst29/tinier-upscale-models](https://huggingface.co/jonathanst29/tinier-upscale-models) (BSD-3-Clause).
