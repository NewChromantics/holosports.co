// A small, purpose-built glTF reader — not a general-purpose loader. It knows
// just enough to pull out of this specific file:
//   - animated "Skeleton #<id> <jointName>" nodes -> per-joint keyframe tracks
//   - the floor/background mesh (position + UV + indices) and its JPEG texture
//   - the animated camera node's translation/rotation tracks + intrinsics
//
// All buffers in this file are embedded as base64 data URIs, so there is no
// separate .bin fetch required.

const COMPONENT_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const COMPONENT_TYPED_ARRAY = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};

function base64ToBytes(dataUri) {
  const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The bone topology of a 13-point pose skeleton (nose, shoulders, elbows,
// wrists, hips, knees, ankles). "midShoulder"/"midHip" are synthesized as the
// midpoint of their pair so the spine and head have somewhere to attach to.
export const BONES = [
  ["nose", "midShoulder"],
  ["midShoulder", "midHip"],
  ["leftShoulder", "rightShoulder"],
  ["leftHip", "rightHip"],
  ["leftShoulder", "leftElbow"], ["leftElbow", "leftWrist"],
  ["rightShoulder", "rightElbow"], ["rightElbow", "rightWrist"],
  ["leftHip", "leftKnee"], ["leftKnee", "leftAnkle"],
  ["rightHip", "rightKnee"], ["rightKnee", "rightAnkle"],
];

export async function loadScene(url) {
  const gltf = await fetch(url).then((r) => r.json());
  return parseGltf(gltf);
}

// Same parsing path, for a glTF dropped onto the page as a File. Since every
// buffer in these files is an embedded base64 data URI (see base64ToBytes
// above), there's no separate .bin/.jpg to resolve relative to the dropped
// file — reading the JSON text is enough.
export async function loadSceneFromFile(file) {
  const gltf = JSON.parse(await file.text());
  return parseGltf(gltf);
}

function parseGltf(gltf) {
  const buffersBytes = gltf.buffers.map((b) => base64ToBytes(b.uri));

  function readAccessor(accessorIndex) {
    const acc = gltf.accessors[accessorIndex];
    const bv = gltf.bufferViews[acc.bufferView];
    const bytes = buffersBytes[bv.buffer];
    const TypedArray = COMPONENT_TYPED_ARRAY[acc.componentType];
    const numComponents = COMPONENT_COUNT[acc.type];
    const byteOffset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    // Buffers here are per-accessor and tightly packed, so a plain typed
    // array view (no interleaving/stride handling) is sufficient.
    return new TypedArray(
      bytes.buffer,
      bytes.byteOffset + byteOffset,
      acc.count * numComponents
    );
  }

  // ---- Skeleton joint animation tracks ----
  // skeletons: Map<skeletonId, Map<jointName, {times: Float32Array, values: Float32Array}>>
  const skeletons = new Map();
  let duration = 0;

  // The animated camera node (if any) — identified by having a `camera`
  // property, independent of naming convention.
  const cameraNodeIndex = gltf.nodes?.findIndex((n) => n.camera != null) ?? -1;
  let cameraTranslationTrack = null;
  let cameraRotationTrack = null;

  for (const anim of gltf.animations || []) {
    for (const channel of anim.channels) {
      const node = gltf.nodes[channel.target.node];
      const sampler = anim.samplers[channel.sampler];

      if (channel.target.node === cameraNodeIndex) {
        const times = readAccessor(sampler.input);
        const values = readAccessor(sampler.output);
        duration = Math.max(duration, times[times.length - 1]);
        if (channel.target.path === "translation") cameraTranslationTrack = { times, values };
        else if (channel.target.path === "rotation") cameraRotationTrack = { times, values };
        continue;
      }

      if (channel.target.path !== "translation") continue;
      const match = /^Skeleton #(\S+) (\w+)$/.exec(node.name || "");
      if (!match) continue;
      const [, skeletonId, jointName] = match;

      const times = readAccessor(sampler.input);
      const values = readAccessor(sampler.output);
      duration = Math.max(duration, times[times.length - 1]);

      if (!skeletons.has(skeletonId)) skeletons.set(skeletonId, new Map());
      skeletons.get(skeletonId).set(jointName, { times, values });
    }
  }

  // Only expose a usable camera track if both translation and rotation were
  // found — a gizmo needs both to place and orient itself.
  let cameraTrack = null;
  if (cameraTranslationTrack && cameraRotationTrack && cameraNodeIndex >= 0) {
    const cameraDef = gltf.cameras[gltf.nodes[cameraNodeIndex].camera];
    cameraTrack = {
      translation: cameraTranslationTrack,
      rotation: cameraRotationTrack,
      yfov: cameraDef?.perspective?.yfov ?? null,
      aspectRatio: cameraDef?.perspective?.aspectRatio ?? null,
    };
  }

  // ---- Floor mesh (position + UV + indices), if this file has one ----
  // Dropped files added on top of the initial scene aren't expected to
  // supply their own floor, so this is treated as optional.
  const floorNode = gltf.nodes?.find((n) => n.name && n.name.includes("BackgroundGenerator"));
  let floor = null;
  if (floorNode) {
    const floorMesh = gltf.meshes[floorNode.mesh];
    const prim = floorMesh.primitives[0];
    const floorPositions = readAccessor(prim.attributes.POSITION);
    const floorTexcoords = readAccessor(prim.attributes.TEXCOORD_0);
    const floorIndices = readAccessor(prim.indices);

    // ---- Floor texture (embedded JPEG) ----
    const material = gltf.materials[prim.material];
    const texture = gltf.textures[material.pbrMetallicRoughness.baseColorTexture.index];
    const image = gltf.images[texture.source];
    const imgBv = gltf.bufferViews[image.bufferView];
    const imgBytes = buffersBytes[imgBv.buffer];
    const blob = new Blob([imgBytes], { type: image.mimeType });
    const imageUrl = URL.createObjectURL(blob);

    floor = { positions: floorPositions, texcoords: floorTexcoords, indices: floorIndices, imageUrl };
  }

  return { skeletons, duration, floor, cameraTrack };
}

// Evaluate a keyframe track at time t using STEP interpolation (glTF's STEP
// mode: hold the value of the last keyframe at-or-before t). Works for any
// component count — vec3 translations, vec4 rotation quaternions, etc.
export function sampleTrack(track, t, numComponents) {
  const { times, values } = track;
  let lo = 0, hi = times.length - 1;
  let i;
  if (t <= times[0]) i = 0;
  else if (t >= times[hi]) i = hi;
  else {
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid - 1;
    }
    i = lo;
  }
  const base = i * numComponents;
  const out = new Array(numComponents);
  for (let c = 0; c < numComponents; c++) out[c] = values[base + c];
  return out;
}

// Convenience wrapper for the common vec3 (translation) case.
export function sampleJoint(track, t) {
  return sampleTrack(track, t, 3);
}
