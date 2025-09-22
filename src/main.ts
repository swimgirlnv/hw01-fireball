import { vec3, vec4, vec2 } from "gl-matrix";
const Stats = require("stats-js");
import * as DAT from "dat.gui";

import Icosphere from "./geometry/Icosphere";
import Square from "./geometry/Square";
import OpenGLRenderer from "./rendering/gl/OpenGLRenderer";
import Camera from "./Camera";
import { setGL } from "./globals";
import ShaderProgram, { Shader } from "./rendering/gl/ShaderProgram";
import Drawable from "./rendering/gl/Drawable";

// ---------------- Defaults / Controls ----------------
const defaults = {
  tesselations: 5,
  shape: "icosphere" as "icosphere" | "square",

  // Core
  coreLowAmp: 0.26,
  coreHiAmp: 0.01,
  coreScale: 0.72,

  // Flames
  flameNoiseScale: 2.2,
  flameHiAmp: 0.24,
  flameLift: 0.26,
  octaves: 5,

  // Look
  bandCount: 7,
  grainAmp: 0.08,
  wash: 0.18,
  exposure: 0.45,
  coreHot: 0.55,

  // Geometry scales
  shellOffset: 0.2,
  glowOffsetMul: 1.6,
  sceneScale: 1.0,

  // Glow
  glowStrength: 0.9,

  // Up direction
  upTargetX: 0.0,
  upTargetY: 1.0,
  upTargetZ: 0.0,
  upCatchupTau: 0.25,

  // Mouse deformation
  mouseOn: true,
  mouseStrength: 0.9,
  mouseFalloff: 0.35,

  // Mode
  fireball: false,
};

const audioDefaults = {
  audioOn: true,
  gain: 1.0,
  smoothing: 0.7,
  sensitivity: 1.35, // beat sensitivity
  bassToFlameLift: 0.35,
  bassToGlow: 0.65,
  midToCoreLow: 0.25,
  trebleToGrainHi: 0.3,
  beatToExposure: 0.4,
};

type Controls = typeof defaults & typeof audioDefaults;
const controls: Controls = { ...defaults, ...audioDefaults };

let gui: DAT.GUI;
const folders: DAT.GUI[] = [];
let icosphere: Icosphere;
let square: Square;
let activeShape: Drawable | null = null;
let prevTess = defaults.tesselations;

// --- Fireball mode state ---
let fireballOn = false;

// YouTube
let ytApiReady = false;
let ytPlayer: any = null;
let ytContainer: HTMLDivElement | null = null;

// Audio capture + analyser
let tabStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let fft: Uint8Array | null = null;

// Fallback audio (mic / file)
let fileAudioEl: HTMLAudioElement | null = null;

// Simple audio levels
let aBass = 0,
  aMid = 0,
  aTre = 0,
  aBeat = 0;
let ema = 0; // rolling average for beat detect
let lastBeatT = 0;
const minBeatInterval = 0.26; // seconds

// === Simple mouse orbit state ===
const orbit = {
  dragging: false,
  lastX: 0,
  lastY: 0,
  yaw: 0, // radians
  pitch: 0.2, // radians
  radius: 8, // distance from origin
  minPitch: -1.4,
  maxPitch: 1.4,
  minRadius: 2.5,
  maxRadius: 50,
  rotateSpeed: 0.008,
  zoomSpeed: 0.25,
};

// lagged up vector
const upTarget = vec3.fromValues(
  defaults.upTargetX,
  defaults.upTargetY,
  defaults.upTargetZ
);
const upSmooth = vec3.clone(upTarget);

// Mouse NDC state (-1..1)
const mouseNDC = vec2.fromValues(0, 0);

// ---------------- Scene helpers ----------------
function setActiveShape(s: string) {
  activeShape = s === "square" ? square : icosphere;
}

