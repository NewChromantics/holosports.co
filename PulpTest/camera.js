import { basisToWorld, invert, multiply, ortho, normalize3, cross3 } from "./mat4.js";
import { MIN_CAMERA_PITCH_DEGREES } from "./config.js";

const WORLD_UP = [0, 1, 0];
const TRUE_ISO_PITCH = Math.atan(1 / Math.sqrt(2)); // ~35.264 degrees

// Camera is a small struct holding the isometric view parameters. It knows
// how to turn itself into two matrices:
//   - cameraToWorld: where the camera sits & how it's oriented, in world space
//   - cameraToClip:  the (orthographic) projection from camera space to clip space
export class Camera {
  constructor({
    target = [0, 0, 0],
    yaw = Math.PI / 4,
    pitch = TRUE_ISO_PITCH,
    distance = 20,
    zoom = 8,
    aspect = 1,
    near = -100,
    far = 100,
  } = {}) {
    this.target = target;
    this.yaw = yaw;
    this.pitch = pitch;
    this.distance = distance;
    this.zoom = zoom; // half-height of the orthographic view volume, in world units
    this.aspect = aspect;
    this.near = near;
    this.far = far;
  }

  // Returns { eye, right, up, forward } — an orthonormal basis for the camera.
  getBasis() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);

    // Direction from target to eye (i.e. -forward).
    const dir = normalize3([cy * cp, sp, sy * cp]);
    const eye = [
      this.target[0] + dir[0] * this.distance,
      this.target[1] + dir[1] * this.distance,
      this.target[2] + dir[2] * this.distance,
    ];
    const forward = normalize3([
      this.target[0] - eye[0],
      this.target[1] - eye[1],
      this.target[2] - eye[2],
    ]);
    const right = normalize3(cross3(forward, WORLD_UP));
    const up = normalize3(cross3(right, forward));
    return { eye, right, up, forward };
  }

  // Camera space -> world space.
  getCameraToWorld() {
    const { eye, right, up, forward } = this.getBasis();
    return basisToWorld(eye, right, up, forward);
  }

  // World space -> camera space (just the inverse of the above).
  getWorldToCamera() {
    return invert(this.getCameraToWorld());
  }

  // Camera space -> clip space (orthographic projection).
  getCameraToClip() {
    const halfH = this.zoom;
    const halfW = this.zoom * this.aspect;
    return ortho(-halfW, halfW, -halfH, halfH, this.near, this.far);
  }

  // Convenience: world space -> clip space, i.e. cameraToClip * worldToCamera.
  getWorldToClip() {
    return multiply(this.getCameraToClip(), this.getWorldToCamera());
  }

  // Pan the camera target across the screen plane by a pixel delta.
  pan(dxPixels, dyPixels, canvasHeight) {
    const { right, up } = this.getBasis();
    const worldPerPixel = (this.zoom * 2) / canvasHeight;
    const dx = -dxPixels * worldPerPixel;
    const dy = dyPixels * worldPerPixel;
    this.target = [
      this.target[0] + right[0] * dx + up[0] * dy,
      this.target[1] + right[1] * dx + up[1] * dy,
      this.target[2] + right[2] * dx + up[2] * dy,
    ];
  }

  // Zoom in (factor < 1) or out (factor > 1), clamped to sane bounds.
  zoomBy(factor) {
    this.zoom = Math.min(60, Math.max(1.5, this.zoom * factor));
  }

  // Orbit the camera around its target by a pixel delta (right-drag).
  orbit(dxPixels, dyPixels) {
    const ORBIT_SPEED = 0.005;
    this.yaw += dxPixels * ORBIT_SPEED;
    const maxPitch = Math.PI / 2 - 0.05;
    const minPitch = (MIN_CAMERA_PITCH_DEGREES * Math.PI) / 180;
    this.pitch = Math.min(maxPitch, Math.max(minPitch, this.pitch + dyPixels * ORBIT_SPEED));
  }
}
