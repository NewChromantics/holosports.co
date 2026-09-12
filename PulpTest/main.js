import { Camera } from "./camera.js";
import { multiply, rotationX } from "./mat4.js";
import { loadScene, loadSceneFromFile } from "./gltf-loader.js";
import { createProgram } from "./gl-utils.js";
import { createSkeletonRenderer } from "./skeleton-renderer.js";
import { createCameraGizmo } from "./camera-gizmo.js";
import { createDepthOfField } from "./post-fx.js";
import {
  GROUND_HALF_SIZE, GROUND_CELL_SIZE, GROUND_COLOR_A, GROUND_COLOR_B, GROUND_Y,
  DOF_DEFAULT_NEAR_BLUR, DOF_DEFAULT_NEAR_CLEAR, DOF_DEFAULT_FAR_CLEAR, DOF_DEFAULT_FAR_BLUR,
} from "./config.js";

const canvas = document.getElementById("glcanvas");
const gl = canvas.getContext("webgl2");
if (!gl) throw new Error("WebGL2 not supported in this browser.");

// ---------- Shaders (ground + floor) ----------
//
// Bone/joint (stick-figure skeleton) shaders live in skeleton-renderer.js,
// kept together there rather than mixed in here with the environment shaders.

// ---- Ground: huge procedural checkerboard standing in for "the rest of
// the world" beyond the tracked floor image. Recentered on the camera's
// target every frame so it reads as effectively infinite while panning. ----
const groundVert = `#version 300 es
layout(location = 0) in vec2 aLocal; // unit quad corner, [-1, 1]
uniform mat4 uViewProj;
uniform vec2 uCenterXZ; // where the quad is currently recentered (world XZ)
uniform float uHalfSize;
uniform float uY;
out vec2 vWorldXZ;
void main() {
  vWorldXZ = aLocal * uHalfSize + uCenterXZ;
  gl_Position = uViewProj * vec4(vWorldXZ.x, uY, vWorldXZ.y, 1.0);
}`;

const groundFrag = `#version 300 es
precision highp float;
in vec2 vWorldXZ;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uCellSize;
out vec4 fragColor;
void main() {
  vec2 cell = floor(vWorldXZ / uCellSize);
  float checker = mod(cell.x + cell.y, 2.0);
  fragColor = vec4(mix(uColorA, uColorB, checker), 1.0);
}`;

// ---- Floor: textured, with real alpha (see floorTexture setup below) ----
const texVert = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec2 aTexCoord;
uniform mat4 uMVP;
out vec2 vUV;
void main() {
  vUV = aTexCoord;
  gl_Position = uMVP * vec4(aPosition, 1.0);
}`;

const texFrag = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSampler;
uniform float uDebugMix; // 0 = normal texture, 1 = transparent gaps filled with chequer
out vec4 fragColor;
void main() {
  vec4 texColor = texture(uSampler, vUV);

  // Geo debug overlay: reveals a chequer pattern (in the mesh's own UV
  // space) inside the image's transparent gaps, so you can see the true
  // extent of the geometry even where the texture is see-through. Already
  // opaque content is left completely alone; only the "missing" alpha
  // (1 - texColor.a) fades from nothing (uDebugMix = 0) to solid chequer
  // (uDebugMix = 1).
  vec2 cell = floor(vUV * 16.0);
  float checker = mod(cell.x + cell.y, 2.0);
  vec3 chequerColor = mix(vec3(0.02), vec3(0.11), checker);

  float revealT = (1.0 - texColor.a) * uDebugMix;
  vec3 rgb = mix(texColor.rgb, chequerColor, revealT);
  float alpha = mix(texColor.a, 1.0, revealT);
  fragColor = vec4(rgb, alpha);
}`;

const groundProgram = createProgram(gl, groundVert, groundFrag);
const groundU = {
  viewProj: gl.getUniformLocation(groundProgram, "uViewProj"),
  centerXZ: gl.getUniformLocation(groundProgram, "uCenterXZ"),
  halfSize: gl.getUniformLocation(groundProgram, "uHalfSize"),
  y: gl.getUniformLocation(groundProgram, "uY"),
  colorA: gl.getUniformLocation(groundProgram, "uColorA"),
  colorB: gl.getUniformLocation(groundProgram, "uColorB"),
  cellSize: gl.getUniformLocation(groundProgram, "uCellSize"),
};

