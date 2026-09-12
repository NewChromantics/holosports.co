// Tune the stick figures' look here.

// World-space thickness (in scene units, i.e. roughly meters) of each limb
// "ribbon". Limbs are drawn as camera-facing quads rather than GL lines,
// since line width beyond 1px isn't reliably supported across browsers/GPUs.
export const BONE_THICKNESS = 0.09;

// Size, in pixels, of the small dot drawn at each joint (gl_PointSize).
export const JOINT_DOT_SIZE = 3;

// Big procedural "rest of the world" ground plane, recentered under the
// camera each frame so it reads as effectively infinite.
export const GROUND_HALF_SIZE = 250; // world units from center to edge
// Checker-square size, in world units (metres — same unit as everything
// else: skeleton joint positions, BONE_THICKNESS, GROUND_Y, etc). Always
// used as-is; deliberately not derived from any geometry baked into a
// loaded glTF (e.g. debug marker cubes), since that size is arbitrary and
// unrelated to real-world scale.
export const GROUND_CELL_SIZE = 1;
// Two very-close shades around #9b7 (0.6, 0.733, 0.467), for a subtle checker.
export const GROUND_COLOR_A = [0.57, 0.70, 0.44];
export const GROUND_COLOR_B = [0.63, 0.76, 0.50];
// Sits a hair below y = 0 (where the gltf floor plane lives) to avoid z-fighting.
export const GROUND_Y = -0.01;

// Lowest angle, in degrees above the floor plane, the camera can be orbited
// down to — keeps right-drag orbiting from tilting the camera below the
// floor and looking up through it.
export const MIN_CAMERA_PITCH_DEGREES = 10;

// Depth-based depth-of-field, with a classic 4-point curve (near blur ->
// near clear -> far clear -> far blur), all in world units/metres of
// straight-line distance from the camera along its view axis. These are the
// sliders' starting values — see the "DOF" panel in the page, which lets
// you retune all four live.
export const DOF_DEFAULT_NEAR_BLUR = 8; // fully blurred at/below this distance
export const DOF_DEFAULT_NEAR_CLEAR = 15; // fully sharp from here...
export const DOF_DEFAULT_FAR_CLEAR = 19; // ...to here
export const DOF_DEFAULT_FAR_BLUR = 30; // fully blurred at/beyond this distance
export const DOF_SLIDER_MAX = 60; // range-input upper bound, metres
export const DOF_MAX_BLUR_LOD = 5; // mip level sampled at full blur

// "Debug zones" mode: instead of blurring, tints the sharp image so you can
// see exactly where each part of the curve falls. Blue/purple cover the
// near side (blue = fully blurred at/below nearBlur, purple = ramping up to
// nearClear); red/pink cover the far side (red = ramping from farClear,
// pink = fully blurred at/beyond farBlur). No tint at all means the sharp
// zone (between nearClear and farClear).
export const DOF_DEBUG_NEAR_FULL_COLOR = [0.2, 0.4, 1.0]; // blue
export const DOF_DEBUG_NEAR_RAMP_COLOR = [0.6, 0.2, 0.9]; // purple
export const DOF_DEBUG_FAR_RAMP_COLOR = [1.0, 0.2, 0.2]; // red
export const DOF_DEBUG_FAR_FULL_COLOR = [1.0, 0.4, 0.7]; // pink
export const DOF_DEBUG_TINT_STRENGTH = 0.6; // max opacity of the tint overlay

// Camera gizmo: a small wireframe frustum (apex at the camera + a "far
// plane" rectangle, connected by 4 edges) tracing the gltf's own animated
// camera over time. Deliberately extruded only a short, fixed distance
// rather than using the camera's actual near/far — this is a visualization
// aid, not a literal frustum render.
export const CAMERA_GIZMO_DEPTH = 1.5; // metres the frustum is extruded out to
// Used only if the glTF camera doesn't specify its own aspectRatio (this
// one doesn't) — a guess at the source video's aspect, width/height.
export const CAMERA_GIZMO_ASPECT_FALLBACK = 9 / 16;
export const CAMERA_GIZMO_COLOR = [1.0, 0.55, 0.1]; // orange