// ---- Create YouTube background container (behind canvas) ----
function ensureYTBackground() {
  if (ytContainer) {
    ytContainer.style.display = "block";
    return;
  }
  ytContainer = document.createElement("div");
  ytContainer.id = "yt-bg";
  Object.assign(ytContainer.style, {
    position: "fixed",
    inset: "0",
    zIndex: "-1",
    overflow: "hidden",
    background: "black",
    pointerEvents: "none",
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(ytContainer);

  const wrap = document.createElement("div"); // 16:9 cover
  Object.assign(wrap.style, {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%,-50%)",
    width: "100vw",
    height: "56.25vw",
    minWidth: "177.77vh",
    minHeight: "100vh",
  } as Partial<CSSStyleDeclaration>);
  wrap.id = "yt-wrap";
  ytContainer.appendChild(wrap);
}

function loadYTAPI(): Promise<void> {
  return new Promise((resolve) => {
    if ((window as any).YT && (window as any).YT.Player) {
      ytApiReady = true;
      resolve();
      return;
    }
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    (window as any).onYouTubeIframeAPIReady = () => {
      ytApiReady = true;
      resolve();
    };
    document.head.appendChild(tag);
  });
}

async function startYouTube() {
  ensureYTBackground();
  await loadYTAPI();
  const wrap = document.getElementById("yt-wrap")!;
  wrap.innerHTML = ""; // reset
  ytPlayer = new (window as any).YT.Player(wrap, {
    width: "100%",
    height: "100%",
    videoId: "HMqgVXSvwGo",
    playerVars: {
      autoplay: 1,
      controls: 0,
      modestbranding: 1,
      rel: 0,
      showinfo: 0,
      loop: 1,
      playlist: "HMqgVXSvwGo",
      origin: window.location.origin,
    },
    events: {
      onReady: (e: any) => {
        try {
          e.target.setVolume(100);
        } catch {}
        try {
          e.target.playVideo();
        } catch {}
      },
    },
  });
}

function stopYouTube() {
  if (ytPlayer && ytPlayer.destroy) {
    try {
      ytPlayer.destroy();
    } catch {}
    ytPlayer = null;
  }
  if (ytContainer) ytContainer.style.display = "none";
}

function muteYouTube(mute: boolean) {
  try {
    if (ytPlayer?.mute && ytPlayer?.unMute)
      mute ? ytPlayer.mute() : ytPlayer.unMute();
  } catch {}
}

// ---------- Audio wiring (tab / mic / file) ----------
async function wireAnalyserFromStream(stream: MediaStream) {
  tabStream = stream;
  audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  await audioCtx.resume().catch(() => {});
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = controls.smoothing;
  const src = audioCtx.createMediaStreamSource(stream);
  src.connect(analyser);
  fft = new Uint8Array(analyser.frequencyBinCount);

  // Stop if user ends capture
  stream.getTracks().forEach((track: MediaStreamTrack) => {
    track.addEventListener("ended", (_ev: Event) => stopTabAudioCapture());
  });
}

async function startTabAudioCapture() {
  const md: any = navigator.mediaDevices;
  const opts: any = {
    video: false,
    audio: { selfBrowserSurface: "include", suppressLocalAudioPlayback: false },
    preferCurrentTab: true,
  };

  if (!md || typeof md.getDisplayMedia !== "function") {
    console.warn("getDisplayMedia not available; auto-falling back to mic");
    await startMicCapture();
    if (!analyser) await showAudioFallbackUI();
    return;
  }

  try {
    const stream: MediaStream = await md.getDisplayMedia.call(md, opts);
    const hasAudio =
      stream.getAudioTracks && stream.getAudioTracks().length > 0;
    if (!hasAudio) throw new Error("Tab capture returned no audio tracks");

    await wireAnalyserFromStream(stream);
    muteYouTube(false); // use tab audio
  } catch (e) {
    console.warn("getDisplayMedia failed:", e);
    await startMicCapture();
    if (!analyser) await showAudioFallbackUI();
  }
}

async function startMicCapture() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    if (!stream) return;

    await wireAnalyserFromStream(stream);

    try {
      ytPlayer?.unMute?.();
      ytPlayer?.setVolume?.(100);
    } catch {}
  } catch (e) {
    console.warn("getUserMedia(mic) failed:", e);
  }
}

