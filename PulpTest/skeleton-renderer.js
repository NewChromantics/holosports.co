import { createProgram } from "./gl-utils.js";
import { sampleJoint, BONES } from "./gltf-loader.js";
import { BONE_THICKNESS, JOINT_DOT_SIZE } from "./config.js";

// Everything needed to turn a Map<skeletonId, Map<jointName, track>> (as
// produced by gltf-loader.js) into drawn stick figures lives in this one
// module: joint sampling, world-space conversion, and the GPU-side bone +
// joint rendering (kept together deliberately, rather than splitting the
// two draw calls across files).
//
// Bones and joints are both rendered as GPU-billboarded quads with an SDF
// (signed distance field) fragment shader, rather than CPU-extruded geometry:
//   - Bones: one instanced quad per segment. The vertex shader billboards it
//     (offsets across the camera's view direction) and hands the fragment
//     shader a local (distance-along, distance-across) coordinate; the
//     fragment shader evaluates a rounded-capsule SDF against it, so limb
//     "thickness" is a real per-pixel width with smooth antialiased edges
//     and round caps, independent of GL line-width support.
//   - Joints: plain GL_POINTS, whose square sprite is already a GPU billboard
//     (sized via gl_PointSize in the vertex shader); the fragment shader
//     turns that square into a smooth circular dot via a circle SDF.

// ---- Bones: instanced, billboarded capsule quads ----
const boneVert = `#version 300 es
// Per-vertex: the shared unit-quad corner. x in [0,1] runs along the segment
// (0 = padded-before-start, 1 = padded-after-end); y in [-1,1] runs across it.
layout(location = 0) in vec2 aCorner;
// Per-instance: this segment's endpoints, in world space.
layout(location = 1) in vec3 aStart;
layout(location = 2) in vec3 aEnd;

uniform mat4 uViewProj;
uniform vec3 uCameraForward; // world-space view direction, for billboarding
uniform float uThickness;    // full width, world units

out vec2 vLocal;      // (distance along segment, distance across), world units
out float vSegLen;
out float vHalfWidth;

void main() {
  vec3 seg = aEnd - aStart;
  float segLen = length(seg);
  vec3 dir = segLen > 1e-6 ? seg / segLen : vec3(1.0, 0.0, 0.0);
  vec3 perp = normalize(cross(uCameraForward, dir));
  float halfW = uThickness * 0.5;

  // Extend the quad half a width beyond each endpoint so the SDF below has
  // room to draw round caps instead of being clipped flat at the joints.
  vec3 extStart = aStart - dir * halfW;
  vec3 extEnd = aEnd + dir * halfW;
  vec3 basePos = mix(extStart, extEnd, aCorner.x);
  vec3 worldPos = basePos + perp * (aCorner.y * halfW);

  vLocal = vec2(mix(-halfW, segLen + halfW, aCorner.x), aCorner.y * halfW);
  vSegLen = segLen;
  vHalfWidth = halfW;

  gl_Position = uViewProj * vec4(worldPos, 1.0);
}`;

const boneFrag = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vSegLen;
in float vHalfWidth;
uniform vec3 uColor;
out vec4 fragColor;

void main() {
  // Distance from this fragment to the segment [0, vSegLen] on the local
  // x-axis, minus the half-width -> a capsule SDF (round caps included).
  float t = clamp(vLocal.x, 0.0, vSegLen);
  float d = length(vec2(vLocal.x - t, vLocal.y)) - vHalfWidth;
  float edge = fwidth(d);
  float alpha = 1.0 - smoothstep(-edge, edge, d);
  if (alpha <= 0.001) discard;
  fragColor = vec4(uColor, alpha);
}`;

// ---- Joints: GL_POINTS billboards, circle SDF ----
const pointVert = `#version 300 es
layout(location = 0) in vec3 aPosition;
uniform mat4 uViewProj;
uniform float uPointSize;
void main() {
  gl_Position = uViewProj * vec4(aPosition, 1.0);
  gl_PointSize = uPointSize;
}`;

const pointFrag = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c) - 0.5;
  float edge = fwidth(d);
  float alpha = 1.0 - smoothstep(-edge, edge, d);
  if (alpha <= 0.001) discard;
  fragColor = vec4(uColor, alpha);
}`;

const BONE_CORNER_VERTS = new Float32Array([
  0, -1, 1, -1, 1, 1,
  0, -1, 1, 1, 0, 1,
]);

const SKELETON_COLORS = [
  [0.95, 0.55, 0.2],
  [0.25, 0.75, 0.95],
  [0.85, 0.3, 0.55],
  [0.6, 0.85, 0.25],
  [0.8, 0.75, 0.2],
  [0.55, 0.4, 0.9],
];

