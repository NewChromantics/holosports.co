import { createProgram } from "./gl-utils.js";
import {
  DOF_MAX_BLUR_LOD,
  DOF_DEBUG_NEAR_FULL_COLOR, DOF_DEBUG_NEAR_RAMP_COLOR,
  DOF_DEBUG_FAR_RAMP_COLOR, DOF_DEBUG_FAR_FULL_COLOR,
  DOF_DEBUG_TINT_STRENGTH,
} from "./config.js";

// True depth-based depth-of-field: the scene renders into an offscreen
// color+depth framebuffer; the color texture then gets a full mip chain
// generated, and a single full-screen pass samples it via textureLod() at a
// level chosen from each pixel's actual distance from the camera (metres,
// reconstructed from the depth texture) — not screen position. Distance
// runs through a classic 4-point curve: fully blurred at/below nearBlur,
// ramping to sharp by nearClear, staying sharp until farClear, then ramping
// to fully blurred by farBlur. All four are user-controlled (see the DOF
// panel), since "the right" distances depend on the scene/camera framing.

const postVert = `#version 300 es
layout(location = 0) in vec2 aPos; // full-screen quad, clip-space [-1, 1]
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const postFrag = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform float uNear;
uniform float uFar;
uniform float uNearBlur;
uniform float uNearClear;
uniform float uFarClear;
uniform float uFarBlur;
uniform float uMaxBlurLod;
uniform float uDebugZones; // 0 = normal blur, 1 = tint by zone instead
uniform vec3 uDebugNearFullColor;
uniform vec3 uDebugNearRampColor;
uniform vec3 uDebugFarRampColor;
uniform vec3 uDebugFarFullColor;
uniform float uDebugTintStrength;
out vec4 fragColor;

void main() {
  float d = texture(uDepth, vUV).r;
  float ndcZ = d * 2.0 - 1.0;
  // Inverse of this app's ortho() (see mat4.js): recovers the camera-space
  // distance a fragment is in front of the camera from its NDC depth.
  float distance = (uFar + uNear + ndcZ * (uFar - uNear)) * 0.5;

  float nearT = 1.0 - clamp((distance - uNearBlur) / max(uNearClear - uNearBlur, 1e-4), 0.0, 1.0);
  float farT = clamp((distance - uFarClear) / max(uFarBlur - uFarClear, 1e-4), 0.0, 1.0);
  float t = clamp(max(nearT, farT), 0.0, 1.0);

  if (uDebugZones > 0.5) {
    // No blur here — the sharp (LOD 0) image, semi-transparently tinted by
    // which part of the curve this pixel falls in, so the blend edges are
    // easy to see: blue/purple = near side (full blur / ramping), no tint =
    // sharp zone, red/pink = far side (ramping / full blur).
    vec3 sharpColor = textureLod(uColor, vUV, 0.0).rgb;
    vec3 nearZoneColor = mix(uDebugNearRampColor, uDebugNearFullColor, nearT);
    vec3 farZoneColor = mix(uDebugFarRampColor, uDebugFarFullColor, farT);
    vec3 zoneColor = nearT >= farT ? nearZoneColor : farZoneColor;
    fragColor = vec4(mix(sharpColor, zoneColor, t * uDebugTintStrength), 1.0);
    return;
  }

  fragColor = textureLod(uColor, vUV, t * uMaxBlurLod);
}`;

const QUAD_VERTS = new Float32Array([
  -1, -1, 1, -1, 1, 1,
  -1, -1, 1, 1, -1, 1,
]);

export function createDepthOfField(gl) {
  const program = createProgram(gl, postVert, postFrag);
  const u = {
    color: gl.getUniformLocation(program, "uColor"),
    depth: gl.getUniformLocation(program, "uDepth"),
    near: gl.getUniformLocation(program, "uNear"),
    far: gl.getUniformLocation(program, "uFar"),
    nearBlur: gl.getUniformLocation(program, "uNearBlur"),
    nearClear: gl.getUniformLocation(program, "uNearClear"),
    farClear: gl.getUniformLocation(program, "uFarClear"),
    farBlur: gl.getUniformLocation(program, "uFarBlur"),
    maxBlurLod: gl.getUniformLocation(program, "uMaxBlurLod"),
    debugZones: gl.getUniformLocation(program, "uDebugZones"),
    debugNearFullColor: gl.getUniformLocation(program, "uDebugNearFullColor"),
    debugNearRampColor: gl.getUniformLocation(program, "uDebugNearRampColor"),
    debugFarRampColor: gl.getUniformLocation(program, "uDebugFarRampColor"),
    debugFarFullColor: gl.getUniformLocation(program, "uDebugFarFullColor"),
    debugTintStrength: gl.getUniformLocation(program, "uDebugTintStrength"),
  };

  const quadVao = gl.createVertexArray();
  gl.bindVertexArray(quadVao);
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTS, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  let fbo = null, colorTex = null, depthTex = null;
  let width = 0, height = 0;

  // (Re)allocates the offscreen framebuffer at a new size. Cheap to call
  // every frame — it no-ops unless the size actually changed.
  function resize(w, h) {
    if (w === width && h === height) return;
    width = w;
    height = h;

    if (colorTex) gl.deleteTexture(colorTex);
    if (depthTex) gl.deleteTexture(depthTex);
    if (fbo) gl.deleteFramebuffer(fbo);

    colorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    depthTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn("DOF framebuffer incomplete");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Redirects rendering into the offscreen framebuffer. Call this, do the
  // normal scene draw calls, then call endScene().
  function beginScene(clearColor) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(clearColor[0], clearColor[1], clearColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  // Builds the mip chain for the blur, then composites the DOF (or debug
  // zone tint) result to whatever framebuffer is bound when this is called
  // (typically the canvas' default framebuffer, i.e. null). `curve` is
  // { nearBlur, nearClear, farClear, farBlur }, all in metres from camera.
  function endScene(camera, curve, debugZones) {
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.generateMipmap(gl.TEXTURE_2D);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);

    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.uniform1i(u.color, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, depthTex);
    gl.uniform1i(u.depth, 1);
    gl.uniform1f(u.near, camera.near);
    gl.uniform1f(u.far, camera.far);
    gl.uniform1f(u.nearBlur, curve.nearBlur);
    gl.uniform1f(u.nearClear, curve.nearClear);
    gl.uniform1f(u.farClear, curve.farClear);
    gl.uniform1f(u.farBlur, curve.farBlur);
    gl.uniform1f(u.maxBlurLod, DOF_MAX_BLUR_LOD);
    gl.uniform1f(u.debugZones, debugZones ? 1 : 0);
    gl.uniform3fv(u.debugNearFullColor, DOF_DEBUG_NEAR_FULL_COLOR);
    gl.uniform3fv(u.debugNearRampColor, DOF_DEBUG_NEAR_RAMP_COLOR);
    gl.uniform3fv(u.debugFarRampColor, DOF_DEBUG_FAR_RAMP_COLOR);
    gl.uniform3fv(u.debugFarFullColor, DOF_DEBUG_FAR_FULL_COLOR);
    gl.uniform1f(u.debugTintStrength, DOF_DEBUG_TINT_STRENGTH);

    gl.bindVertexArray(quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  return { resize, beginScene, endScene };
}
