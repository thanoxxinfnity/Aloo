/**
 * ALOO — Deep-space environment (the layer BEHIND the avatar).
 * ===========================================================================
 * Two rendering paths:
 *
 *  A) USER MODEL — if `/models/space.glb` exists it is loaded, scaled up and
 *     given a slow ambient yaw. It renders with depthWrite disabled and a large
 *     scale so it always reads as an infinitely distant backdrop rather than
 *     geometry the avatar could clip into.
 *
 *  B) PROCEDURAL — the zero-asset default: a layered starfield, a drifting
 *     particle field, and a nebula built from an additively-blended gradient
 *     shell. Costs almost nothing and means ALOO looks finished on first boot.
 *
 * All motion is time-based inside useFrame, so it is frame-rate independent.
 */

import { useRef, useMemo, Suspense } from 'react';
import { useFrame, useLoader } from '@react-three/fiber';
import { Stars, Sparkles } from '@react-three/drei';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';
import useAssetAvailable from '@/hooks/useAssetAvailable';

/* -------------------------------------------------------------------------- */
/* A) User-supplied space.glb                                                  */
/* -------------------------------------------------------------------------- */

function SpaceModel({ url, rotationSpeed, opacity, fitRadius, offsetX, offsetY, offsetZ, tilt, pointSize }) {
  const gltf = useLoader(GLTFLoader, url);
  const group = useRef();

  // Clone so React StrictMode's double-mount can't attach one scene twice.
  const scene = useMemo(() => {
    const clone = gltf.scene.clone(true);
    clone.traverse((node) => {
      /* MATCH ANYTHING WITH A MATERIAL, NOT JUST MESHES.
         This used to test `node.isMesh`, which silently skipped the bundled
         environment entirely: it is a POINT CLOUD (glTF primitive mode 0), so
         three builds a THREE.Points, and `isMesh` is false. Every fix below was
         therefore never applied to it — and the one that mattered was `fog`.
         The scene's fog ends at 90 units, the backdrop sits at ~190, so the
         points were being blended 100% into the fog colour. The model loaded
         fine, rendered fine, and came out solid black. */
      const mats = node.material
        ? (Array.isArray(node.material) ? node.material : [node.material])
        : null;
      if (!mats) return;

      node.frustumCulled = false;

      if (node.isPoints) {
        // A star field authored as points carries no size of its own; three
        // defaults to 1 world unit, which at this distance is a sub-pixel dot.
        mats.forEach((m) => {
          if (!m) return;
          m.sizeAttenuation = true;
          m.size = pointSize;
        });
      }

      mats.forEach((m) => {
        if (!m) return;
        // The backdrop lies far beyond the fog's far plane; fogging it just
        // erases it. It is meant to read as infinitely distant, not as haze.
        m.fog = false;
        // A backdrop must never occlude the avatar or write into the depth
        // buffer, whatever its authored scale.
        m.depthWrite = false;
        // DoubleSide, not BackSide: this has to work both for a skybox sphere
        // viewed from the inside AND for an ordinary model placed behind the
        // camera target. BackSide would render an open model inside-out.
        m.side = THREE.DoubleSide;
        m.toneMapped = false;
        if (opacity < 1) {
          m.transparent = true;
          m.opacity = opacity;
        }
      });
      node.renderOrder = -10;
    });
    return clone;
  }, [gltf, opacity, pointSize]);

  /* ---- Auto-fit -------------------------------------------------------------
     Exported environment models are rarely centred on the origin — this
     project's space model spans x -58..289, y -82..313. Dropped in as-is it
     would sit entirely off to one side of the avatar. We measure the bounding
     box, recentre it, and scale the largest axis to `fitRadius` so it always
     forms a shell around the scene. */
  const fit = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(maxDim) || maxDim <= 0) {
      return { scale: 1, offset: [0, 0, 0] };
    }
    const k = (fitRadius * 2) / maxDim;
    return { scale: k, offset: [-center.x * k, -center.y * k, -center.z * k] };
  }, [scene, fitRadius]);

  useFrame((_, delta) => {
    if (group.current) group.current.rotation.y += rotationSpeed * delta;
  });

  return (
    // Outer group: placement in the scene (pushed back, lifted, tilted so the
    // disc is seen at an angle instead of edge-on).
    <group position={[offsetX, offsetY, offsetZ]} rotation={[THREE.MathUtils.degToRad(tilt), 0, 0]}>
      {/* Middle group spins slowly on the disc's own axis. */}
      <group ref={group}>
        {/* Inner group carries the measured normalisation. */}
        <group position={fit.offset} scale={fit.scale}>
          <primitive object={scene} />
        </group>
      </group>
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* B) Procedural fallback                                                      */
/* -------------------------------------------------------------------------- */

/** A soft additive nebula shell — cheap volumetric-looking depth. */
function Nebula({ color, position, scale, speed }) {
  const ref = useRef();

  // A radial-gradient canvas texture is far cheaper than a real volume and,
  // additively blended on a billboard, is indistinguishable at this distance.
  const texture = useMemo(() => {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.18)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    ref.current.rotation.z = t * speed;
    // Slow breathing keeps the backdrop alive without drawing attention.
    const s = scale * (1 + Math.sin(t * speed * 3) * 0.04);
    ref.current.scale.set(s, s, s);
  });

  return (
    <sprite ref={ref} position={position}>
      <spriteMaterial
        map={texture}
        color={color}
        transparent
        opacity={0.5}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        toneMapped={false}
      />
    </sprite>
  );
}

