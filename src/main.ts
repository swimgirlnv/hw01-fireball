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
};

const controls = { ...defaults };

let gui: DAT.GUI;
const folders: DAT.GUI[] = [];
let icosphere: Icosphere;
let square: Square;
let activeShape: Drawable | null = null;
let prevTess = defaults.tesselations;

// === Simple mouse orbit state ===
const orbit = {
  dragging: false,
  lastX: 0,
  lastY: 0,
  yaw: 0,               // radians
  pitch: 0.2,           // radians
  radius: 8,            // distance from origin
  minPitch: -1.4,
  maxPitch:  1.4,
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
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
  if (!gl) {
    alert("WebGL 2 not supported!");
    return;
  }
  setGL(gl);

  const renderer = new OpenGLRenderer(canvas);
  renderer.setClearColor(0.05, 0.05, 0.06, 1.0);
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);

  const camera = new Camera(vec3.fromValues(0, 0, orbit.radius), vec3.fromValues(0, 0, 0));

  // Orbit controls
  canvas.addEventListener("mousedown", (e) => {
    orbit.dragging = true; orbit.lastX = e.clientX; orbit.lastY = e.clientY;
  });
  window.addEventListener("mouseup", () => { orbit.dragging = false; });
  window.addEventListener("mousemove", (e) => {
    if (!orbit.dragging) return;
    const dx = e.clientX - orbit.lastX;
    const dy = e.clientY - orbit.lastY;
    orbit.lastX = e.clientX; orbit.lastY = e.clientY;
    orbit.yaw   += dx * orbit.rotateSpeed;
    orbit.pitch += dy * orbit.rotateSpeed;
    orbit.pitch  = Math.max(orbit.minPitch, Math.min(orbit.maxPitch, orbit.pitch));
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    orbit.radius *= (1.0 + Math.sign(e.deltaY) * orbit.zoomSpeed * 0.1);
    orbit.radius  = Math.max(orbit.minRadius, Math.min(orbit.maxRadius, orbit.radius));
  }, { passive: false });

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

    pass: U("u_Pass"),
  };

  // ---------------- GUI ----------------
  gui = new DAT.GUI();

  const gGeom = gui.addFolder("Geometry");
  gGeom.add(controls, "shape", ["square", "icosphere"]).onChange(setActiveShape);
  gGeom.add(controls, "tesselations", 0, 8).step(1);
  gGeom.add(controls, "sceneScale", 0.15, 1.0).step(0.01).name("Scene Scale");
  folders.push(gGeom);

  const gCore = gui.addFolder("Core (steady magma)");
  gCore.add(controls, "coreScale", 0.4, 0.95).step(0.01).name("Core Scale");
  gCore.add(controls, "coreLowAmp", 0.0, 1.0).step(0.01).name("Low-Freq Amp");
  gCore.add(controls, "coreHiAmp", 0.0, 0.05).step(0.002).name("Tiny Noise");
  folders.push(gCore);

  const gFlame = gui.addFolder("Flames (animated top)");
  gFlame.add(controls, "flameNoiseScale", 0.5, 4.0).step(0.01).name("Noise Scale");
  gFlame.add(controls, "flameHiAmp", 0.0, 0.7).step(0.005).name("fbm Amp");
  gFlame.add(controls, "flameLift", 0.0, 0.7).step(0.005).name("Up Lift");
  gFlame.add(controls, "octaves", 1, 8).step(1).name("fbm Octaves");
  gFlame.add(controls, "shellOffset", 0.0, 0.5).step(0.005).name("Shell Offset");
  const gUp = gFlame.addFolder("Up Direction");
  gUp.add(controls, "upTargetX", -1.0, 1.0).step(0.01);
  gUp.add(controls, "upTargetY", -1.0, 1.0).step(0.01);
  gUp.add(controls, "upTargetZ", -1.0, 1.0).step(0.01);
  gUp.add(controls, "upCatchupTau", 0.05, 1.5).step(0.01).name("Catch-up τ (s)");
  folders.push(gFlame, gUp);

  const gLook = gui.addFolder("Look");
  gLook.add(controls, "bandCount", 2, 14).step(1).name("Bands");
  gLook.add(controls, "wash", 0.0, 1.0).step(0.01).name("Edge Wash");
  gLook.add(controls, "exposure", 0.0, 1.5).step(0.01).name("Exposure");
  folders.push(gLook);

  const gGlow = gui.addFolder("Glow (broad halo)");
  gGlow.add(controls, "glowStrength", 0.0, 2.0).step(0.01).name("Glow Strength");
  gGlow.add(controls, "glowOffsetMul", 1.0, 2.5).step(0.01).name("Glow Offset ×");
  folders.push(gGlow);

  const gMouse = gui.addFolder("Mouse Deformation");
  gMouse.add(controls, "mouseOn").name("Enable");
  gMouse.add(controls, "mouseStrength", 0.0, 2.0).step(0.01).name("Strength");
  gMouse.add(controls, "mouseFalloff", 0.1, 0.8).step(0.01).name("Falloff (NDC)");
  folders.push(gMouse);

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
    const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch);
    const cy = Math.cos(orbit.yaw),   sy = Math.sin(orbit.yaw);
    const eye = vec3.fromValues(
      orbit.radius * cp * sy,
      orbit.radius * sp,
      orbit.radius * cp * cy
    );
    if ((camera as any).setPosition) (camera as any).setPosition(eye);
    if ((camera as any).setTarget)   (camera as any).setTarget(vec3.fromValues(0, 0, 0));

    if (controls.tesselations !== prevTess) {
      prevTess = controls.tesselations;
      icosphere = new Icosphere(vec3.fromValues(0, 0, 0), 1, prevTess);
      icosphere.create();
      if (controls.shape === "icosphere") activeShape = icosphere;
    }

    // Lagged up vector
    vec3.set(upTarget, controls.upTargetX, controls.upTargetY, controls.upTargetZ);
    vec3.normalize(upTarget, upTarget);
    const k = 1.0 - Math.exp(-dt / Math.max(controls.upCatchupTau, 0.001));
    vec3.lerp(upSmooth, upSmooth, upTarget, k);
    vec3.normalize(upSmooth, upSmooth);

    renderer.clear();

    gl.useProgram(fire.prog);

    // Shared uniforms
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
      gl.uniform1f(uni.glowOffset, controls.shellOffset * controls.glowOffsetMul);
    if (uni.sceneScale) gl.uniform1f(uni.sceneScale, controls.sceneScale);
    if (uni.glowStrength) gl.uniform1f(uni.glowStrength, controls.glowStrength);

    // Mouse uniforms
    if (uni.mouseNDC)       gl.uniform2fv(uni.mouseNDC, mouseNDC as unknown as Float32Array);
    if (uni.mouseStrength)  gl.uniform1f(uni.mouseStrength, controls.mouseStrength);
    if (uni.mouseFalloff)   gl.uniform1f(uni.mouseFalloff,  controls.mouseFalloff);
    if (uni.mouseOn)        gl.uniform1i(uni.mouseOn,       controls.mouseOn ? 1 : 0);

    camera.update();

    const white = vec4.fromValues(1, 1, 1, 1);
    const drawables: Drawable[] = activeShape ? [activeShape] : [];

    // Pass 0: core
    if (uni.pass) gl.uniform1i(uni.pass, 0);
    gl.disable(gl.BLEND); gl.depthMask(true);
    renderer.render(camera, fire, drawables, white);

    // Pass 1: flames
    if (uni.pass) gl.uniform1i(uni.pass, 1);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE); gl.depthMask(false);
    renderer.render(camera, fire, drawables, white);

    // Pass 2: glow
    if (uni.pass) gl.uniform1i(uni.pass, 2);
    renderer.render(camera, fire, drawables, white);

    gl.depthMask(true); gl.disable(gl.BLEND);

    stats.end();
    requestAnimationFrame(tick);
  }

  tick();
}

main();