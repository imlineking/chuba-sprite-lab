# Third-party notices

This list describes the current source packaging configuration. Previously distributed binaries can contain the older model set; their own notices remain applicable. Chuba Sprite Lab includes or uses the following third-party projects:

- [Electron](https://www.electronjs.org/) — MIT License.
- [Sharp](https://sharp.pixelplumbing.com/) and libvips — Apache-2.0 and their respective dependency licenses.
- [Python](https://www.python.org/), [NumPy](https://numpy.org/) and [Pillow](https://python-pillow.org/) — included locally for the Healing Tool; their license texts are copied into `resources/vendor/healing-runtime` during packaging.
- [FFmpeg](https://ffmpeg.org/) — distributed under the license applicable to the bundled build. FFmpeg is a separate project and is not owned by Hanuman Media Company.
- [electron-builder](https://www.electron.build/) — MIT License; used to produce release builds and not required as a separate end-user installation.
- [ONNX Runtime](https://onnxruntime.ai/) — MIT License; runs the included local models.
- [ToonOut](https://huggingface.co/joelseytre/toonout) and its [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) base — MIT; a pinned official ToonOut checkpoint is exported locally to ONNX. The full license is included as resources/models/ToonOut-LICENSE.txt. Export provenance, revision, size and SHA-256 are recorded in docs/TOONOUT.md.
- [LaMa](https://github.com/advimman/lama) — Apache-2.0; the portable demo includes the [sapienkit ONNX conversion](https://huggingface.co/sapienkit/LaMa-ONNX).
- [RIFE](https://github.com/hzwer/ECCV2022-RIFE) — MIT; the portable demo includes the [walterlow timestep ONNX conversion](https://huggingface.co/walterlow/RIFE_fp32_timestep).
- [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) — BSD-3-Clause; the included anime 6B [ONNX conversion](https://huggingface.co/mhmtaufiq/realesrgan-onnx) is distinct from the full x4plus weights.
- [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2) — the Small weights are Apache-2.0; the portable demo includes the [ONNX Community quantized Small conversion](https://huggingface.co/onnx-community/depth-anything-v2-small). Larger V2 weights are not included.

`resources/models/bundled-models.json` records exact export URLs, sizes and SHA-256 digests. These notices identify the included exports; the planned commercial distribution audit still needs the full component license texts and FFmpeg source/build provenance.

The complete license text and source-code availability requirements of each third-party component remain in force. Official FFmpeg sources and licensing information are available at [ffmpeg.org](https://ffmpeg.org/legal.html).

## Offline OCR

Tesseract.js 7.0.0 and tesseract.js-core (Apache-2.0): https://github.com/naptha/tesseract.js . Local English/Russian LSTM data from https://github.com/tesseract-ocr/tessdata_fast (Apache-2.0). The bundled vendor/ocr/LICENSE.txt and manifest record the licence and SHA-256 checksums. Runtime uses local language paths; images are not uploaded.
