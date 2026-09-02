/**
 * ALOO — Camera telemetry & preset director.
 * ===========================================================================
 * Wraps drei's OrbitControls with:
 *
 *  • CONSTRAINTS — polar/azimuth/zoom limits from settings, so the user can
 *    inspect the avatar but never orbit under the floor or behind the rig.
 *
 *  • PRESETS — Close-Up / Upper Body / Full View, each an eased dolly from the
 *    current pose to a target pose. We drive BOTH the camera position and the
 *    OrbitControls target; moving only the camera would leave the pivot behind
 *    and the next drag would snap.
 *
 *  • CINEMATIC MODE — a slow procedural orbit with a breathing radius and a
 *    gentle vertical drift. User input is disabled while it runs, and the
 *    camera hands back cleanly when the mode ends.
 *
 * Transitions are cancelled the moment the user touches the mouse, so the
 * director never fights the human.
 */

import { useRef, useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { CAMERA_PRESETS } from '@/lib/settingsStore';

/**
 * Preset poses are DERIVED from the loaded rig, not hard-coded.
 *
 * Hard-coded heights only ever frame one model. This character, for instance,
 * carries a tall ponytail: 8% of her total height is hair above the skull, so a
 * close-up aimed at "92% of height" points over her head. `focus` carries the
 * measured world Y of the head and chest bones (see AvatarCanvas), and every
 * preset is expressed relative to those.
 *
 * @param {{height:number, headY:number, chestY:number}} focus
 */
function presetPoses(focus) {
  const height = focus?.height ?? 1.72;
  const eyeY = focus?.eyeY ?? height * 0.93;
  const chestY = focus?.chestY ?? height * 0.72;

  // Distances scale with the figure so any model frames the same way. They are
  // generous on purpose: stylised heads carry far more silhouette (hair, ears,
  // accessories) than a realistic one, and a cropped face reads as a bug.
  return {
    [CAMERA_PRESETS.CLOSEUP]: {
      // A portrait lens at eye level.
      position: [0, eyeY, height * 0.6],
      target: [0, eyeY - 0.02, 0],
      fov: 30,
    },
    [CAMERA_PRESETS.UPPER_BODY]: {
      // Head to waist; aimed between chest and eyes so neither is cropped.
      position: [0, eyeY - 0.06, height * 1.0],
      target: [0, (eyeY + chestY) / 2, 0],
      fov: 36,
    },
    [CAMERA_PRESETS.FULL_VIEW]: {
      // Pulled back proportionally to the figure so any model fits the frame.
      position: [0, height * 0.62, height * 2.05],
      target: [0, height * 0.52, 0],
      fov: 42,
    },
    [CAMERA_PRESETS.CINEMATIC]: {
      position: [height * 0.85, eyeY - 0.08, height * 1.3],
      target: [0, (eyeY + chestY) / 2, 0],
      fov: 40,
    },
  };
}

const DEG = Math.PI / 180;

export default function CameraController({
  focus,
  preset = CAMERA_PRESETS.UPPER_BODY,
  orbitEnabled = true,
  minPolar = 55,
  maxPolar = 105,
  minAzimuth = -75,
  maxAzimuth = 75,
  minZoom = 0.7,
  maxZoom = 4.5,
  onTelemetry,
}) {
  const controls = useRef();
  const { camera } = useThree();

  const transition = useRef({ active: false, t: 0, from: null, fromTarget: null, fromFov: 0 });
  const cinematicT = useRef(0);
  const telemetryAccum = useRef(0);

  const isCinematic = preset === CAMERA_PRESETS.CINEMATIC;
  const poses = useMemo(() => presetPoses(focus), [focus]);
  const pose = poses[preset] || poses[CAMERA_PRESETS.UPPER_BODY];

  /* -- Kick off an eased move whenever the preset changes ----------------- */
  useEffect(() => {
    transition.current = {
      active: true,
      t: 0,
      from: camera.position.clone(),
      fromTarget: controls.current ? controls.current.target.clone() : new THREE.Vector3(0, 1.3, 0),
      fromFov: camera.fov,
    };
    cinematicT.current = 0;
    // Also re-runs when `focus` resolves: the rig is measured after the first
    // frame, so the initial pose is a guess until the model reports back.
  }, [preset, camera, focus]);

  /* -- Cancel the transition the instant the user grabs the scene --------- */
  useEffect(() => {
    const c = controls.current;
    if (!c) return undefined;
    const onStart = () => {
      transition.current.active = false;
    };
    c.addEventListener('start', onStart);
    return () => c.removeEventListener('start', onStart);
  }, []);

  useFrame((state, delta) => {
    const c = controls.current;

    /* ---- Preset dolly ---------------------------------------------------- */
    if (transition.current.active) {
      const tr = transition.current;
      tr.t = Math.min(1, tr.t + delta / 1.1); // ~1.1s move
      // easeInOutCubic — reads as a camera operator, not a linear robot arm.
      const e = tr.t < 0.5 ? 4 * tr.t ** 3 : 1 - Math.pow(-2 * tr.t + 2, 3) / 2;

      camera.position.set(
        THREE.MathUtils.lerp(tr.from.x, pose.position[0], e),
        THREE.MathUtils.lerp(tr.from.y, pose.position[1], e),
        THREE.MathUtils.lerp(tr.from.z, pose.position[2], e)
      );
      if (c) {
        c.target.set(
          THREE.MathUtils.lerp(tr.fromTarget.x, pose.target[0], e),
          THREE.MathUtils.lerp(tr.fromTarget.y, pose.target[1], e),
          THREE.MathUtils.lerp(tr.fromTarget.z, pose.target[2], e)
        );
      }
      camera.fov = THREE.MathUtils.lerp(tr.fromFov, pose.fov, e);
      camera.updateProjectionMatrix();

      if (tr.t >= 1) tr.active = false;
    }

    /* ---- Cinematic director ---------------------------------------------- */
    if (isCinematic && !transition.current.active) {
      cinematicT.current += delta;
      const t = cinematicT.current;
      // Two incommensurate frequencies keep the path from visibly looping.
      const figure = focus?.height ?? 1.72;
      const eye = focus?.eyeY ?? figure * 0.93;
      const radius = figure * 1.35 + Math.sin(t * 0.19) * 0.55;
      const angle = t * 0.13 + Math.sin(t * 0.061) * 0.5;
      const height = eye - 0.18 + Math.sin(t * 0.23) * 0.22;

      camera.position.set(Math.sin(angle) * radius, height, Math.cos(angle) * radius);
      if (c) c.target.lerp(new THREE.Vector3(0, eye - 0.26 + Math.sin(t * 0.17) * 0.05, 0), 0.05);

      const fov = 38 + Math.sin(t * 0.11) * 4;
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
    }

    if (c) c.update();

    /* ---- Telemetry read-out (throttled to ~10Hz for the HUD) ------------- */
    if (onTelemetry) {
      telemetryAccum.current += delta;
      if (telemetryAccum.current >= 0.1) {
        telemetryAccum.current = 0;
        const target = c ? c.target : new THREE.Vector3();
        const dist = camera.position.distanceTo(target);
        const spherical = new THREE.Spherical().setFromVector3(
          camera.position.clone().sub(target)
        );
        onTelemetry({
          x: camera.position.x,
          y: camera.position.y,
          z: camera.position.z,
          distance: dist,
          yaw: THREE.MathUtils.radToDeg(spherical.theta),
          pitch: 90 - THREE.MathUtils.radToDeg(spherical.phi),
          fov: camera.fov,
          fps: Math.round(1 / Math.max(delta, 0.0001)),
        });
      }
    }
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      // Cinematic mode owns the camera; handing input back mid-shot looks broken.
      enabled={orbitEnabled && !isCinematic}
      enablePan={false}
      enableDamping
      dampingFactor={0.06}
      rotateSpeed={0.55}
      zoomSpeed={0.7}
      minDistance={minZoom}
      maxDistance={maxZoom}
      minPolarAngle={minPolar * DEG}
      maxPolarAngle={maxPolar * DEG}
      minAzimuthAngle={minAzimuth * DEG}
      maxAzimuthAngle={maxAzimuth * DEG}
      target={[0, focus?.chestY ?? 1.34, 0]}
    />
  );
}

export { presetPoses };