const texProgram = createProgram(gl, texVert, texFrag);
const texU = {
  mvp: gl.getUniformLocation(texProgram, "uMVP"),
  sampler: gl.getUniformLocation(texProgram, "uSampler"),
  debugMix: gl.getUniformLocation(texProgram, "uDebugMix"),
};

const skeletonRenderer = createSkeletonRenderer(gl);
const cameraGizmo = createCameraGizmo(gl);
const postFx = createDepthOfField(gl);

// Fragment shaders above output real (non-1) alpha at antialiased SDF edges.
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

// ---------- Camera ----------

// Framed roughly around the tracked skeletons' bounding box (already
// expressed post scene-root, i.e. in Y-up space).
const camera = new Camera({ target: [0.24, 0.7, -0.64], zoom: 5 });

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.floor(canvas.clientWidth * dpr);
  const h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
  camera.aspect = canvas.width / canvas.height;
  postFx.resize(canvas.width, canvas.height);
}
window.addEventListener("resize", resize);
resize();

// ---------- Mouse controls: left-drag orbit, right-drag pan, wheel zoom ----------

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

let dragButton = -1;
let lastX = 0, lastY = 0;

canvas.addEventListener("mousedown", (e) => {
  dragButton = e.button;
  lastX = e.clientX;
  lastY = e.clientY;
});
window.addEventListener("mouseup", () => (dragButton = -1));
window.addEventListener("mousemove", (e) => {
  if (dragButton === -1) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  if (dragButton === 0) camera.orbit(dx, dy);
  else if (dragButton === 2) camera.pan(dx, dy, canvas.clientHeight);
});
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    camera.zoomBy(Math.exp(e.deltaY * 0.001));
  },
  { passive: false }
);

// Touch: 1 finger orbits (mirrors left-drag), 2 fingers pan (mirrors
// right-drag) and pinch-zoom together.
let touchMode = null; // "orbit" | "pan-zoom"
let lastTouchX = 0, lastTouchY = 0;
let lastPinchDist = 0;

function touchMidpoint(touches) {
  return [(touches[0].clientX + touches[1].clientX) / 2, (touches[0].clientY + touches[1].clientY) / 2];
}
function touchDistance(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

function onTouchStart(e) {
  e.preventDefault();
  if (e.touches.length === 1) {
    touchMode = "orbit";
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
  } else if (e.touches.length >= 2) {
    touchMode = "pan-zoom";
    [lastTouchX, lastTouchY] = touchMidpoint(e.touches);
    lastPinchDist = touchDistance(e.touches);
  }
}

function onTouchMove(e) {
  e.preventDefault();
  if (touchMode === "orbit" && e.touches.length === 1) {
    const dx = e.touches[0].clientX - lastTouchX;
    const dy = e.touches[0].clientY - lastTouchY;
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
    camera.orbit(dx, dy);
  } else if (touchMode === "pan-zoom" && e.touches.length >= 2) {
    const [mx, my] = touchMidpoint(e.touches);
    camera.pan(mx - lastTouchX, my - lastTouchY, canvas.clientHeight);
    lastTouchX = mx;
    lastTouchY = my;

    const dist = touchDistance(e.touches);
    if (lastPinchDist > 0) camera.zoomBy(lastPinchDist / dist);
    lastPinchDist = dist;
  }
}

// Dropping to 1 finger mid-gesture re-anchors to orbit rather than jumping;
// dropping to 0 just ends the gesture.
function onTouchEndOrCancel(e) {
  e.preventDefault();
  if (e.touches.length === 0) {
    touchMode = null;
  } else if (e.touches.length === 1) {
    touchMode = "orbit";
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
  }
}

canvas.addEventListener("touchstart", onTouchStart, { passive: false });
canvas.addEventListener("touchmove", onTouchMove, { passive: false });
canvas.addEventListener("touchend", onTouchEndOrCancel, { passive: false });
canvas.addEventListener("touchcancel", onTouchEndOrCancel, { passive: false });

// ---------- Load the glTF scene ----------

const scene = await loadScene("./Scene.gltf");

// The source data (both the floor mesh and the skeleton joints) is authored
// Z-up, with z = 0 as the floor. Rather than reshaping any geometry, apply
// one fixed transform at the scene root that converts Z-up -> the Y-up space
// our camera/renderer use. (Skeleton joints get the same rotation applied
// per-point on the CPU — see toWorld() in skeleton-renderer.js.)
const sceneRoot = rotationX(-Math.PI / 2);

// ---------- Ground plane geometry (a single static unit quad) ----------

const GROUND_QUAD_VERTS = new Float32Array([
  -1, -1, 1, -1, 1, 1,
  -1, -1, 1, 1, -1, 1,
]);
const groundVao = gl.createVertexArray();
gl.bindVertexArray(groundVao);
const groundBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, groundBuf);
gl.bufferData(gl.ARRAY_BUFFER, GROUND_QUAD_VERTS, gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

// ---------- Floor mesh + texture ----------

const floorVao = gl.createVertexArray();
gl.bindVertexArray(floorVao);
const floorPosBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, floorPosBuf);
gl.bufferData(gl.ARRAY_BUFFER, scene.floor.positions, gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
const floorUvBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, floorUvBuf);
gl.bufferData(gl.ARRAY_BUFFER, scene.floor.texcoords, gl.STATIC_DRAW);
gl.enableVertexAttribArray(1);
gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
const floorIdxBuf = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, floorIdxBuf);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, scene.floor.indices, gl.STATIC_DRAW);
gl.bindVertexArray(null);

