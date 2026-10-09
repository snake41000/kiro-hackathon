// Load a Mixamo .fbx animation and retarget it onto a VRM.
// Mirrors the official three-vrm "humanoidAnimation" example.
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";

// Mixamo bone name -> VRM humanoid bone name.
const mixamoVRMRigMap = {
  mixamorigHips: "hips",
  mixamorigSpine: "spine",
  mixamorigSpine1: "chest",
  mixamorigSpine2: "upperChest",
  mixamorigNeck: "neck",
  mixamorigHead: "head",
  mixamorigLeftShoulder: "leftShoulder",
  mixamorigLeftArm: "leftUpperArm",
  mixamorigLeftForeArm: "leftLowerArm",
  mixamorigLeftHand: "leftHand",
  mixamorigLeftHandThumb1: "leftThumbMetacarpal",
  mixamorigLeftHandThumb2: "leftThumbProximal",
  mixamorigLeftHandThumb3: "leftThumbDistal",
  mixamorigLeftHandIndex1: "leftIndexProximal",
  mixamorigLeftHandIndex2: "leftIndexIntermediate",
  mixamorigLeftHandIndex3: "leftIndexDistal",
  mixamorigLeftHandMiddle1: "leftMiddleProximal",
  mixamorigLeftHandMiddle2: "leftMiddleIntermediate",
  mixamorigLeftHandMiddle3: "leftMiddleDistal",
  mixamorigLeftHandRing1: "leftRingProximal",
  mixamorigLeftHandRing2: "leftRingIntermediate",
  mixamorigLeftHandRing3: "leftRingDistal",
  mixamorigLeftHandPinky1: "leftLittleProximal",
  mixamorigLeftHandPinky2: "leftLittleIntermediate",
  mixamorigLeftHandPinky3: "leftLittleDistal",
  mixamorigLeftUpLeg: "leftUpperLeg",
  mixamorigLeftLeg: "leftLowerLeg",
  mixamorigLeftFoot: "leftFoot",
  mixamorigLeftToeBase: "leftToes",
  mixamorigRightShoulder: "rightShoulder",
  mixamorigRightArm: "rightUpperArm",
  mixamorigRightForeArm: "rightLowerArm",
  mixamorigRightHand: "rightHand",
  mixamorigRightHandThumb1: "rightThumbMetacarpal",
  mixamorigRightHandThumb2: "rightThumbProximal",
  mixamorigRightHandThumb3: "rightThumbDistal",
  mixamorigRightHandIndex1: "rightIndexProximal",
  mixamorigRightHandIndex2: "rightIndexIntermediate",
  mixamorigRightHandIndex3: "rightIndexDistal",
  mixamorigRightHandMiddle1: "rightMiddleProximal",
  mixamorigRightHandMiddle2: "rightMiddleIntermediate",
  mixamorigRightHandMiddle3: "rightMiddleDistal",
  mixamorigRightHandRing1: "rightRingProximal",
  mixamorigRightHandRing2: "rightRingIntermediate",
  mixamorigRightHandRing3: "rightRingDistal",
  mixamorigRightHandPinky1: "rightLittleProximal",
  mixamorigRightHandPinky2: "rightLittleIntermediate",
  mixamorigRightHandPinky3: "rightLittleDistal",
  mixamorigRightUpLeg: "rightUpperLeg",
  mixamorigRightLeg: "rightLowerLeg",
  mixamorigRightFoot: "rightFoot",
  mixamorigRightToeBase: "rightToes",
};

const _restRotationInverse = new THREE.Quaternion();
const _parentRestWorldRotation = new THREE.Quaternion();
const _quatA = new THREE.Quaternion();
const _vec3 = new THREE.Vector3();

export async function loadMixamoAnimation(url, vrm) {
  const loader = new FBXLoader();
  const asset = await loader.loadAsync(url);

  const clip = THREE.AnimationClip.findByName(asset.animations, "mixamo.com");
  if (!clip) {
    throw new Error(`No "mixamo.com" clip found in ${url}`);
  }

  const tracks = [];

  const mixamoHips = asset.getObjectByName("mixamorigHips");
  const motionHipsHeight = mixamoHips.position.y;
  const vrmHipsNode = vrm.humanoid.getNormalizedBoneNode("hips");
  const vrmHipsY = vrmHipsNode.getWorldPosition(_vec3).y;
  const vrmRootY = vrm.scene.getWorldPosition(_vec3).y;
  const vrmHipsHeight = Math.abs(vrmHipsY - vrmRootY);
  const hipsPositionScale = vrmHipsHeight / motionHipsHeight;

  const metaVersionIsZero = vrm.meta?.metaVersion === "0";

  clip.tracks.forEach((track) => {
    const trackSplitted = track.name.split(".");
    const mixamoRigName = trackSplitted[0];
    const vrmBoneName = mixamoVRMRigMap[mixamoRigName];
    const vrmNodeName =
      vrm.humanoid.getNormalizedBoneNode(vrmBoneName)?.name;
    const mixamoRigNode = asset.getObjectByName(mixamoRigName);

    if (!vrmNodeName || !mixamoRigNode) return;

    const propertyName = trackSplitted[1];

    // Rest world rotations.
    mixamoRigNode.getWorldQuaternion(_restRotationInverse).invert();
    mixamoRigNode.parent.getWorldQuaternion(_parentRestWorldRotation);

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const values = track.values.slice();
      for (let i = 0; i < values.length; i += 4) {
        _quatA.fromArray(values, i);
        // P * q * R^-1
        _quatA
          .premultiply(_parentRestWorldRotation)
          .multiply(_restRotationInverse);
        _quatA.toArray(values, i);
        if (metaVersionIsZero) {
          values[i] = -values[i]; // negate x
          values[i + 2] = -values[i + 2]; // negate z
        }
      }
      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${vrmNodeName}.${propertyName}`,
          track.times,
          values
        )
      );
    } else if (track instanceof THREE.VectorKeyframeTrack) {
      const values = track.values.map((v, i) => {
        let value = v;
        if (metaVersionIsZero && i % 3 !== 1) value = -value; // negate x,z
        return value * hipsPositionScale;
      });
      tracks.push(
        new THREE.VectorKeyframeTrack(
          `${vrmNodeName}.${propertyName}`,
          track.times,
          values
        )
      );
    }
  });

  return new THREE.AnimationClip(`vrm_${clip.name}`, clip.duration, tracks);
}
