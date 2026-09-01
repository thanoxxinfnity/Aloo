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

import { useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { CAMERA_PRESETS } from '@/lib/settingsStore';

/** [cameraPosition, orbitTarget] for each preset, in metres. */
const PRESET_POSES = {
  [CAMERA_PRESETS.CLOSEUP]: {
    position: [0, 1.58, 0.82],
    target: [0, 1.55, 0],
    fov: 32,
  },
  [CAMERA_PRESETS.UPPER_BODY]: {
    position: [0, 1.46, 1.95],
    target: [0, 1.34, 0],
    fov: 38,
  },
  [CAMERA_PRESETS.FULL_VIEW]: {
    position: [0, 1.15, 3.7],
    target: [0, 0.95, 0],
    fov: 42,
  },
  [CAMERA_PRESETS.CINEMATIC]: {
    position: [1.9, 1.6, 2.4],
    target: [0, 1.32, 0],
    fov: 40,
  },
};

const DEG = Math.PI / 180;

export default function CameraController({
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
  const pose = PRESET_POSES[preset] || PRESET_POSES[CAMERA_PRESETS.UPPER_BODY];

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
    // `preset` is the only real dependency; camera is a stable r3f singleton.
  }, [preset, camera]);

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
      const radius = 2.35 + Math.sin(t * 0.19) * 0.55;
      const angle = t * 0.13 + Math.sin(t * 0.061) * 0.5;
      const height = 1.42 + Math.sin(t * 0.23) * 0.22;

      camera.position.set(Math.sin(angle) * radius, height, Math.cos(angle) * radius);
      if (c) c.target.lerp(new THREE.Vector3(0, 1.34 + Math.sin(t * 0.17) * 0.05, 0), 0.05);

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
      target={[0, 1.34, 0]}
    />
  );
}

export { PRESET_POSES };