const floorTexture = gl.createTexture();
{
  const img = new Image();
  img.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, floorTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // Many exported PNGs store black RGB under fully-transparent pixels.
    // Without premultiplying, mipmapping blends that black into nearby
    // opaque texels and produces dark fringes/blocks at a distance —
    // premultiplying (and blending accordingly in drawFloor) avoids that.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  };
  img.src = scene.floor.imageUrl;
}

// ---------- Playback UI ----------

const timeline = document.getElementById("timeline");
const playBtn = document.getElementById("playBtn");
const timeLabel = document.getElementById("timeLabel");

let currentTime = 0;
let playing = true;
let duration = scene.duration || 1;
timeline.max = String(duration);

function formatTime(t) {
  return `${t.toFixed(1)}s / ${duration.toFixed(1)}s`;
}

playBtn.addEventListener("click", () => {
  playing = !playing;
  playBtn.textContent = playing ? "Pause" : "Play";
});
timeline.addEventListener("input", () => {
  playing = false;
  playBtn.textContent = "Play";
  currentTime = parseFloat(timeline.value);
});

// ---------- Drag & drop: add more glTFs' skeletons to the running scene ----------

const dropHint = document.getElementById("dropHint");
let dropDepth = 0; // tracks nested dragenter/dragleave so the hint doesn't flicker
let nextDropId = 0;

async function handleDroppedFiles(fileList) {
  for (const file of fileList) {
    if (!file.name.toLowerCase().endsWith(".gltf")) {
      console.warn(`Skipping "${file.name}" — only .gltf files are supported.`);
      continue;
    }
    try {
      const dropped = await loadSceneFromFile(file);
      nextDropId++;
      for (const [skeletonId, joints] of dropped.skeletons) {
        // Namespaced so a dropped file's own "#100"/"#101" IDs can't collide
        // with skeletons already in the scene.
        scene.skeletons.set(`drop${nextDropId}-${skeletonId}`, joints);
      }
      if (dropped.duration > duration) {
        duration = dropped.duration;
        timeline.max = String(duration);
      }
      if (dropped.floor) {
        console.info(`"${file.name}" also has a floor mesh; only its skeleton(s) were added.`);
      }
    } catch (err) {
      console.error(`Failed to load "${file.name}" as a glTF scene:`, err);
    }
  }
}