async function startFileAudio(file: File) {
  try {
    if (!fileAudioEl) {
      fileAudioEl = document.createElement("audio");
      fileAudioEl.crossOrigin = "anonymous";
      fileAudioEl.controls = false;
      fileAudioEl.loop = true;
      fileAudioEl.style.display = "none";
      document.body.appendChild(fileAudioEl);
    }
    fileAudioEl.src = URL.createObjectURL(file);
    await fileAudioEl.play();

    audioCtx = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    await audioCtx.resume().catch(() => {});
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = controls.smoothing;
    const src = audioCtx.createMediaElementSource(fileAudioEl);
    src.connect(analyser);
    fft = new Uint8Array(analyser.frequencyBinCount);

    muteYouTube(true);
  } catch (e) {
    console.warn("startFileAudio failed:", e);
  }
}

function stopTabAudioCapture() {
  if (tabStream) {
    tabStream.getTracks().forEach((t) => t.stop());
    tabStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyser = null;
  fft = null;
  aBass = aMid = aTre = aBeat = 0;
  ema = 0;
  lastBeatT = 0;
  if (fileAudioEl) {
    try {
      fileAudioEl.pause();
    } catch {}
  }
}

// ---------- Fallback mini-UI (mic / file) ----------
let fbBar: HTMLDivElement | null = null;
async function showAudioFallbackUI() {
  if (!fbBar) {
    fbBar = document.createElement("div");
    Object.assign(fbBar.style, {
      position: "fixed",
      left: "12px",
      bottom: "12px",
      zIndex: "1001",
      background: "rgba(0,0,0,0.55)",
      color: "#fff",
      padding: "8px 10px",
      borderRadius: "8px",
      font: "12px/1.4 Inter, system-ui",
      display: "flex",
      gap: "8px",
      alignItems: "center",
    });
    fbBar.textContent = "Audio source:";
    const micBtn = document.createElement("button");
    micBtn.textContent = "Use Microphone";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "audio/*";
    fbBar.appendChild(micBtn);
    fbBar.appendChild(fileInput);
    document.body.appendChild(fbBar);

    micBtn.addEventListener("click", async () => {
      await startMicCapture();
      if (fbBar) fbBar.style.display = "none";
    });
    fileInput.addEventListener("change", async () => {
      if (!fileInput.files || !fileInput.files[0]) return;
      await startFileAudio(fileInput.files[0]);
      if (fbBar) fbBar.style.display = "none";
    });
  } else {
    fbBar.style.display = "flex";
  }
}

// ---------- Analysis (freq + RMS fallback) ----------
function updateAudioLevels() {
  if (!analyser || !audioCtx) return;

  if (!fft || fft.length !== analyser.frequencyBinCount) {
    fft = new Uint8Array(analyser.frequencyBinCount);
  }
  analyser.smoothingTimeConstant = controls.smoothing;
  (analyser as any).getByteFrequencyData(fft as any);

  const td = new Uint8Array(analyser.fftSize);
  (analyser as any).getByteTimeDomainData(td as any);
  let rmsSum = 0;
  for (let i = 0; i < td.length; i++) {
    const s = (td[i] - 128) / 128; // -1..1
    rmsSum += s * s;
  }
  const rms = Math.sqrt(rmsSum / td.length); // 0..~1

  const sr = audioCtx.sampleRate;
  const binHz = sr / (2 * fft.length);
  const band = (f0: number, f1: number) => {
    const i0 = Math.max(0, Math.floor(f0 / binHz));
    const i1 = Math.min(fft.length - 1, Math.ceil(f1 / binHz));
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += fft![i];
    return sum / Math.max(1, i1 - i0 + 1) / 255;
  };

  let bass = band(20, 150);
  let mid = band(150, 2000);
  let tre = band(2000, 10000);

  const tiny = (bass + mid + tre) / 3 < 0.02;
  if (tiny && rms > 0.01) {
    bass = Math.min(1, rms * 2.2);
    mid = Math.min(1, rms * 1.4);
    tre = Math.min(1, rms * 0.9);
  }

  const nowE = bass * 1.0 + mid * 0.25; // beat energy
  if (ema === 0) ema = nowE;
  const alpha = 0.15;
  ema = (1 - alpha) * ema + alpha * nowE;

  const t = audioCtx.currentTime;
  const threshold = ema * Math.max(0.5, controls.sensitivity);
  const canBeat = t - lastBeatT > minBeatInterval;
  if (canBeat && nowE > threshold) {
    lastBeatT = t;
    aBeat = 1.0;
  } else {
    aBeat = Math.max(0, aBeat - 3.5 * (1 / 60));
  }

  aBass = bass;
  aMid = mid;
  aTre = tre;

  // Debug once per second
  const now = performance.now();
  (window as any).__dbgT = (window as any).__dbgT || 0;
  if (now - (window as any).__dbgT > 1000) {
    (window as any).__dbgT = now;
    console.log("levels", {
      bass: +aBass.toFixed(3),
      mid: +aMid.toFixed(3),
      tre: +aTre.toFixed(3),
      beat: +aBeat.toFixed(2),
      rms: +rms.toFixed(3),
      tiny,
    });
  }
}

function loadScene() {
  icosphere = new Icosphere(vec3.fromValues(0, 0, 0), 1, controls.tesselations);
  icosphere.create();
  square = new Square(vec3.fromValues(0, 0, 0));
  square.create();
  setActiveShape(controls.shape);
}

function main() {
  const stats = Stats();
  stats.setMode(0);
  document.body.appendChild(stats.domElement);

  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  const gl = canvas.getContext("webgl2", {
    alpha: true,
  }) as WebGL2RenderingContext;
  if (!gl) {
    alert("WebGL 2 not supported!");
    return;
  }
  setGL(gl);

  const renderer = new OpenGLRenderer(canvas);
  renderer.setClearColor(0.05, 0.05, 0.06, 1.0);
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);

  const camera = new Camera(
    vec3.fromValues(0, 0, orbit.radius),
    vec3.fromValues(0, 0, 0)
  );

  // Orbit controls
  canvas.addEventListener("mousedown", (e) => {
    orbit.dragging = true;
    orbit.lastX = e.clientX;
    orbit.lastY = e.clientY;
  });
  window.addEventListener("mouseup", () => {
    orbit.dragging = false;
  });
  window.addEventListener("mousemove", (e) => {
    if (!orbit.dragging) return;
    const dx = e.clientX - orbit.lastX,
      dy = e.clientY - orbit.lastY;
    orbit.lastX = e.clientX;
    orbit.lastY = e.clientY;
    orbit.yaw += dx * orbit.rotateSpeed;
    orbit.pitch += dy * orbit.rotateSpeed;
    orbit.pitch = Math.max(
      orbit.minPitch,
      Math.min(orbit.maxPitch, orbit.pitch)
    );
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      orbit.radius *= 1.0 + Math.sign(e.deltaY) * orbit.zoomSpeed * 0.1;
      orbit.radius = Math.max(
        orbit.minRadius,
        Math.min(orbit.maxRadius, orbit.radius)
      );
    },
    { passive: false }
  );

  // Mouse NDC for deformation
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    vec2.set(mouseNDC, x, y);
  });

  loadScene();

  const fire = new ShaderProgram([
    new Shader(gl.VERTEX_SHADER, require("./shaders/fireball-vert.glsl")),
    new Shader(gl.FRAGMENT_SHADER, require("./shaders/fireball-frag.glsl")),
  ]);

  const U = (n: string) => gl.getUniformLocation(fire.prog, n);
  const uni = {
    time: U("u_Time"),
    oct: U("u_Octaves"),
    coreLow: U("u_CoreLowAmp"),
    coreHi: U("u_CoreHiAmp"),
    coreScale: U("u_CoreScale"),
    flameScale: U("u_FlameNoiseScale"),
    flameHi: U("u_FlameHiAmp"),
    flameLift: U("u_FlameLift"),
    upDir: U("u_UpDir"),
    bands: U("u_BandCount"),
    grain: U("u_GrainAmp"),
    wash: U("u_Wash"),
    exposure: U("u_Exposure"),
    coreHot: U("u_CoreHot"),
    shellOffset: U("u_ShellOffset"),
    glowOffset: U("u_GlowOffset"),
    sceneScale: U("u_SceneScale"),
    glowStrength: U("u_GlowStrength"),

    // mouse
    mouseNDC: U("u_MouseNDC"),
    mouseStrength: U("u_MouseStrength"),
    mouseFalloff: U("u_MouseFalloff"),
    mouseOn: U("u_MouseOn"),

    // audio
    audioBass: U("u_AudioBass"),
    audioMid: U("u_AudioMid"),
    audioTreble: U("u_AudioTreble"),
    audioBeat: U("u_AudioBeat"),

    pass: U("u_Pass"),
  };

  // ---------------- GUI ----------------
  gui = new DAT.GUI();

  const gGeom = gui.addFolder("Geometry");
  gGeom
    .add(controls, "shape", ["square", "icosphere"])
    .onChange(setActiveShape);
  gGeom.add(controls, "tesselations", 0, 8).step(1);
  gGeom.add(controls, "sceneScale", 0.15, 1.0).step(0.01).name("Scene Scale");
  folders.push(gGeom);

  const gCore = gui.addFolder("Core (steady magma)");
  gCore.add(controls, "coreScale", 0.4, 0.95).step(0.01).name("Core Scale");
  gCore.add(controls, "coreLowAmp", 0.0, 1.0).step(0.01).name("Low-Freq Amp");
  gCore.add(controls, "coreHiAmp", 0.0, 0.05).step(0.002).name("Tiny Noise");
  folders.push(gCore);

  const gFlame = gui.addFolder("Flames (animated top)");
  gFlame
    .add(controls, "flameNoiseScale", 0.5, 4.0)
    .step(0.01)
    .name("Noise Scale");
  gFlame.add(controls, "flameHiAmp", 0.0, 0.7).step(0.005).name("fbm Amp");
  gFlame.add(controls, "flameLift", 0.0, 0.7).step(0.005).name("Up Lift");
  gFlame.add(controls, "octaves", 1, 8).step(1).name("fbm Octaves");
  gFlame
    .add(controls, "shellOffset", 0.0, 0.5)
    .step(0.005)
    .name("Shell Offset");
  const gUp = gFlame.addFolder("Up Direction");
  gUp.add(controls, "upTargetX", -1.0, 1.0).step(0.01);
  gUp.add(controls, "upTargetY", -1.0, 1.0).step(0.01);
  gUp.add(controls, "upTargetZ", -1.0, 1.0).step(0.01);
  gUp
    .add(controls, "upCatchupTau", 0.05, 1.5)
    .step(0.01)
    .name("Catch-up τ (s)");
  folders.push(gFlame, gUp);

  const gLook = gui.addFolder("Look");
  gLook.add(controls, "bandCount", 2, 14).step(1).name("Bands");
  gLook.add(controls, "wash", 0.0, 1.0).step(0.01).name("Edge Wash");
  gLook.add(controls, "exposure", 0.0, 1.5).step(0.01).name("Exposure");
  folders.push(gLook);

  const gGlow = gui.addFolder("Glow (broad halo)");
  gGlow
    .add(controls, "glowStrength", 0.0, 2.0)
    .step(0.01)
    .name("Glow Strength");
  gGlow
    .add(controls, "glowOffsetMul", 1.0, 2.5)
    .step(0.01)
    .name("Glow Offset ×");
  folders.push(gGlow);

  const gMouse = gui.addFolder("Mouse Deformation");
  gMouse.add(controls, "mouseOn").name("Enable");
  gMouse.add(controls, "mouseStrength", 0.0, 2.0).step(0.01).name("Strength");
  gMouse
    .add(controls, "mouseFalloff", 0.1, 0.8)
    .step(0.01)
    .name("Falloff (NDC)");
  folders.push(gMouse);

  // --- Audio React folder ---
  const gAudio = gui.addFolder("Audio React");
  gAudio.add(controls, "audioOn").name("Enable");
  gAudio.add(controls, "smoothing", 0.0, 0.95, 0.01).name("Smoothing");
  gAudio.add(controls, "sensitivity", 0.7, 2.0, 0.01).name("Beat Sensitivity");
  gAudio
    .add(controls, "bassToFlameLift", 0.0, 1.5, 0.01)
    .name("Bass → FlameLift");
  gAudio.add(controls, "bassToGlow", 0.0, 2.0, 0.01).name("Bass → Glow");
  gAudio.add(controls, "midToCoreLow", 0.0, 1.0, 0.01).name("Mid → CoreLow");
  gAudio
    .add(controls, "trebleToGrainHi", 0.0, 1.0, 0.01)
    .name("Treble → Grain");
  gAudio
    .add(controls, "beatToExposure", 0.0, 1.0, 0.01)
    .name("Beat → Exposure");

  // --- Fireball toggle in GUI ---
  const gMode = gui.addFolder("Mode");
  gMode
    .add(controls, "fireball")
    .name("🔥 Fireball")
    .onChange(async (on: boolean) => {
      fireballOn = on;
      if (fireballOn) {
        // Make the canvas transparent so the video shows behind it
        renderer.setClearColor(0.0, 0.0, 0.0, 0.0);
        const canvasEl = document.getElementById("canvas") as HTMLCanvasElement;
        if (canvasEl) {
          canvasEl.style.background = "transparent";
          canvasEl.style.position = "relative";
        }
        ensureYTBackground();
        await startYouTube();
        await startTabAudioCapture();
      } else {
        // Restore normal opaque background
        renderer.setClearColor(0.05, 0.05, 0.06, 1.0);
        const canvasEl = document.getElementById("canvas") as HTMLCanvasElement;
        if (canvasEl) canvasEl.style.background = "";
        stopTabAudioCapture();
        stopYouTube();
        if (fbBar) fbBar.style.display = "none";
      }
    });

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.setAspectRatio(window.innerWidth / window.innerHeight);
    camera.updateProjectionMatrix();
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
  };
  window.addEventListener("resize", resize);
  resize();

  const t0 = performance.now();
  let last = t0;

  function tick() {
    const now = performance.now();
    const dt = Math.max(0, (now - last) * 0.001);
    last = now;
    const t = 0.001 * (now - t0);

    stats.begin();

    // Orbit camera update
    const cp = Math.cos(orbit.pitch),
      sp = Math.sin(orbit.pitch);
    const cy = Math.cos(orbit.yaw),
      sy = Math.sin(orbit.yaw);
    const eye = vec3.fromValues(
      orbit.radius * cp * sy,
      orbit.radius * sp,
      orbit.radius * cp * cy
    );
    (camera as any).setPosition?.(eye);
    (camera as any).setTarget?.(vec3.fromValues(0, 0, 0));

    if (controls.tesselations !== prevTess) {
      prevTess = controls.tesselations;
      icosphere = new Icosphere(vec3.fromValues(0, 0, 0), 1, prevTess);
      icosphere.create();
      if (controls.shape === "icosphere") activeShape = icosphere;
    }

    // Lagged up vector
    vec3.set(
      upTarget,
      controls.upTargetX,
      controls.upTargetY,
      controls.upTargetZ
    );
    vec3.normalize(upTarget, upTarget);
    const k = 1.0 - Math.exp(-dt / Math.max(controls.upCatchupTau, 0.001));
    vec3.lerp(upSmooth, upSmooth, upTarget, k);
    vec3.normalize(upSmooth, upSmooth);

    renderer.clear();
    gl.useProgram(fire.prog);

    // Shared uniforms (base)
    if (uni.time) gl.uniform1f(uni.time, t);
    if (uni.oct) gl.uniform1i(uni.oct, controls.octaves | 0);
    if (uni.coreLow) gl.uniform1f(uni.coreLow, controls.coreLowAmp);
    if (uni.coreHi) gl.uniform1f(uni.coreHi, controls.coreHiAmp);
    if (uni.coreScale) gl.uniform1f(uni.coreScale, controls.coreScale);
    if (uni.flameScale) gl.uniform1f(uni.flameScale, controls.flameNoiseScale);
    if (uni.flameHi) gl.uniform1f(uni.flameHi, controls.flameHiAmp);
    if (uni.flameLift) gl.uniform1f(uni.flameLift, controls.flameLift);
    if (uni.upDir) gl.uniform3fv(uni.upDir, upSmooth);
    if (uni.bands) gl.uniform1i(uni.bands, controls.bandCount | 0);
    if (uni.grain) gl.uniform1f(uni.grain, controls.grainAmp);
    if (uni.wash) gl.uniform1f(uni.wash, controls.wash);
    if (uni.exposure) gl.uniform1f(uni.exposure, controls.exposure);
    if (uni.coreHot) gl.uniform1f(uni.coreHot, controls.coreHot);
    if (uni.shellOffset) gl.uniform1f(uni.shellOffset, controls.shellOffset);
    if (uni.glowOffset)
      gl.uniform1f(
        uni.glowOffset,
        controls.shellOffset * controls.glowOffsetMul
      );
    if (uni.sceneScale) gl.uniform1f(uni.sceneScale, controls.sceneScale);
    if (uni.glowStrength) gl.uniform1f(uni.glowStrength, controls.glowStrength);

    // Mouse uniforms
    if (uni.mouseNDC)
      gl.uniform2fv(uni.mouseNDC, mouseNDC as unknown as Float32Array);
    if (uni.mouseStrength)
      gl.uniform1f(uni.mouseStrength, controls.mouseStrength);
    if (uni.mouseFalloff) gl.uniform1f(uni.mouseFalloff, controls.mouseFalloff);
    if (uni.mouseOn) gl.uniform1i(uni.mouseOn, controls.mouseOn ? 1 : 0);

    // --- When Fireball is ON, analyse + push audio + CPU-side boosts ---
    if (fireballOn && controls.audioOn) {
      // raw audio uniforms to shader
      if (uni.audioBass) gl.uniform1f(uni.audioBass, aBass);
      if (uni.audioMid) gl.uniform1f(uni.audioMid, aMid);
      if (uni.audioTreble) gl.uniform1f(uni.audioTreble, aTre);
      if (uni.audioBeat) gl.uniform1f(uni.audioBeat, aBeat);

      updateAudioLevels();

      // CPU-side modulations
      const flameLift = controls.flameLift + aBass * controls.bassToFlameLift;
      const glow = controls.glowStrength + aBass * controls.bassToGlow;
      const coreLow = controls.coreLowAmp + aMid * controls.midToCoreLow;
      const grain = controls.grainAmp + aTre * controls.trebleToGrainHi;
      const exposure = controls.exposure + aBeat * controls.beatToExposure;

      if (uni.flameLift) gl.uniform1f(uni.flameLift, Math.min(flameLift, 1.8));
      if (uni.glowStrength) gl.uniform1f(uni.glowStrength, Math.min(glow, 3.0));
      if (uni.coreLow) gl.uniform1f(uni.coreLow, Math.min(coreLow, 1.0));
      if (uni.grain) gl.uniform1f(uni.grain, Math.min(grain, 0.6));
      if (uni.exposure) gl.uniform1f(uni.exposure, Math.min(exposure, 2.0));
    } else {
      // When off, zero audio uniforms to avoid stale values
      if (uni.audioBass) gl.uniform1f(uni.audioBass, 0.0);
      if (uni.audioMid) gl.uniform1f(uni.audioMid, 0.0);
      if (uni.audioTreble) gl.uniform1f(uni.audioTreble, 0.0);
      if (uni.audioBeat) gl.uniform1f(uni.audioBeat, 0.0);
    }

    camera.update();

    const white = vec4.fromValues(1, 1, 1, 1);
    const drawables: Drawable[] = activeShape ? [activeShape] : [];

    // Pass 0: core
    if (uni.pass) gl.uniform1i(uni.pass, 0);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    renderer.render(camera, fire, drawables, white);

    // Pass 1: flames
    if (uni.pass) gl.uniform1i(uni.pass, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    renderer.render(camera, fire, drawables, white);

    // Pass 2: glow
    if (uni.pass) gl.uniform1i(uni.pass, 2);
    renderer.render(camera, fire, drawables, white);

    gl.depthMask(true);
    gl.disable(gl.BLEND);

    stats.end();
    requestAnimationFrame(tick);
  }

  tick();
}

main();
