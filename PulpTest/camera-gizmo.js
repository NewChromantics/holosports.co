import { createProgram } from "./gl-utils.js";
import { sampleTrack } from "./gltf-loader.js";
import { quatToMat3, mulMat3Vec3 } from "./mat4.js";
import { CAMERA_GIZMO_DEPTH, CAMERA_GIZMO_ASPECT_FALLBACK, CAMERA_GIZMO_COLOR } from "./config.js";

// Draws a small pyramid-shaped wireframe (apex at the camera + a "far
// plane" rectangle a short, fixed distance out, joined by 4 edges) at the
// world-space position/orientation of the gltf's own animated camera node,
// sampled at the current playback time — a simple orange gizmo tracing
// where that camera was actually pointing, rather than a literal render of
// its full near/far frustum.

const vert = `#version 300 es
layout(location = 0) in vec3 aPosition;
uniform mat4 uViewProj;
void main() {
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}`;

const frag = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 fragColor;
void main() { fragColor = vec4(uColor, 1.0); }`;

// Same Z-up -> Y-up rotation as elsewhere (see main.js's sceneRoot / the
// skeleton renderer's toWorld) — applied last, as a plain rotation, to
// whatever world-space point comes out of the camera's own TRS.
function toWorld(p) {
  return [p[0], p[2], -p[1]];
}

export function createCameraGizmo(gl) {
  const program = createProgram(gl, vert, frag);
  const u = {
    viewProj: gl.getUniformLocation(program, "uViewProj"),
    color: gl.getUniformLocation(program, "uColor"),
  };

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // Returns the 5 world-space points (apex, then the 4 far corners in
  // order: top-left, top-right, bottom-right, bottom-left) of the gizmo at
  // time t, or null if cameraTrack is missing required data.
  function evalGizmoPoints(cameraTrack, t) {
    if (!cameraTrack || cameraTrack.yfov == null) return null;

    const translation = sampleTrack(cameraTrack.translation, t, 3);
    const rotation = sampleTrack(cameraTrack.rotation, t, 4); // [x, y, z, w]
    const rot = quatToMat3(rotation);

    const depth = CAMERA_GIZMO_DEPTH;
    const halfH = depth * Math.tan(cameraTrack.yfov / 2);
    const halfW = halfH * (cameraTrack.aspectRatio ?? CAMERA_GIZMO_ASPECT_FALLBACK);

    // Camera-local offsets (OpenGL convention: looks down -Z, +Y up, +X right).
    const localCorners = [
      [-halfW, halfH, -depth], // top-left
      [halfW, halfH, -depth], // top-right
      [halfW, -halfH, -depth], // bottom-right
      [-halfW, -halfH, -depth], // bottom-left
    ];

    const toWorldPoint = (localOffset) => {
      const rotated = mulMat3Vec3(rot, localOffset);
      const raw = [
        translation[0] + rotated[0],
        translation[1] + rotated[1],
        translation[2] + rotated[2],
      ];
      return toWorld(raw);
    };

    const apex = toWorldPoint([0, 0, 0]);
    const corners = localCorners.map(toWorldPoint);
    return { apex, corners };
  }

  function draw(camera, cameraTrack, t) {
    const points = evalGizmoPoints(cameraTrack, t);
    if (!points) return;
    const { apex, corners } = points;

    // 4 "legs" (apex -> each corner) + 4 edges of the far rectangle = 8
    // segments, drawn as one GL_LINES call.
    const verts = [];
    for (const c of corners) verts.push(...apex, ...c);
    for (let i = 0; i < 4; i++) verts.push(...corners[i], ...corners[(i + 1) % 4]);

    gl.useProgram(program);
    gl.uniformMatrix4fv(u.viewProj, false, camera.getWorldToClip());
    gl.uniform3fv(u.color, CAMERA_GIZMO_COLOR);

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.LINES, 0, verts.length / 3);
  }

  return { draw };
}
