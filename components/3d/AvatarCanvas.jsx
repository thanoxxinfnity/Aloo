/**
 * ALOO — Foreground 3D character renderer.
 * ===========================================================================
 * THE WEBGL PIPELINE, END TO END
 * ------------------------------
 *   <Canvas>                     r3f creates the WebGLRenderer + render loop
 *     ├─ lights                  3-point rig, tuned for a cyan/violet key
 *     ├─ <SpaceBackground/>      backdrop pass (renderOrder < 0)
 *     ├─ <Suspense>
 *     │    └─ <AvatarModel/>     GLTF -> validate rig -> index morphs ->
 *     │                          drive morphs + bones every frame
 *     └─ <CameraController/>     OrbitControls + preset director
 *
 * PER-FRAME WORK (useFrame, ~60Hz)
 *   1. Read `lipSync.frame` — a plain mutable object written by the TTS driver.
 *      Nothing here goes through React state: a 60fps face must never touch
 *      the reconciler.
 *   2. Apply viseme weights to `morphTargetInfluences` via a Map built once at
 *      load time, so no per-frame string lookups walk the scene graph.
 *   3. Layer procedural life on top of any baked clip: breathing on the spine,
 *      head look-at toward the pointer, micro-sway on the hips.
 *   4. Add the animation director's generated gestures (lib/animationDirector).
 *      Those offsets are ADDITIVE, which is what lets emotion-driven body
 *      language coexist with lip-sync and look-at instead of overwriting them.
 *
 * MISSING-MODEL BEHAVIOUR
 *   If `/models/avatar.glb` is absent we render `HoloAvatar` — a procedural
 *   holographic figure driven by exactly the same lip-sync frame. The whole
 *   voice/vision/AI stack is therefore demonstrable with zero assets.
 */

import { Suspense, Component, useRef, useMemo, useEffect, useState } from 'react';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { ContactShadows, useAnimations, Float } from '@react-three/drei';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import * as THREE from 'three';

import SpaceBackground from './SpaceBackground';
import CameraController from './CameraController';
import { validateModelRigging, buildMorphIndex, applyMorph, findBone } from './RiggingValidator';
import { lipSync, VISEMES, startIdleAnimation, speak } from '@/services/ttsLipSyncService';
import { director } from '@/lib/animationDirector';
import {
  mood,
  startIdleAttention,
  poke,
  waveProgress,
  pokeAttention,
  randomGreeting,
} from '@/lib/avatarMood';

/* -------------------------------------------------------------------------- */
/* Loader configuration                                                        */
/* -------------------------------------------------------------------------- */

/** Scratch objects reused every frame — never allocate inside useFrame. */
const tmpQuat = new THREE.Quaternion();

/**
 * Draco-compressed GLBs are common for avatars. Wiring the decoder here means a
 * compressed model just works; the decoder is fetched from the gstatic CDN only
 * when a compressed mesh is actually encountered.
 */
function configureLoader(loader) {
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  loader.setDRACOLoader(draco);
}

/* -------------------------------------------------------------------------- */
/* GLB-backed avatar                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Distinguish a TAP from a camera DRAG.
 *
 * OrbitControls and the avatar share the same canvas, so a pointerdown on her
 * body is both "she was touched" and "start rotating the view". Reacting on
 * pointerdown alone means every camera drag makes her wave. So we record the
 * press, and only count it as a tap if the release comes quickly and close by.
 */
function useTapGesture(onTap, enabled) {
  const down = useRef(null);

  const onPointerDown = (e) => {
    if (!enabled) return;
    down.current = { t: performance.now(), x: e.nativeEvent?.clientX ?? 0, y: e.nativeEvent?.clientY ?? 0 };
  };

  const onPointerUp = (e) => {
    if (!enabled || !down.current) return;
    const dt = performance.now() - down.current.t;
    const dx = (e.nativeEvent?.clientX ?? 0) - down.current.x;
    const dy = (e.nativeEvent?.clientY ?? 0) - down.current.y;
    down.current = null;
    // 400ms and 10px: comfortably inside a deliberate tap, comfortably outside
    // the shortest camera drag anyone performs on purpose.
    if (dt < 400 && Math.hypot(dx, dy) < 10) onTap(e);
  };

  return { onPointerDown, onPointerUp, onPointerCancel: () => { down.current = null; } };
}

/**
 * Every finger joint in the rig, excluding thumbs (which curl on a different
 * axis and look wrong under a uniform curl).
 */
function collectFingerBones(scene) {
  const out = [];
  scene.traverse((n) => {
    if (!n.isBone) return;
    const norm = n.name.toLowerCase();
    if (/(index|middle|ring|pinky)[0-9]/.test(norm)) out.push(n);
  });
  return out;
}

/**
 * Work out which local axis opens a jaw bone.
 *
 * Hard-coding "rotate the jaw on X" only works for rigs whose jaw happens to be
 * bound that way; on others X is the twist axis and the mouth never opens (the
 * bone rotates, but along its own length). Every humanoid jaw hinges about the
 * character's LEFT-RIGHT axis, so we take world +X and express it in the bone's
 * local space. Positive rotation about that axis carries a forward point
 * downward — which is exactly a chin dropping.
 *
 * Returns a unit Vector3 in bone-local space, or null when there is no jaw.
 */
function jawOpenAxis(scene, jaw) {
  if (!jaw) return null;
  // getWorldQuaternion is only meaningful once the matrices are current.
  scene.updateMatrixWorld(true);
  const worldQ = new THREE.Quaternion();
  jaw.getWorldQuaternion(worldQ);
  return new THREE.Vector3(1, 0, 0).applyQuaternion(worldQ.invert()).normalize();
}

