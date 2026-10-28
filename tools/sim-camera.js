// Simulated camera for testing image tracking without a phone.
//
// Replaces navigator.mediaDevices.getUserMedia with a canvas stream that shows a
// target image on a textured "desk", with per-frame sensor noise and optional
// hand-shake motion. The exact on-camera corners of the target are published on
// window.__sim.corners so tests can measure overlay error in pixels.
//
// Query params:
//   simsrc=<url>        image or video to show (video: first frame is used)
//   simmotion=static|shake|pan|handheld   (default static; handheld adds 3D tilt,
//                       distance changes, tremor and motion blur)
//   simres=1280x720     camera resolution
//   simnoise=0..1       sensor noise strength (default 0.35)
//   simscale=0..1       target height as a fraction of the frame (default 0.55)
(() => {
  const params = new URLSearchParams(location.search);
  const [W, H] = (params.get("simres") || "1280x720").split("x").map(Number);
  const src = params.get("simsrc");
  const motion = params.get("simmotion") || "static";
  const noiseLevel = Number(params.get("simnoise") ?? 0.35);
  const targetScale = Number(params.get("simscale") ?? 0.55);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Pre-render a few noise frames to keep the draw loop cheap.
  const noiseFrames = Array.from({ length: 6 }, () => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const nctx = c.getContext("2d");
    const img = nctx.createImageData(W, H);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    nctx.putImageData(img, 0, 0);
    return c;
  });

  const desk = document.createElement("canvas");
  desk.width = W;
  desk.height = H;
  {
    const d = desk.getContext("2d");
    d.fillStyle = "#6b6258";
    d.fillRect(0, 0, W, H);
    for (let i = 0; i < 4000; i++) {
      d.fillStyle = `rgba(${Math.random() < 0.5 ? "0,0,0" : "255,255,255"},${Math.random() * 0.08})`;
      d.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 30, 1 + Math.random() * 3);
    }
  }

  let target = null;
  const loadTarget = async () => {
    if (!src) throw new Error("simsrc is required");
    if (/\.(mp4|webm|mov)(\?|$)/i.test(src)) {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.crossOrigin = "anonymous";
      v.src = src;
      await new Promise((res, rej) => {
        v.addEventListener("loadeddata", res, { once: true });
        v.addEventListener("error", () => rej(new Error("sim video failed")), { once: true });
      });
      v.currentTime = 0.001;
      await new Promise((res) => v.addEventListener("seeked", res, { once: true }));
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0);
      return c;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    await img.decode();
    return img;
  };

  const sim = (window.__sim = { corners: null, frame: 0, ready: false, width: W, height: H });

  // Seeded-ish smooth random walk for hand shake.
  let shake = { x: 0, y: 0, r: 0, vx: 0, vy: 0, vr: 0 };
  const step = (t) => {
    const tw = target.width || target.naturalWidth;
    const th = target.height || target.naturalHeight;
    const scale = Math.min((H * targetScale) / th, (W * 0.9) / tw);
    let cx = W / 2;
    let cy = H / 2;
    let rot = 0.06;
    let yaw = 0; // rotation of the print away from the camera, radians
    let dist = 1; // relative distance (1 = base size)
    if (motion === "handheld") {
      // Realistic phone use: slow drift + tilt + distance change + tremor.
      shake.vx = shake.vx * 0.8 + (Math.random() - 0.5) * 2.2;
      shake.vy = shake.vy * 0.8 + (Math.random() - 0.5) * 2.2;
      shake.vr = shake.vr * 0.8 + (Math.random() - 0.5) * 0.003;
      shake.x = (shake.x + shake.vx) * 0.95;
      shake.y = (shake.y + shake.vy) * 0.95;
      shake.r = (shake.r + shake.vr) * 0.95;
      cx += Math.sin(t / 1700) * W * 0.08 + shake.x;
      cy += Math.cos(t / 2300) * H * 0.04 + shake.y;
      rot += Math.sin(t / 2900) * 0.1 + shake.r;
      yaw = Math.sin(t / 2100) * 0.45; // up to ~26 degrees
      dist = 1 + Math.sin(t / 3100) * 0.18;
    } else if (motion === "shake") {
      shake.vx = shake.vx * 0.85 + (Math.random() - 0.5) * 1.6;
      shake.vy = shake.vy * 0.85 + (Math.random() - 0.5) * 1.6;
      shake.vr = shake.vr * 0.85 + (Math.random() - 0.5) * 0.002;
      shake.x = (shake.x + shake.vx) * 0.97;
      shake.y = (shake.y + shake.vy) * 0.97;
      shake.r = (shake.r + shake.vr) * 0.97;
      cx += shake.x;
      cy += shake.y;
      rot += shake.r;
    } else if (motion === "pan") {
      cx += Math.sin(t / 1400) * W * 0.12;
      cy += Math.cos(t / 1900) * H * 0.05;
      rot += Math.sin(t / 2300) * 0.12;
    }

    // Pinhole projection of the print rotated by `yaw` about its vertical axis.
    // Each image column is drawn as a vertical strip with its own depth, which
    // is exact for yaw (vertical lines stay vertical). f is chosen so that the
    // un-tilted print appears at `scale`.
    const f = 1000;
    const z0 = (f / scale) * dist;
    const project = (u, v) => {
      const z = z0 + u * Math.sin(yaw);
      return [(f * u * Math.cos(yaw)) / z, (f * v) / z];
    };

    // Motion blur: blend a little of the previous frame when moving.
    if (motion === "handheld" && sim.frame > 0) {
      ctx.globalAlpha = 0.35;
      ctx.drawImage(canvas, (shake.vx * 0.5) | 0, (shake.vy * 0.5) | 0);
      ctx.globalAlpha = 1;
    }
    if (!(motion === "handheld" && sim.frame > 0)) ctx.drawImage(desk, 0, 0);
    else {
      ctx.globalAlpha = 0.65;
      ctx.drawImage(desk, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    const strips = yaw === 0 ? 1 : 96;
    for (let i = 0; i < strips; i++) {
      const u0 = -tw / 2 + (tw * i) / strips;
      const u1 = -tw / 2 + (tw * (i + 1)) / strips;
      const [x0, y0] = project(u0, -th / 2);
      const [x1] = project(u1, -th / 2);
      const [, y0b] = project(u0, th / 2);
      // +0.6px overlap hides seams between strips
      ctx.drawImage(target, (tw * i) / strips, 0, tw / strips, th, x0, y0, x1 - x0 + 0.6, y0b - y0);
    }
    ctx.restore();
    if (noiseLevel > 0) {
      ctx.globalAlpha = noiseLevel * 0.25;
      ctx.globalCompositeOperation = "overlay";
      ctx.drawImage(noiseFrames[sim.frame % noiseFrames.length], 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    // TL, TR, BR, BL in camera pixels
    sim.corners = [
      [-tw / 2, -th / 2],
      [tw / 2, -th / 2],
      [tw / 2, th / 2],
      [-tw / 2, th / 2],
    ]
      .map(([u, v]) => project(u, v))
      .map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
    sim.frame++;
  };

  const ready = loadTarget().then((t) => {
    target = t;
    step(performance.now());
    // setInterval keeps running even when the tab is not focused.
    setInterval(() => step(performance.now()), 1000 / 30);
    sim.ready = true;
  });

  // Samples getCorners() every animation frame for `ms` and reports:
  //   errMean/errP95 – distance between drawn overlay corners and true image corners (px)
  //   wobbleMean/P95 – frame-to-frame change of that error vector: visible shaking relative to the image (px)
  //   coverage       – fraction of frames where the overlay was shown
  sim.measure = async (ms, getCorners) => {
    const samples = [];
    let frames = 0;
    const t0 = performance.now();
    await new Promise((done) => {
      const tick = () => {
        frames++;
        const s = getCorners();
        if (s) samples.push(s);
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    if (samples.length < 2) return { frames, samples: samples.length };
    const errs = [];
    const wobble = [];
    let prev = null;
    for (const s of samples) {
      const vec = s.drawn.map((p, i) => [p[0] - s.truth[i][0], p[1] - s.truth[i][1]]);
      vec.forEach(([x, y]) => errs.push(Math.hypot(x, y)));
      if (prev) wobble.push(vec.reduce((a, [x, y], i) => a + Math.hypot(x - prev[i][0], y - prev[i][1]), 0) / 4);
      prev = vec;
    }
    const q = (a, p) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const r = (v) => Math.round(v * 100) / 100;
    return {
      frames,
      coverage: r(samples.length / frames),
      errMean: r(mean(errs)),
      errP95: r(q(errs, 0.95)),
      wobbleMean: r(mean(wobble)),
      wobbleP95: r(q(wobble, 0.95)),
    };
  };

  const fakeGetUserMedia = async () => {
    await ready;
    return canvas.captureStream(30);
  };

  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
  }
  navigator.mediaDevices.getUserMedia = fakeGetUserMedia;
  console.info(`[sim-camera] active ${W}x${H} motion=${motion} src=${src}`);
})();