// Same Z-up -> Y-up rotation as the scene root used for the floor (see
// main.js), applied per-point on the CPU so joint positions can be uploaded
// directly as world-space instance/point data.
function toWorld(p) {
  return [p[0], p[2], -p[1]];
}

function evalJointPositions(jointMap, t) {
  const pos = {};
  for (const [name, track] of jointMap) pos[name] = toWorld(sampleJoint(track, t));
  const mid = (a, b) => [
    (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2,
  ];
  if (pos.leftShoulder && pos.rightShoulder) pos.midShoulder = mid(pos.leftShoulder, pos.rightShoulder);
  if (pos.leftHip && pos.rightHip) pos.midHip = mid(pos.leftHip, pos.rightHip);
  return pos;
}

// Sets up the bone + joint programs and buffers, and returns a draw(...)
// function that renders every skeleton in a Map<skeletonId, jointMap>.
export function createSkeletonRenderer(gl) {
  const boneProgram = createProgram(gl, boneVert, boneFrag);
  const boneU = {
    viewProj: gl.getUniformLocation(boneProgram, "uViewProj"),
    cameraForward: gl.getUniformLocation(boneProgram, "uCameraForward"),
    thickness: gl.getUniformLocation(boneProgram, "uThickness"),
    color: gl.getUniformLocation(boneProgram, "uColor"),
  };

  const pointProgram = createProgram(gl, pointVert, pointFrag);
  const pointU = {
    viewProj: gl.getUniformLocation(pointProgram, "uViewProj"),
    pointSize: gl.getUniformLocation(pointProgram, "uPointSize"),
    color: gl.getUniformLocation(pointProgram, "uColor"),
  };

  // ---- Bone (instanced quad) geometry ----
  // One static unit-quad shared by every bone segment (2 triangles, 6 verts,
  // attribute 0), plus a per-instance buffer of (start, end) world positions
  // (attributes 1 & 2, divisor 1) rebuilt each frame from the sampled pose.
  const boneVao = gl.createVertexArray();
  gl.bindVertexArray(boneVao);
  const boneCornerBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, boneCornerBuf);
  gl.bufferData(gl.ARRAY_BUFFER, BONE_CORNER_VERTS, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const boneInstanceBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, boneInstanceBuf);
  gl.enableVertexAttribArray(1); // aStart
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2); // aEnd
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 24, 12);
  gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);

  // ---- Joint (points) buffer ----
  const jointVao = gl.createVertexArray();
  gl.bindVertexArray(jointVao);
  const jointBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, jointBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // draw(camera, skeletons, t): camera just needs getWorldToClip()/getBasis().
  function draw(camera, skeletons, t) {
    const viewProj = camera.getWorldToClip();
    const cameraForward = camera.getBasis().forward;

    let colorIndex = 0;
    for (const jointMap of skeletons.values()) {
      const pos = evalJointPositions(jointMap, t);
      const color = SKELETON_COLORS[colorIndex % SKELETON_COLORS.length];
      colorIndex++;

      // ---- Bones: one instance per segment, billboarded + SDF'd on the GPU ----
      const instanceData = [];
      for (const [a, b] of BONES) {
        if (!pos[a] || !pos[b]) continue;
        instanceData.push(...pos[a], ...pos[b]);
      }
      if (instanceData.length > 0) {
        gl.useProgram(boneProgram);
        gl.uniformMatrix4fv(boneU.viewProj, false, viewProj);
        gl.uniform3fv(boneU.cameraForward, cameraForward);
        gl.uniform1f(boneU.thickness, BONE_THICKNESS);
        gl.uniform3fv(boneU.color, color);

        gl.bindVertexArray(boneVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, boneInstanceBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(instanceData), gl.DYNAMIC_DRAW);
        const instanceCount = instanceData.length / 6; // 2 endpoints * 3 floats
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount);
      }

      // ---- Joints: GL_POINTS billboards with a circle SDF ----
      const pointVerts = [];
      for (const name in pos) pointVerts.push(...pos[name]);

      gl.useProgram(pointProgram);
      gl.uniformMatrix4fv(pointU.viewProj, false, viewProj);
      gl.uniform1f(pointU.pointSize, JOINT_DOT_SIZE);
      gl.uniform3fv(pointU.color, color);

      gl.bindVertexArray(jointVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, jointBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pointVerts), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.POINTS, 0, pointVerts.length / 3);
    }
  }

  return { draw };
}