/** Slowly drifting dust — parallax cue that sells "we are moving through space". */
function DustField({ count, rotationSpeed }) {
  const ref = useRef();

  const geometry = useMemo(() => {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const cyan = new THREE.Color('#38bdf8');
    const violet = new THREE.Color('#818cf8');
    const tmp = new THREE.Color();

    for (let i = 0; i < count; i++) {
      // Distribute on a spherical shell so density looks even from the centre.
      const r = 28 + Math.random() * 42;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi) * 0.6; // flatten vertically
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

      tmp.copy(cyan).lerp(violet, Math.random());
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geo;
  }, [count]);

  useFrame((state, delta) => {
    if (!ref.current) return;
    ref.current.rotation.y += rotationSpeed * delta * 0.6;
    ref.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.05) * 0.05;
  });

  return (
    <points ref={ref} geometry={geometry} frustumCulled={false}>
      <pointsMaterial
        size={0.22}
        sizeAttenuation
        vertexColors
        transparent
        opacity={0.75}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  );
}

function ProceduralSpace({ rotationSpeed, particleDensity, horizonShell = true, nebulae = true, sparkles = true }) {
  const group = useRef();

  useFrame((_, delta) => {
    if (group.current) group.current.rotation.y += rotationSpeed * delta * 0.35;
  });

  return (
    <group ref={group}>
      {/* Two star layers at different radii create genuine parallax on orbit. */}
      <Stars radius={90} depth={55} count={4000} factor={4} saturation={0} fade speed={0.4} />
      <Stars radius={45} depth={25} count={1200} factor={2.4} saturation={0.6} fade speed={0.8} />

      <DustField count={particleDensity} rotationSpeed={rotationSpeed} />

      {/* Glowing motes near the avatar — foreground depth cue. These sit IN
          FRONT of her, so they are both a cost and the thing most likely to
          obscure the character; dropped first on the low tier. */}
      {sparkles && (
        <Sparkles count={90} scale={[14, 8, 14]} size={2.6} speed={0.32} opacity={0.5} color="#38bdf8" />
      )}

      {nebulae && (
        <>
          <Nebula color="#4f46e5" position={[-26, 8, -40]} scale={44} speed={0.02} />
          <Nebula color="#0ea5e9" position={[30, -4, -46]} scale={38} speed={-0.017} />
          <Nebula color="#a21caf" position={[6, 18, -55]} scale={30} speed={0.012} />
        </>
      )}

      {/* A dark shell closes the horizon so the void never shows the clear
          colour — omitted when a real environment model supplies the horizon. */}
      {horizonShell && (
        <mesh renderOrder={-20}>
          <sphereGeometry args={[140, 32, 32]} />
          <meshBasicMaterial color="#05070f" side={THREE.BackSide} depthWrite={false} fog={false} />
        </mesh>
      )}
    </group>
  );
}

/* -------------------------------------------------------------------------- */

export default function SpaceBackground({
  url = '/models/space.glb',
  rotationSpeed = 0.015,
  particleDensity = 1400,
  opacity = 1,
  fitRadius = 95,
  offsetX = 0,
  offsetY = 14,
  offsetZ = -190,
  tilt = 24,
  /**
   * 'stars' — the generated starfield (default).
   * 'model' — the supplied environment GLB, shown on its own.
   */
  style = 'stars',
  spacePointSize = 1.6,
  sparkles = true,
}) {
  const status = useAssetAvailable(url);
  const showModel = style === 'model' && status === 'available';

  return (
    <group>
      {/* THE DEFAULT BACKDROP IS THE GENERATED STARFIELD, and it is worth
          recording why, because it looks like a step backwards and is not.

          The original build rendered BOTH: this layer, thinned, with the
          environment GLB behind it. But that GLB was never actually visible —
          it is a point cloud, so it slipped past an `isMesh` guard, never had
          its fog disabled, and at 190 units sat entirely beyond the fog's 90
          unit far plane. It rendered every frame as solid fog colour.

          So the backdrop everyone has actually been looking at all along is
          this one — stars, drifting dust and motes, nothing else. It is
          restored here as the honest default rather than as an accident, with
          the same thinned density and no nebulae, which is exactly what it
          looked like. The environment model is still selectable, and now that
          the fog bug is fixed it genuinely shows when chosen. */}
      {!showModel && (
        <ProceduralSpace
          rotationSpeed={rotationSpeed}
          // 0.45: the density the original shipped with. At full strength the
          // dust reads as snow rather than as distant space.
          particleDensity={Math.round(particleDensity * 0.45)}
          horizonShell={false}
          nebulae={false}
        />
      )}

      {showModel && (
        <Suspense fallback={null}>
          <SpaceModel
            url={url}
            rotationSpeed={rotationSpeed}
            opacity={opacity}
            fitRadius={fitRadius}
            offsetX={offsetX}
            offsetY={offsetY}
            offsetZ={offsetZ}
            tilt={tilt}
            pointSize={spacePointSize}
          />
        </Suspense>
      )}
    </group>
  );
}