function AvatarModel({ url, scale, offset, settings, onReport, onFocus }) {
  const gltf = useLoader(GLTFLoader, url, configureLoader);
  const group = useRef();
  const { pointer } = useThree();

  /**
   * Clone the scene so React StrictMode's double-mount cannot bind one skinned
   * mesh into two scene graphs.
   *
   * MUST be SkeletonUtils.clone, NOT Object3D.clone(true). A plain clone copies
   * the SkinnedMesh but leaves it bound to the ORIGINAL Skeleton — so the
   * cloned bones are inert decorations, and the mesh renders from bones that
   * are not in this scene graph at all. Symptoms are maddening and silent:
   * every bone animation is a no-op, and any transform applied to an ancestor
   * group (our auto-fit scale) has no effect on the rendered vertices, because
   * the skinning matrices come from a skeleton outside that group.
   */
  const scene = useMemo(() => {
    const clone = cloneSkinned(gltf.scene);
    clone.traverse((n) => {
      if (n.isMesh || n.isSkinnedMesh) {
        n.castShadow = true;
        n.receiveShadow = true;
        n.frustumCulled = false; // skinned bounds are unreliable; avoid pop-out
      }
    });
    return clone;
  }, [gltf]);

  const { actions, names } = useAnimations(gltf.animations, group);

  // ---- One-time analysis: validate the rig, index the morphs, find bones ----
  const rig = useMemo(() => {
    const report = validateModelRigging(gltf, { url });
    const morphIndex = buildMorphIndex(scene);
    return {
      report,
      morphIndex,
      bones: {
        head: findBone(scene, ['head']),
        neck: findBone(scene, ['neck']),
        spine: findBone(scene, ['spine', 'chest']),
        jaw: findBone(scene, ['jaw']),
        leftEye: findBone(scene, ['lefteye', 'eyel']),
        rightEye: findBone(scene, ['righteye', 'eyer']),
        leftArm: findBone(scene, ['leftarm', 'lupperarm', 'upperarml']),
        rightArm: findBone(scene, ['rightarm', 'rupperarm', 'upperarmr']),
        leftForeArm: findBone(scene, ['leftforearm', 'lforearm']),
        rightForeArm: findBone(scene, ['rightforearm', 'rforearm']),
        hips: findBone(scene, ['hips', 'pelvis']),
        leftShoulder: findBone(scene, ['leftshoulder', 'lshoulder', 'shoulderl', 'leftclavicle']),
        rightShoulder: findBone(scene, ['rightshoulder', 'rshoulder', 'shoulderr', 'rightclavicle']),
      },
      // Finger joints, collected once. Flat splayed hands are one of the
      // strongest "this is a mannequin" cues; a relaxed curl fixes it for free.
      fingers: collectFingerBones(scene),
      jawAxis: jawOpenAxis(scene, findBone(scene, ['jaw'])),
      // Which mouth channel do we actually have? Decided once, not per frame.
      hasVisemes: report.visemeChecks.found.length >= 4,
      mouthMorphs: report.mouthFallback,
      blinkMorphs: report.expressionChecks.found.filter((m) => /blink|eyesclosed/i.test(m)),
      smileMorphs: report.expressionChecks.found.filter((m) => /smile/i.test(m)),
    };
  }, [gltf, scene, url]);

  /* ---- Auto-fit -----------------------------------------------------------
     Imported models arrive in arbitrary units and origins. This project's
     avatar, for example, is 23.3 units tall with its feet at y=0 — dropped into
     a scene calibrated for a 1.7m human it would fill the sky. We measure the
     bind-pose bounding box once and derive a uniform scale plus a centring
     offset, then apply them on an INNER group so the user's own scale/offset
     sliders still compose on top. */
  const fit = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const usable = settings.autoFit && Number.isFinite(size.y) && size.y > 0;
    const k = usable ? (settings.avatarTargetHeight || 1.72) / size.y : 1;

    // HORIZONTAL ANCHOR: the hips bone, not the bounding-box centre. A bbox
    // includes hair, ponytails and held props, so centring on it visibly pushes
    // an asymmetric character off-axis. The hips are the figure's actual centre
    // line. (Box3.setFromObject already updated the world matrices for us.)
    const world = new THREE.Vector3();
    let anchorX = center.x;
    let anchorZ = center.z;
    const hips = findBone(scene, ['hips', 'pelvis', 'root']);
    if (hips) {
      hips.getWorldPosition(world);
      anchorX = world.x;
      anchorZ = world.z;
    }

    const offset = usable
      ? [-anchorX * k, -box.min.y * k, -anchorZ * k]
      : [0, 0, 0];

    // FOCUS POINTS drive the camera presets. Framing a face by a fixed height
    // only works for one model; measuring the head bone works for every rig.
    // (This character's ponytail is ~15cm of the total height — assuming eyes
    //  sit at 92% of it would aim the close-up above her head.)
    const H = size.y * k;
    const focus = { height: H, headY: H * 0.86, eyeY: H * 0.93, chestY: H * 0.72 };

    const headBone = findBone(scene, ['head']);
    if (headBone) {
      headBone.getWorldPosition(world);
      // NOTE: the head bone sits at the BASE of the skull (the neck joint), not
      // at eye level. Aiming a close-up here points the camera at the chin.
      focus.headY = world.y * k + offset[1];
      focus.eyeY = focus.headY + H * 0.085; // fallback estimate
    }

    // Eye bones, when the rig has them, give exact eye level — far better than
    // any proportion guess, especially for stylised heads.
    const eyeBone = findBone(scene, ['lefteye', 'eyel', 'righteye', 'eyer']);
    if (eyeBone) {
      eyeBone.getWorldPosition(world);
      focus.eyeY = world.y * k + offset[1];
    }

    const chestBone = findBone(scene, ['spine2', 'chest', 'spine1']);
    if (chestBone) {
      chestBone.getWorldPosition(world);
      focus.chestY = world.y * k + offset[1];
    }

    // Diagnostics: imported units are the single most common reason an avatar
    // "does not appear" (it is actually 20x too big and the camera is inside it).
    /* eslint-disable-next-line no-console */
    console.info(
      `[ALOO/3d] Auto-fit: measured ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(
        2
      )} units -> scale ${k.toFixed(4)}; head ${focus.headY.toFixed(2)}m, eyes ${focus.eyeY.toFixed(2)}m, chest ${focus.chestY.toFixed(2)}m.`
    );

    return { scale: k, offset, focus, measured: { height: size.y, width: size.x, depth: size.z } };
  }, [scene, settings.autoFit, settings.avatarTargetHeight]);

  /* ---- A-pose correction + rest snapshot -----------------------------------
     Mixamo-style rigs stand in a T-pose, which reads as a mannequin rather than
     a character, and this model ships no idle clip to pose it. So we rotate the
     upper-arm bones down ourselves.

     TIMING MATTERS: this has to happen during render, not in an effect. `rest`
     below snapshots the bone rotations and the frame loop lerps every bone back
     toward `rest` — so a pose applied in useEffect (which runs AFTER the memo)
     would be captured as "not the rest pose" and immediately animated away.

     The bind rotation is stashed in userData so re-running with a different
     angle sets an absolute value instead of accumulating. */
  const rest = useMemo(() => {
    const rad = THREE.MathUtils.degToRad(settings.aPoseAngle || 62);
    const posed = settings.autoAPose && !gltf.animations?.length;

    const armDown = (bone, sign) => {
      if (!bone) return;
      if (bone.userData.__alooBindZ === undefined) {
        bone.userData.__alooBindZ = bone.rotation.z;
      }
      bone.rotation.z = bone.userData.__alooBindZ + (posed ? sign * rad : 0);
    };
    // Sign is per-rig: for this Mixamo-style bind orientation, negative Z on
    // the left upper arm and positive on the right rotates them downward.
    armDown(rig.bones.leftArm, -1);
    armDown(rig.bones.rightArm, 1);

    const snap = {};
    Object.entries(rig.bones).forEach(([k, bone]) => {
      if (bone) snap[k] = bone.rotation.clone();
    });
    // The jaw is driven by quaternion (arbitrary hinge axis), so it needs its
    // rest orientation in the same form.
    if (rig.bones.jaw) snap.jawQuat = rig.bones.jaw.quaternion.clone();

    // RELAXED HANDS. A bind pose leaves fingers dead straight, which reads as a
    // shop dummy. A gentle curl, stronger toward the fingertips, is what a hand
    // does at rest. Applied once here so it becomes part of the rest pose.
    const curl = THREE.MathUtils.degToRad(settings.fingerCurl ?? 12);
    if (curl > 0) {
      rig.fingers.forEach((bone) => {
        if (bone.userData.__alooBindX === undefined) {
          bone.userData.__alooBindX = bone.rotation.x;
        }
        // Joint index 1/2/3 — distal joints curl more than knuckles.
        const depth = Number((bone.name.match(/([0-9])$/) || [])[1] || 1);
        bone.rotation.x = bone.userData.__alooBindX + curl * (0.6 + depth * 0.35);
      });
    }

    snap.fingers = rig.fingers.map((b) => b.rotation.clone());
    if (rig.bones.hips) snap.hips = rig.bones.hips.rotation.clone();
    if (rig.bones.hips) snap.hipsPos = rig.bones.hips.position.clone();
    return snap;
  }, [rig, gltf.animations, settings.autoAPose, settings.aPoseAngle, settings.fingerCurl]);

  useEffect(() => {
    onReport?.(rig.report);
  }, [rig, onReport]);

  // Hand the measured focus points to the camera director.
  useEffect(() => {
    onFocus?.(fit.focus);
  }, [fit, onFocus]);

  // Play an idle clip if the artist shipped one.
  useEffect(() => {
    if (!names?.length) return undefined;
    const idle =
      names.find((n) => /idle|breath|stand/i.test(n)) || names[0];
    const action = actions[idle];
    if (!action) return undefined;
    action.reset().fadeIn(0.4).play();
    return () => {
      action.fadeOut(0.3);
    };
  }, [actions, names]);

  useFrame((state, delta) => {
    const f = lipSync.frame;
    const t = state.clock.elapsedTime;
    const now = performance.now();

    /* ---- 0. Where is her attention? ----------------------------------------
       Blending three sources rather than tracking the pointer directly is what
       stops the stare: `mood.attention` flips to 'away' on an irregular timer,
       and a recent tap overrides everything for a couple of seconds. */
    const wave = settings.tapReaction === false ? 0 : waveProgress(now);
    const pokeWeight = settings.tapReaction === false ? 0 : pokeAttention(now);

    /* ---- 0b. Generated body language ---------------------------------------
       The director rebuilds a set of ADDITIVE bone offsets each frame from
       procedurally generated gestures. Additive is the whole trick: it sums
       onto the look-at, breathing and lip-sync layers instead of fighting them. */
    const dp = director.update(delta, { speaking: f.speaking, energy: f.energy });

    let gazeX = pointer.x;
    let gazeY = pointer.y;
    if (mood.attention === 'away' && settings.idleLookAround !== false) {
      gazeX = mood.gaze.x;
      gazeY = mood.gaze.y;
    }
    if (pokeWeight > 0) {
      // Look at where she was touched, easing back to the pointer.
      gazeX = THREE.MathUtils.lerp(gazeX, THREE.MathUtils.clamp(mood.pokePoint.x * 2.2, -1, 1), pokeWeight);
      gazeY = THREE.MathUtils.lerp(gazeY, THREE.MathUtils.clamp((mood.pokePoint.y - 1.5) * 2, -1, 1), pokeWeight);
    }

    /* ---- 1. Mouth --------------------------------------------------------- */
    if (rig.hasVisemes) {
      // Drive the full viseme set — the highest-fidelity path.
      for (const v of VISEMES) {
        applyMorph(rig.morphIndex, `viseme_${v}`, f.weights[v] || 0);
      }
    } else if (rig.mouthMorphs.length) {
      // Amplitude-only fallback: one blendshape, driven by loudness.
      for (const m of rig.mouthMorphs) applyMorph(rig.morphIndex, m, f.mouthOpen);
    } else if (rig.bones.jaw && rest.jawQuat && rig.jawAxis) {
      // Tier 3: hinge the jaw bone. Coarser than visemes — one degree of freedom
      // instead of fifteen — but the mouth genuinely opens in time with the
      // audio. The hinge axis is derived from the rig (see jawOpenAxis), so this
      // works regardless of how the jaw was bound.
      const swing = THREE.MathUtils.degToRad(settings.jawOpenAngle ?? 22);
      const sign = settings.jawInvert ? -1 : 1;
      tmpQuat.setFromAxisAngle(rig.jawAxis, f.jawOpen * swing * sign);
      rig.bones.jaw.quaternion.copy(rest.jawQuat).multiply(tmpQuat);
    }
    // Tier 4 (no visemes, no mouth morphs, no jaw bone) is handled by the
    // body-performance block below: such a character cannot move its lips, so
    // it speaks with its head, spine and shoulders instead.
    const bodyPerformance = !rig.hasVisemes && !rig.mouthMorphs.length && !rig.bones.jaw;

    /* ---- 2. Blink & expression -------------------------------------------- */
    if (rig.blinkMorphs.length) {
      for (const m of rig.blinkMorphs) applyMorph(rig.morphIndex, m, f.blink);
    }
    if (rig.smileMorphs.length) {
      for (const m of rig.smileMorphs) applyMorph(rig.morphIndex, m, f.mouthSmile);
    }
    applyMorph(rig.morphIndex, 'mouthOpen', rig.hasVisemes ? f.mouthOpen * 0.5 : f.mouthOpen);
    applyMorph(rig.morphIndex, 'jawOpen', f.jawOpen);

    /* ---- 2b. Eyes ----------------------------------------------------------
       Eye BONES let the gaze follow the pointer, which is most of what makes a
       face feel present. They cannot blink — blinking needs eyelids, i.e. a
       morph target — so we do not fake it; the diagnostics report it instead.
       A slow saccade keeps the gaze from looking laser-locked. */
    if (settings.eyeTracking !== false) {
      const sacX = Math.sin(t * 0.83) * 0.02 + Math.sin(t * 2.7) * 0.006;
      const sacY = Math.cos(t * 0.61) * 0.014;
      const eyeYaw = THREE.MathUtils.clamp(gazeX * 0.28, -0.35, 0.35) + sacX;
      const eyePitch = THREE.MathUtils.clamp(-gazeY * 0.18, -0.22, 0.22) + sacY;
      for (const key of ['leftEye', 'rightEye']) {
        const bone = rig.bones[key];
        const r = rest[key];
        if (!bone || !r) continue;
        bone.rotation.y = THREE.MathUtils.lerp(bone.rotation.y, r.y + eyeYaw, delta * 8);
        bone.rotation.x = THREE.MathUtils.lerp(bone.rotation.x, r.x + eyePitch, delta * 8);
      }
    }

    /* ---- 3. Head look-at --------------------------------------------------- */
    // Pointer is normalised device coords (-1..1). Clamped so the neck never
    // exceeds a believable range.
    if (rig.bones.head && rest.head) {
      const targetY = THREE.MathUtils.clamp(gazeX * 0.42, -0.5, 0.5);
      const targetX = THREE.MathUtils.clamp(-gazeY * 0.26, -0.3, 0.3);
      // A touched person turns their head sharply, then settles.
      const track = 3.2 + pokeWeight * 6;

      // Speech emphasis. On a rig WITH a mouth this is a light rhythmic nod so
      // the head is not embalmed. On a rig with NO face controls it becomes the
      // primary performance: a strong syllable-rate nod plus a slower tilt,
      // which is what makes the character read as talking at all.
      const gain = bodyPerformance ? 1 : 0.28;
      const nod = f.speaking ? Math.sin(t * 7.4) * 0.085 * f.energy * gain : 0;
      const tilt = f.speaking ? Math.sin(t * 2.6) * 0.07 * f.energy * gain : 0;
      const turn = f.speaking ? Math.sin(t * 1.7) * 0.06 * f.energy * gain : 0;

      rig.bones.head.rotation.y = THREE.MathUtils.lerp(
        rig.bones.head.rotation.y,
        rest.head.y + targetY + turn + dp.head.y,
        delta * track
      );
      rig.bones.head.rotation.x = THREE.MathUtils.lerp(
        rig.bones.head.rotation.x,
        rest.head.x + targetX + nod + dp.head.x,
        delta * track
      );
      rig.bones.head.rotation.z = THREE.MathUtils.lerp(
        rig.bones.head.rotation.z,
        rest.head.z + tilt + dp.head.z,
        delta * 3.0
      );
    }
    if (rig.bones.neck && rest.neck) {
      // The neck follows at a third of the head's angle — that ratio is what
      // makes a look-at read as a body turning rather than a head swivelling.
      rig.bones.neck.rotation.y = THREE.MathUtils.lerp(
        rig.bones.neck.rotation.y,
        rest.neck.y + gazeX * 0.14 + dp.neck.y,
        delta * 2.4
      );
      rig.bones.neck.rotation.z = THREE.MathUtils.lerp(
        rig.bones.neck.rotation.z,
        rest.neck.z + dp.neck.z,
        delta * 3
      );
    }

    /* ---- 4. Breathing ------------------------------------------------------ */
    if (rig.bones.spine && rest.spine) {
      // ~14 breaths/min at rest, faster and shallower while speaking.
      const rate = f.speaking ? 1.9 : 1.15;
      rig.bones.spine.rotation.x = rest.spine.x + Math.sin(t * rate) * 0.022 + dp.spine.x;
      // A touch of torso rotation on emphasis — speaking with the whole body.
      rig.bones.spine.rotation.y = THREE.MathUtils.lerp(
        rig.bones.spine.rotation.y,
        rest.spine.y + (f.speaking ? Math.sin(t * 1.3) * 0.05 * f.energy : 0) + dp.spine.y,
        delta * 2
      );
      rig.bones.spine.rotation.z = THREE.MathUtils.lerp(
        rig.bones.spine.rotation.z,
        rest.spine.z + dp.spine.z,
        delta * 4
      );
    }

    /* ---- 4a. Shoulders (director only) -------------------------------------- */
    for (const key of ['leftShoulder', 'rightShoulder']) {
      const bone = rig.bones[key];
      const r = rest[key];
      if (!bone || !r) continue;
      bone.rotation.z = THREE.MathUtils.lerp(bone.rotation.z, r.z + dp[key].z, delta * 5);
      bone.rotation.x = THREE.MathUtils.lerp(bone.rotation.x, r.x + dp[key].x, delta * 5);
    }

    /* ---- 4b. Arms: idle sway, and gesture while speaking -------------------- */
    const armSwing = Math.sin(t * 0.72) * 0.03;
    const gesture = f.speaking ? f.energy * 0.16 : 0;
    if (rig.bones.leftArm && rest.leftArm) {
      rig.bones.leftArm.rotation.z = THREE.MathUtils.lerp(
        rig.bones.leftArm.rotation.z,
        rest.leftArm.z + armSwing + gesture * Math.sin(t * 3.1) + dp.leftArm.z,
        delta * 2.4
      );
      rig.bones.leftArm.rotation.x = THREE.MathUtils.lerp(
        rig.bones.leftArm.rotation.x,
        rest.leftArm.x + dp.leftArm.x,
        delta * 3
      );
    }
    if (rig.bones.rightArm && rest.rightArm && wave === 0) {
      rig.bones.rightArm.rotation.z = THREE.MathUtils.lerp(
        rig.bones.rightArm.rotation.z,
        rest.rightArm.z - armSwing - gesture * Math.sin(t * 3.1 + 0.9) + dp.rightArm.z,
        delta * 2.4
      );
      rig.bones.rightArm.rotation.x = THREE.MathUtils.lerp(
        rig.bones.rightArm.rotation.x,
        rest.rightArm.x + dp.rightArm.x,
        delta * 3
      );
    }
    // Elbows. A straight arm is another mannequin cue; real arms rest with a
    // slight bend. Skipped while waving, which drives the forearm itself.
    const bend = THREE.MathUtils.degToRad(settings.elbowBend ?? 11);
    if (wave === 0 && rig.bones.leftForeArm && rest.leftForeArm) {
      rig.bones.leftForeArm.rotation.y = THREE.MathUtils.lerp(
        rig.bones.leftForeArm.rotation.y,
        rest.leftForeArm.y + bend + gesture * 0.7 * Math.sin(t * 2.3) + dp.leftForeArm.y,
        delta * 2.2
      );
      rig.bones.leftForeArm.rotation.z = THREE.MathUtils.lerp(
        rig.bones.leftForeArm.rotation.z,
        rest.leftForeArm.z + dp.leftForeArm.z,
        delta * 3
      );
    }
    if (wave === 0 && rig.bones.rightForeArm && rest.rightForeArm) {
      rig.bones.rightForeArm.rotation.y = THREE.MathUtils.lerp(
        rig.bones.rightForeArm.rotation.y,
        rest.rightForeArm.y - bend - gesture * 0.7 * Math.sin(t * 2.3 + 0.6) + dp.rightForeArm.y,
        delta * 2.2
      );
      rig.bones.rightForeArm.rotation.z = THREE.MathUtils.lerp(
        rig.bones.rightForeArm.rotation.z,
        rest.rightForeArm.z + dp.rightForeArm.z,
        delta * 3
      );
    }

    /* ---- 4c. Weight shift ---------------------------------------------------
       Nobody stands perfectly still. A slow hip roll with a matching lateral
       drift reads as shifting weight from one leg to the other; two different
       periods keep it from looking like a metronome. */
    if (rig.bones.hips && rest.hips && rest.hipsPos && settings.weightShift !== false) {
      const shift = Math.sin(t * 0.34);
      rig.bones.hips.rotation.z = rest.hips.z + shift * 0.028 + dp.hips.z;
      rig.bones.hips.rotation.y = rest.hips.y + Math.sin(t * 0.21) * 0.03 + dp.hips.y;
      // Position is in the rig's own units, so scale the drift by the fit.
      rig.bones.hips.position.x = rest.hipsPos.x + shift * 0.012 / (fit.scale || 1);
    }

    /* ---- 4d. Greeting wave --------------------------------------------------
       Triggered by tapping the avatar. Raises the right arm and oscillates the
       forearm, then eases back — layered on top of whatever else is running. */
    if (wave > 0 && rig.bones.rightArm && rest.rightArm) {
      // Rise over the first 25%, hold, fall over the last 30%.
      const env = Math.min(1, wave / 0.25) * Math.min(1, (1 - wave) / 0.3);
      rig.bones.rightArm.rotation.z = THREE.MathUtils.lerp(
        rig.bones.rightArm.rotation.z,
        rest.rightArm.z - 1.35 * env,
        delta * 9
      );
      rig.bones.rightArm.rotation.x = THREE.MathUtils.lerp(
        rig.bones.rightArm.rotation.x,
        rest.rightArm.x - 0.35 * env,
        delta * 9
      );
      if (rig.bones.rightForeArm && rest.rightForeArm) {
        rig.bones.rightForeArm.rotation.y =
          rest.rightForeArm.y + Math.sin(wave * Math.PI * 6) * 0.55 * env;
        rig.bones.rightForeArm.rotation.z =
          rest.rightForeArm.z - 0.7 * env;
      }
    }

    /* ---- 5. Whole-body micro-sway ------------------------------------------ */
    if (group.current) {
      // `root` carries whole-body offsets from the director (e.g. an excited bob).
      group.current.position.y = offset[1] + Math.sin(t * 0.9) * 0.008 + dp.root.y;
      group.current.rotation.y = Math.sin(t * 0.31) * 0.035 + dp.root.y * 0.4;
    }
  });

  /**
   * Tapping the character makes her look at the touch point and wave. r3f gives
   * the hit position in world space; the mood bus wants it in the same metric
   * space the camera presets use, which after auto-fit is simply world metres.
   */
  const tap = useTapGesture((e) => {
    poke({ x: e.point.x, y: e.point.y, z: e.point.z });
    if (settings.speakOnTap) speak(randomGreeting());
  }, settings.tapReaction !== false);

  return (
    <group ref={group} position={offset} scale={scale} dispose={null}>
      {/* Inner group carries the measured auto-fit transform; the outer group
          carries the user's own scale/offset, so the two never fight. */}
      <group position={fit.offset} scale={fit.scale} {...tap}>
        <primitive object={scene} />
      </group>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Procedural holographic avatar (no GLB required)                             */
/* -------------------------------------------------------------------------- */

/**
 * A stylised holo-construct built from primitives. It is NOT a placeholder box:
 * it consumes the same `lipSync.frame` (mouth, blink, energy) so voice, vision
 * and lip-sync are all demonstrable before the user supplies any model.
 */
function HoloAvatar({ scale, offset, settings = {} }) {
  const group = useRef();
  const mouth = useRef();
  const eyeL = useRef();
  const eyeR = useRef();
  const core = useRef();
  const ringA = useRef();
  const ringB = useRef();
  const { pointer } = useThree();

  const holo = useMemo(
    () => ({
      skin: new THREE.MeshStandardMaterial({
        color: '#0e2233',
        emissive: '#0a4a6b',
        emissiveIntensity: 0.55,
        metalness: 0.85,
        roughness: 0.28,
        transparent: true,
        opacity: 0.92,
      }),
      glow: new THREE.MeshStandardMaterial({
        color: '#38bdf8',
        emissive: '#38bdf8',
        emissiveIntensity: 2.4,
        toneMapped: false,
      }),
      violet: new THREE.MeshStandardMaterial({
        color: '#818cf8',
        emissive: '#818cf8',
        emissiveIntensity: 1.7,
        toneMapped: false,
      }),
      wire: new THREE.MeshBasicMaterial({
        color: '#38bdf8',
        wireframe: true,
        transparent: true,
        opacity: 0.16,
      }),
      // Dedicated instances: the mouth and core animate emissiveIntensity every
      // frame, so they must not share a material with the static glow parts.
      mouth: new THREE.MeshStandardMaterial({
        color: '#818cf8',
        emissive: '#a5b4fc',
        emissiveIntensity: 1.7,
        toneMapped: false,
      }),
      core: new THREE.MeshStandardMaterial({
        color: '#38bdf8',
        emissive: '#38bdf8',
        emissiveIntensity: 1.6,
        toneMapped: false,
      }),
    }),
    []
  );

  useEffect(() => () => Object.values(holo).forEach((m) => m.dispose()), [holo]);

  useFrame((state, delta) => {
    const f = lipSync.frame;
    const t = state.clock.elapsedTime;
    const now = performance.now();

    /* ---- 0. Where is her attention? ----------------------------------------
       Blending three sources rather than tracking the pointer directly is what
       stops the stare: `mood.attention` flips to 'away' on an irregular timer,
       and a recent tap overrides everything for a couple of seconds. */
    const wave = settings.tapReaction === false ? 0 : waveProgress(now);
    const pokeWeight = settings.tapReaction === false ? 0 : pokeAttention(now);

    let gazeX = pointer.x;
    let gazeY = pointer.y;
    if (mood.attention === 'away' && settings.idleLookAround !== false) {
      gazeX = mood.gaze.x;
      gazeY = mood.gaze.y;
    }
    if (pokeWeight > 0) {
      // Look at where she was touched, easing back to the pointer.
      gazeX = THREE.MathUtils.lerp(gazeX, THREE.MathUtils.clamp(mood.pokePoint.x * 2.2, -1, 1), pokeWeight);
      gazeY = THREE.MathUtils.lerp(gazeY, THREE.MathUtils.clamp((mood.pokePoint.y - 1.5) * 2, -1, 1), pokeWeight);
    }

    // Mouth: a light bar whose height tracks mouthOpen and whose width tracks
    // spectral brightness — wide+flat for "ee", tall+narrow for "oh".
    if (mouth.current) {
      // Height tracks loudness; width tracks spectral brightness, so "ee"
      // reads wide-and-flat while "oh" reads narrow-and-tall.
      const open = 0.07 + f.mouthOpen * 0.8;
      const width = 0.5 + f.brightness * 0.45;
      mouth.current.scale.set(width, open, 1);
      mouth.current.material.emissiveIntensity = 1.6 + f.energy * 3.4;
    }

    // Blink: squash the eye sprites on the Y axis.
    const lid = 1 - f.blink * 0.94;
    if (eyeL.current) eyeL.current.scale.y = lid;
    if (eyeR.current) eyeR.current.scale.y = lid;

    // Core pulse — idle heartbeat, spikes with vocal energy, and flares when
    // tapped so the procedural avatar acknowledges touch too.
    if (core.current) {
      const flare = wave > 0 ? Math.sin(wave * Math.PI) : 0;
      const pulse = 1 + Math.sin(t * 2.1) * 0.05 + f.energy * 0.28 + flare * 0.5;
      core.current.scale.setScalar(pulse);
      core.current.material.emissiveIntensity = 1.4 + f.energy * 3 + flare * 4;
    }

    // Counter-rotating HUD rings.
    if (ringA.current) ringA.current.rotation.z += delta * 0.42;
    if (ringB.current) ringB.current.rotation.z -= delta * 0.27;

    if (group.current) {
      group.current.rotation.y = THREE.MathUtils.lerp(
        group.current.rotation.y,
        gazeX * 0.3,
        delta * (2.6 + pokeWeight * 5)
      );
      group.current.rotation.x = THREE.MathUtils.lerp(
        group.current.rotation.x,
        -gazeY * 0.12,
        delta * (2.6 + pokeWeight * 5)
      );
      group.current.position.y = offset[1] + Math.sin(t * 0.85) * 0.03;
    }
  });

  const tap = useTapGesture((e) => {
    poke({ x: e.point.x, y: e.point.y, z: e.point.z });
    if (settings.speakOnTap) speak(randomGreeting());
  }, settings.tapReaction !== false);

  return (
    <group ref={group} position={offset} scale={scale} {...tap}>
      <Float speed={1.1} rotationIntensity={0.14} floatIntensity={0.32}>
        {/* ---- Head ----
             Proportions are stylised but anchored to human scale: a 0.2m head
             radius on a ~1.75m figure reads as heroic rather than chibi, and
             keeps the face legible at the Upper Body camera preset. */}
        <mesh position={[0, 1.6, 0]} material={holo.skin} castShadow>
          <icosahedronGeometry args={[0.172, 3]} />
        </mesh>
        <mesh position={[0, 1.6, 0]} material={holo.wire}>
          <icosahedronGeometry args={[0.188, 1]} />
        </mesh>

        {/* ---- Eyes ---- */}
        <mesh ref={eyeL} position={[-0.062, 1.632, 0.15]} material={holo.glow}>
          <capsuleGeometry args={[0.015, 0.032, 4, 8]} />
        </mesh>
        <mesh ref={eyeR} position={[0.062, 1.632, 0.15]} material={holo.glow}>
          <capsuleGeometry args={[0.015, 0.032, 4, 8]} />
        </mesh>

        {/* ---- Mouth (lip-sync driven) ---- */}
        <mesh ref={mouth} position={[0, 1.543, 0.153]} material={holo.mouth}>
          <boxGeometry args={[0.15, 0.1, 0.018]} />
        </mesh>

        {/* ---- Neck & torso ---- */}
        <mesh position={[0, 1.455, 0]} material={holo.skin}>
          <cylinderGeometry args={[0.05, 0.075, 0.14, 12]} />
        </mesh>
        {/* Torso: a flattened capsule. Scaling Z to 0.62 turns a cylinder-ish
            body into a chest with front and back, which is what stops the
            silhouette reading as a snowman from every angle. */}
        <mesh position={[0, 1.14, 0]} scale={[1, 1, 0.62]} material={holo.skin} castShadow>
          <capsuleGeometry args={[0.225, 0.42, 6, 18]} />
        </mesh>
        <mesh position={[0, 1.14, 0]} scale={[1, 1, 0.62]} material={holo.wire}>
          <capsuleGeometry args={[0.248, 0.45, 4, 12]} />
        </mesh>

        {/* ---- Chest core ---- */}
        <mesh ref={core} position={[0, 1.21, 0.125]} material={holo.core}>
          <sphereGeometry args={[0.042, 16, 16]} />
        </mesh>

        {/* ---- Shoulders / arms ---- */}
        {[-1, 1].map((side) => (
          <group key={side} position={[side * 0.278, 1.318, 0]}>
            <mesh material={holo.skin}>
              <sphereGeometry args={[0.078, 14, 14]} />
            </mesh>
            <mesh position={[side * 0.045, -0.27, 0]} rotation={[0, 0, side * 0.12]} material={holo.skin}>
              <capsuleGeometry args={[0.05, 0.36, 4, 10]} />
            </mesh>
          </group>
        ))}

        {/* ---- Holographic base rings ---- */}
        <mesh ref={ringA} position={[0, 0.82, 0]} rotation={[Math.PI / 2, 0, 0]} material={holo.glow}>
          <torusGeometry args={[0.36, 0.005, 8, 64]} />
        </mesh>
        <mesh ref={ringB} position={[0, 0.75, 0]} rotation={[Math.PI / 2, 0, 0]} material={holo.violet}>
          <torusGeometry args={[0.48, 0.0035, 8, 64]} />
        </mesh>

        {/* ---- Projection cone rising from the pad ---- */}
        <mesh position={[0, 0.97, 0]}>
          <coneGeometry args={[0.44, 0.44, 32, 1, true]} />
          <meshBasicMaterial
            color="#38bdf8"
            transparent
            opacity={0.05}
            side={THREE.DoubleSide}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      </Float>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Lighting rig                                                                */
/* -------------------------------------------------------------------------- */

function Lighting() {
  const rim = useRef();
  useFrame((state) => {
    // A slowly orbiting rim light keeps silhouettes readable against the void.
    if (!rim.current) return;
    const t = state.clock.elapsedTime * 0.24;
    rim.current.position.set(Math.sin(t) * 3.4, 2.6, Math.cos(t) * 3.4 - 1.5);
  });

  return (
    <>
      {/* Ambient floor so the dark side never crushes to pure black. */}
      <ambientLight intensity={0.42} color="#7dd3fc" />
      {/* Key: cool cyan, front-left, casts the shadow. */}
      <directionalLight
        position={[2.4, 3.6, 3.2]}
        intensity={2.1}
        color="#bae6fd"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-near={0.5}
        shadow-camera-far={12}
      />
      {/* Fill: violet, opposite side, no shadow — lifts the shadow terminator. */}
      <directionalLight position={[-3.2, 1.8, 1.4]} intensity={0.9} color="#a5b4fc" />
      {/* Rim: animated, separates the figure from the backdrop. */}
      <pointLight ref={rim} intensity={22} distance={9} decay={2} color="#38bdf8" />
      {/* Uplight from the holo-pad. */}
      <pointLight position={[0, 0.1, 0.6]} intensity={6} distance={3.5} decay={2} color="#818cf8" />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Error boundary — a bad GLB must not blank the app                           */
/* -------------------------------------------------------------------------- */

class ModelErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('[ALOO/3d] Avatar failed to load — falling back to holo-construct:', error);
    this.props.onError?.(error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/* -------------------------------------------------------------------------- */
/* Public component                                                            */
/* -------------------------------------------------------------------------- */

export default function AvatarCanvas({
  settings,
  modelStatus, // 'checking' | 'available' | 'missing'
  onRiggingReport,
  onTelemetry,
  className = '',
}) {
  const [loadFailed, setLoadFailed] = useState(false);
  // Measured from the loaded rig; falls back to sensible numbers for the
  // procedural holo-construct, which is built to human scale by construction.
  const [focus, setFocus] = useState({ height: 1.72, headY: 1.5, eyeY: 1.62, chestY: 1.2 });

  const offset = [
    settings.avatarOffsetX || 0,
    settings.avatarOffsetY || 0,
    settings.avatarOffsetZ || 0,
  ];
  const scale = settings.avatarScale || 1;

  // Keep the blink/ease loop running for as long as the avatar is on screen.
  useEffect(() => startIdleAnimation(), []);

  // Generated body language: on/off and how big.
  useEffect(() => {
    director.enabled = settings.autoGestures !== false;
    director.scale = settings.gestureIntensity ?? 1;
  }, [settings.autoGestures, settings.gestureIntensity]);

  // The look-away scheduler is what stops the character staring unblinkingly.
  useEffect(() => {
    if (settings.idleLookAround === false) return undefined;
    return startIdleAttention();
  }, [settings.idleLookAround]);

  const useGlb = modelStatus === 'available' && !loadFailed;
  const fallback = <HoloAvatar scale={scale} offset={offset} settings={settings} />;

  return (
    <Canvas
      className={className}
      shadows
      dpr={[1, 2]} // cap at 2x — 3x retina rendering costs 2.25x fill for nothing
      gl={{
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.05,
      }}
      camera={{ position: [0, 1.46, 1.95], fov: 38, near: 0.1, far: 900 }}
      style={{ opacity: settings.canvasOpacity ?? 1 }}
    >
      {/* Fog hides the far shell seam and adds atmospheric depth. */}
      {/* Fog only reaches the near-field particles; the galaxy backdrop opts out
          via `material.fog = false` so distance never washes it grey. */}
      <fog attach="fog" args={['#070a12', 10, 90]} />

      <Lighting />

      <SpaceBackground
        url={settings.spaceModelUrl}
        rotationSpeed={settings.ambientRotationSpeed}
        particleDensity={settings.particleDensity}
        fitRadius={settings.spaceFitRadius}
        offsetY={settings.spaceOffsetY}
        offsetZ={settings.spaceOffsetZ}
        tilt={settings.spaceTilt}
      />

      <Suspense fallback={fallback}>
        {useGlb ? (
          <ModelErrorBoundary fallback={fallback} onError={() => setLoadFailed(true)}>
            <AvatarModel
              url={settings.avatarModelUrl}
              scale={scale}
              offset={offset}
              settings={settings}
              onReport={onRiggingReport}
              onFocus={setFocus}
            />
          </ModelErrorBoundary>
        ) : (
          fallback
        )}
      </Suspense>

      {/* Grounding shadow — without it the avatar floats in an unreadable void. */}
      <ContactShadows
        position={[0, offset[1] + 0.001, 0]}
        opacity={0.55}
        scale={7}
        blur={2.6}
        far={4}
        color="#0ea5e9"
      />

      <CameraController
        focus={focus}
        preset={settings.cameraPreset}
        orbitEnabled={settings.orbitEnabled}
        minPolar={settings.minPolar}
        maxPolar={settings.maxPolar}
        minAzimuth={settings.minAzimuth}
        maxAzimuth={settings.maxAzimuth}
        minZoom={settings.minZoom}
        maxZoom={settings.maxZoom}
        onTelemetry={onTelemetry}
      />
    </Canvas>
  );
}
