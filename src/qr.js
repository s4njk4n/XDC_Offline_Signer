// QR display and camera scanning. Works without any network access.
import qrcode from "qrcode-generator";
import jsQR from "jsqr";

// Draws `text` as a QR code into a canvas. Returns the canvas.
export function qrCanvas(text, { ecc = "M", px = 8 } = {}) {
  const q = qrcode(0, ecc);
  q.addData(text, "Byte");
  q.make();
  const n = q.getModuleCount(), quiet = 4, size = (n + quiet * 2) * px;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, size, size);
  g.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
    if (q.isDark(r, c)) g.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
  cv.className = "qr";
  cv.setAttribute("role", "img");
  cv.setAttribute("aria-label", "QR code");
  cv.dataset.modules = n;
  return cv;
}

export function showQR(container, text, opts) {
  container.replaceChildren(qrCanvas(text, opts));
}

function decodeFrame(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h);
  const r = jsQR(img.data, w, h, { inversionAttempts: "attemptBoth" });
  return r && r.data ? r.data : null;
}

// Camera scanner. onResult(text) returns true to stop scanning, false to keep going.
export class Scanner {
  constructor(video, { onResult, onError, onState } = {}) {
    this.video = video; this.onResult = onResult; this.onError = onError || (() => {}); this.onState = onState || (() => {});
    this.stream = null; this.running = false; this.deviceId = null;
    this.cv = document.createElement("canvas");
    this.ctx = this.cv.getContext("2d", { willReadFrequently: true });
  }
  async cameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  }
  async start(deviceId) {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      this.onError(new Error("this browser cannot use a camera here. If you opened the file directly, try Chrome or Firefox, or serve it from localhost (see the README)."));
      return;
    }
    const video = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      const m = e && e.name === "NotAllowedError" ? "camera permission was refused. Allow camera access for this page and try again."
        : e && e.name === "NotFoundError" ? "no camera was found."
        : "could not start the camera (" + (e && e.message || e) + ").";
      this.onError(new Error(m));
      return;
    }
    this.deviceId = deviceId || this.stream.getVideoTracks()[0]?.getSettings?.().deviceId || null;
    this.video.srcObject = this.stream;
    this.video.setAttribute("playsinline", ""); this.video.muted = true;
    await this.video.play().catch(() => {});
    this.running = true; this.onState(true);
    let last = 0, pass = 0;
    // Each frame is tried in a different way: QR decoding is sensitive to scale, so cycle
    // through the whole frame at two sizes and a full-resolution crop of the centre (the reticle).
    const views = [
      (vw, vh) => ({ sx: 0, sy: 0, sw: vw, sh: vh, max: 1024 }),
      (vw, vh) => { const s = Math.round(Math.min(vw, vh) * 0.85); return { sx: (vw - s) >> 1, sy: (vh - s) >> 1, sw: s, sh: s, max: 1200 }; },
      (vw, vh) => ({ sx: 0, sy: 0, sw: vw, sh: vh, max: 720 }),
    ];
    const tick = (t) => {
      if (!this.running) return;
      if (t - last > 100 && this.video.readyState >= 2) {
        last = t;
        const vw = this.video.videoWidth, vh = this.video.videoHeight;
        if (vw && vh) {
          const v = views[pass++ % views.length](vw, vh);
          const scale = Math.min(1, v.max / Math.max(v.sw, v.sh));
          const w = Math.round(v.sw * scale), h = Math.round(v.sh * scale);
          this.cv.width = w; this.cv.height = h;
          this.ctx.drawImage(this.video, v.sx, v.sy, v.sw, v.sh, 0, 0, w, h);
          const text = decodeFrame(this.ctx, w, h);
          if (text && this.onResult(text)) { this.stop(); return; }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  stop() {
    this.running = false;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.onState(false);
  }
}

// Decode a QR code from a still image (photo or screenshot).
export function scanImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      const t = decodeFrame(ctx, w, h);
      t ? resolve(t) : reject(new Error("no QR code found in that image"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("could not read that image")); };
    img.src = url;
  });
}