window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dropDepth++;
  dropHint.classList.add("visible");
});
window.addEventListener("dragover", (e) => e.preventDefault()); // required to allow dropping
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dropDepth = Math.max(0, dropDepth - 1);
  if (dropDepth === 0) dropHint.classList.remove("visible");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dropDepth = 0;
  dropHint.classList.remove("visible");
  if (e.dataTransfer?.files?.length) handleDroppedFiles(e.dataTransfer.files);
});

// ---------- Render ----------

function drawGround() {
  gl.useProgram(groundProgram);
  gl.uniformMatrix4fv(groundU.viewProj, false, camera.getWorldToClip());
  gl.uniform2f(groundU.centerXZ, camera.target[0], camera.target[2]);
  gl.uniform1f(groundU.halfSize, GROUND_HALF_SIZE);
  gl.uniform1f(groundU.y, GROUND_Y);
  gl.uniform3fv(groundU.colorA, GROUND_COLOR_A);
  gl.uniform3fv(groundU.colorB, GROUND_COLOR_B);
  gl.uniform1f(groundU.cellSize, GROUND_CELL_SIZE);
  gl.bindVertexArray(groundVao);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

const geoDebugSlider = document.getElementById("geoDebugSlider");

// ---------- DOF panel ----------

const dofSliders = {
  nearBlur: document.getElementById("dofNearBlur"),
  nearClear: document.getElementById("dofNearClear"),
  farClear: document.getElementById("dofFarClear"),
  farBlur: document.getElementById("dofFarBlur"),
};
const dofDefaults = {
  nearBlur: DOF_DEFAULT_NEAR_BLUR,
  nearClear: DOF_DEFAULT_NEAR_CLEAR,
  farClear: DOF_DEFAULT_FAR_CLEAR,
  farBlur: DOF_DEFAULT_FAR_BLUR,
};
for (const key of Object.keys(dofSliders)) {
  dofSliders[key].value = String(dofDefaults[key]);
  const valueLabel = document.getElementById(`dof${key[0].toUpperCase()}${key.slice(1)}Val`);
  const sync = () => { valueLabel.textContent = parseFloat(dofSliders[key].value).toFixed(1); };
  dofSliders[key].addEventListener("input", sync);
  sync();
}

function currentDofCurve() {
  return {
    nearBlur: parseFloat(dofSliders.nearBlur.value),
    nearClear: parseFloat(dofSliders.nearClear.value),
    farClear: parseFloat(dofSliders.farClear.value),
    farBlur: parseFloat(dofSliders.farBlur.value),
  };
}

const dofDebugZonesCheckbox = document.getElementById("dofDebugZones");

function drawFloor() {
  gl.useProgram(texProgram);
  const mvp = multiply(camera.getWorldToClip(), sceneRoot);
  gl.uniformMatrix4fv(texU.mvp, false, mvp);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, floorTexture);
  gl.uniform1i(texU.sampler, 0);
  gl.uniform1f(texU.debugMix, parseFloat(geoDebugSlider.value));
  gl.bindVertexArray(floorVao);
  // The texture was uploaded premultiplied (see floorTexture setup above),
  // so it needs the matching blend func here; restore the standard one
  // afterwards for the (non-premultiplied) SDF bone/joint shaders.
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.drawElements(gl.TRIANGLES, scene.floor.indices.length, gl.UNSIGNED_INT, 0);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
}

let lastFrameMs = performance.now();

function frame(nowMs) {
  const dt = Math.min(0.1, (nowMs - lastFrameMs) / 1000);
  lastFrameMs = nowMs;

  if (playing) {
    currentTime += dt;
    if (currentTime > duration) currentTime -= duration;
    timeline.value = String(currentTime);
  }
  timeLabel.textContent = formatTime(currentTime);

  resize();

  postFx.beginScene([0.09, 0.1, 0.13]);
  drawGround();
  drawFloor();
  skeletonRenderer.draw(camera, scene.skeletons, currentTime);
  cameraGizmo.draw(camera, scene.cameraTrack, currentTime);
  postFx.endScene(camera, currentDofCurve(), dofDebugZonesCheckbox.checked);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
