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
import * as THREE from 'three';

import SpaceBackground from './SpaceBackground';
import CameraController from './CameraController';
import { validateModelRigging, buildMorphIndex, applyMorph, findBone } from './RiggingValidator';
import { lipSync, VISEMES, startIdleAnimation } from '@/services/ttsLipSyncService';

/* -------------------------------------------------------------------------- */
/* Loader configuration                                                        */
/* -------------------------------------------------------------------------- */

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

function AvatarModel({ url, scale, offset, onReport }) {
  const gltf = useLoader(GLTFLoader, url, configureLoader);
  const group = useRef();
  const { pointer } = useThree();

  // Clone the scene so React StrictMode's double-mount cannot bind one
  // skinned mesh into two scene graphs (which silently breaks skinning).
  const scene = useMemo(() => {
    const clone = gltf.scene.clone(true);
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
      },
      // Which mouth channel do we actually have? Decided once, not per frame.
      hasVisemes: report.visemeChecks.found.length >= 4,
      mouthMorphs: report.mouthFallback,
      blinkMorphs: report.expressionChecks.found.filter((m) => /blink|eyesclosed/i.test(m)),
      smileMorphs: report.expressionChecks.found.filter((m) => /smile/i.test(m)),
    };
  }, [gltf, scene, url]);

  // Cache each bone's authored rest rotation — every procedural offset is
  // applied relative to this, so we never accumulate drift.
  const rest = useMemo(() => {
    const snap = {};
    Object.entries(rig.bones).forEach(([k, bone]) => {
      if (bone) snap[k] = bone.rotation.clone();
    });
    return snap;
  }, [rig]);

  useEffect(() => {
    onReport?.(rig.report);
  }, [rig, onReport]);

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

    /* ---- 1. Mouth --------------------------------------------------------- */
    if (rig.hasVisemes) {
      // Drive the full viseme set — the highest-fidelity path.
      for (const v of VISEMES) {
        applyMorph(rig.morphIndex, `viseme_${v}`, f.weights[v] || 0);
      }
    } else if (rig.mouthMorphs.length) {
      // Amplitude-only fallback: one blendshape, driven by loudness.
      for (const m of rig.mouthMorphs) applyMorph(rig.morphIndex, m, f.mouthOpen);
    } else if (rig.bones.jaw) {
      // Last resort: rotate the jaw bone directly (~17° at full open).
      rig.bones.jaw.rotation.x = (rest.jaw?.x || 0) + f.jawOpen * 0.3;
    }

    /* ---- 2. Blink & expression -------------------------------------------- */
    if (rig.blinkMorphs.length) {
      for (const m of rig.blinkMorphs) applyMorph(rig.morphIndex, m, f.blink);
    }
    if (rig.smileMorphs.length) {
      for (const m of rig.smileMorphs) applyMorph(rig.morphIndex, m, f.mouthSmile);
    }
    applyMorph(rig.morphIndex, 'mouthOpen', rig.hasVisemes ? f.mouthOpen * 0.5 : f.mouthOpen);
    applyMorph(rig.morphIndex, 'jawOpen', f.jawOpen);

    /* ---- 3. Head look-at --------------------------------------------------- */
    // Pointer is normalised device coords (-1..1). Clamped so the neck never
    // exceeds a believable range.
    if (rig.bones.head && rest.head) {
      const targetY = THREE.MathUtils.clamp(pointer.x * 0.42, -0.5, 0.5);
      const targetX = THREE.MathUtils.clamp(-pointer.y * 0.26, -0.3, 0.3);
      // Speaking adds a small rhythmic nod — silent heads look embalmed.
      const emphasis = f.speaking ? Math.sin(t * 6.5) * 0.03 * f.energy : 0;
      rig.bones.head.rotation.y = THREE.MathUtils.lerp(
        rig.bones.head.rotation.y,
        rest.head.y + targetY,
        delta * 3.2
      );
      rig.bones.head.rotation.x = THREE.MathUtils.lerp(
        rig.bones.head.rotation.x,
        rest.head.x + targetX + emphasis,
        delta * 3.2
      );
    }
    if (rig.bones.neck && rest.neck) {
      // The neck follows at a third of the head's angle — that ratio is what
      // makes a look-at read as a body turning rather than a head swivelling.
      rig.bones.neck.rotation.y = THREE.MathUtils.lerp(
        rig.bones.neck.rotation.y,
        rest.neck.y + pointer.x * 0.14,
        delta * 2.4
      );
    }

    /* ---- 4. Breathing ------------------------------------------------------ */
    if (rig.bones.spine && rest.spine) {
      // ~14 breaths/min at rest, faster and shallower while speaking.
      const rate = f.speaking ? 1.9 : 1.15;
      rig.bones.spine.rotation.x = rest.spine.x + Math.sin(t * rate) * 0.022;
    }

    /* ---- 5. Whole-body micro-sway ------------------------------------------ */
    if (group.current) {
      group.current.position.y = offset[1] + Math.sin(t * 0.9) * 0.008;
      group.current.rotation.y = Math.sin(t * 0.31) * 0.035;
    }
  });

  return (
    <group ref={group} position={offset} scale={scale} dispose={null}>
      <primitive object={scene} />
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
function HoloAvatar({ scale, offset }) {
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

    // Core pulse — idle heartbeat, spikes with vocal energy.
    if (core.current) {
      const pulse = 1 + Math.sin(t * 2.1) * 0.05 + f.energy * 0.28;
      core.current.scale.setScalar(pulse);
      core.current.material.emissiveIntensity = 1.4 + f.energy * 3;
    }

    // Counter-rotating HUD rings.
    if (ringA.current) ringA.current.rotation.z += delta * 0.42;
    if (ringB.current) ringB.current.rotation.z -= delta * 0.27;

    if (group.current) {
      group.current.rotation.y = THREE.MathUtils.lerp(
        group.current.rotation.y,
        pointer.x * 0.3,
        delta * 2.6
      );
      group.current.rotation.x = THREE.MathUtils.lerp(
        group.current.rotation.x,
        -pointer.y * 0.12,
        delta * 2.6
      );
      group.current.position.y = offset[1] + Math.sin(t * 0.85) * 0.03;
    }
  });

  return (
    <group ref={group} position={offset} scale={scale}>
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

  const offset = [
    settings.avatarOffsetX || 0,
    settings.avatarOffsetY || 0,
    settings.avatarOffsetZ || 0,
  ];
  const scale = settings.avatarScale || 1;

  // Keep the blink/ease loop running for as long as the avatar is on screen.
  useEffect(() => startIdleAnimation(), []);

  const useGlb = modelStatus === 'available' && !loadFailed;
  const fallback = <HoloAvatar scale={scale} offset={offset} />;

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
      camera={{ position: [0, 1.46, 1.95], fov: 38, near: 0.1, far: 300 }}
      style={{ opacity: settings.canvasOpacity ?? 1 }}
    >
      {/* Fog hides the far shell seam and adds atmospheric depth. */}
      <fog attach="fog" args={['#070a12', 8, 60]} />

      <Lighting />

      <SpaceBackground
        url={settings.spaceModelUrl}
        rotationSpeed={settings.ambientRotationSpeed}
        particleDensity={settings.particleDensity}
      />

      <Suspense fallback={fallback}>
        {useGlb ? (
          <ModelErrorBoundary fallback={fallback} onError={() => setLoadFailed(true)}>
            <AvatarModel
              url={settings.avatarModelUrl}
              scale={scale}
              offset={offset}
              onReport={onRiggingReport}
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
