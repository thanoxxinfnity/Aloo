/**
 * ALOO — procedural spiral galaxy.
 * ===========================================================================
 * The backdrop behind the avatar. It is generated rather than loaded, which
 * buys three things a GLB cannot give:
 *
 *  1. DIFFERENTIAL ROTATION — the detail that actually makes it read as a
 *     galaxy rather than a spinning picture of one. Real galaxies do not turn
 *     like a dinner plate: the core completes an orbit far faster than the rim,
 *     so the arms shear and wind continuously. A GLB can only be rotated
 *     rigidly, so it always looks like a decal on a turntable. Here each star
 *     carries its own orbital radius and the vertex shader advances its angle
 *     by a radius-dependent rate.
 *
 *  2. Scale for free — 90,000 stars cost one draw call and no download, where
 *     an authored model of the same density would be tens of megabytes.
 *
 *  3. It cannot fail to load, so the scene is never empty.
 *
 * STRUCTURE, in the order the eye reads it:
 *     core bulge   dense, hot, yellow-white, nearly spherical
 *     spiral arms  logarithmic spiral, scattered with a cubed random so stars
 *                  crowd the arm's spine instead of smearing evenly across it
 *     halo         sparse outliers that stop the disc ending at a hard edge
 *     dust lanes   dark bands that give the arms their definition
 */

import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Shaders                                                                     */
/* -------------------------------------------------------------------------- */

const VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  uniform float uSpin;

  attribute float aRadius;
  attribute float aAngle;
  attribute float aSize;
  attribute float aTwinkle;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    /* DIFFERENTIAL ROTATION.
       Angular velocity falls off with radius, so the core laps the rim and the
       arms shear over time exactly as a real disc galaxy's do. The +0.6 keeps
       the very centre from spinning at an infinite rate. */
    float omega = uSpin / (aRadius + 0.6);
    float angle = aAngle + uTime * omega;

    vec3 pos = vec3(cos(angle) * aRadius, position.y, sin(angle) * aRadius);

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    /* Perspective size attenuation, with a floor so distant rim stars stay
       visible as points of light rather than disappearing entirely. */
    gl_PointSize = max(1.0, uSize * aSize * (300.0 / -mvPosition.z));

    vColor = color;
    // Two incommensurate frequencies per star: the field shimmers without any
    // visible collective pulse.
    vAlpha = 0.55 + 0.45 * sin(uTime * (0.6 + aTwinkle) + aTwinkle * 40.0);
  }
`;

const FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    // Round the square point sprite into a soft disc. Squaring the falloff
    // gives a bright centre with a long tail — a star, not a dot.
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    float glow = 1.0 - d * 2.0;
    glow *= glow;

    gl_FragColor = vec4(vColor, glow * vAlpha);
  }
`;

/* -------------------------------------------------------------------------- */
/* Geometry generation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build the star field.
 *
 * The arm distribution is the part worth reading. A uniform random offset from
 * the spiral spine produces a uniform BAND, which reads as a painted stripe.
 * Cubing a signed random instead concentrates stars near the spine and leaves a
 * sparse scatter further out, which is what an arm actually looks like.
 */
function buildGalaxy({ count, arms, radius, spin, thickness, coreColor, armColor, rimColor }) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const radii = new Float32Array(count);
  const angles = new Float32Array(count);
  const sizes = new Float32Array(count);
  const twinkles = new Float32Array(count);

  const cCore = new THREE.Color(coreColor);
  const cArm = new THREE.Color(armColor);
  const cRim = new THREE.Color(rimColor);
  const mixed = new THREE.Color();

  // 12% of the stars form the bulge, 8% the halo, the rest the arms.
  const coreCount = Math.floor(count * 0.12);
  const haloCount = Math.floor(count * 0.08);

  for (let i = 0; i < count; i++) {
    let r;
    let angle;
    let y;
    let size;

    if (i < coreCount) {
      /* --- Central bulge: dense, roughly spherical, hot ------------------- */
      // Fourth power biases hard toward the centre, giving the bright nucleus.
      r = Math.pow(Math.random(), 4) * radius * 0.22;
      angle = Math.random() * Math.PI * 2;
      y = (Math.random() - 0.5) * radius * 0.1 * (1 - r / (radius * 0.25));
      size = 0.6 + Math.random() * 1.1;
    } else if (i < coreCount + haloCount) {
      /* --- Halo: sparse outliers, no hard disc edge ----------------------- */
      r = radius * (0.55 + Math.pow(Math.random(), 0.6) * 0.75);
      angle = Math.random() * Math.PI * 2;
      y = (Math.random() - 0.5) * radius * 0.22;
      size = 0.35 + Math.random() * 0.6;
    } else {
      /* --- Spiral arms ---------------------------------------------------- */
      r = Math.pow(Math.random(), 0.62) * radius;
      const armIndex = i % arms;
      const armAngle = (armIndex / arms) * Math.PI * 2;
      // Logarithmic spiral: the winding grows with radius.
      const spinAngle = r * spin;

      // Cubed scatter — tight on the spine, sparse in the gaps.
      const spread = (1 - r / radius) * 0.35 + 0.12;
      const scatter = Math.pow(Math.random() * 2 - 1, 3) * spread;

      angle = armAngle + spinAngle + scatter;
      // The disc thins toward the rim, as a real one does.
      y = Math.pow(Math.random() * 2 - 1, 3) * thickness * (1 - (r / radius) * 0.65);
      size = 0.4 + Math.random() * 1.0;
    }

    positions[i * 3] = 0; // x/z are rebuilt in the shader from radius+angle
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = 0;

    radii[i] = r;
    angles[i] = angle;
    sizes[i] = size;
    twinkles[i] = Math.random();

    /* Colour by radius: hot core -> arm blue -> cool rim. */
    const t = Math.min(1, r / radius);
    if (t < 0.35) mixed.copy(cCore).lerp(cArm, t / 0.35);
    else mixed.copy(cArm).lerp(cRim, (t - 0.35) / 0.65);
    // Individual variance stops the ramp from banding.
    const v = 0.82 + Math.random() * 0.32;
    colors[i * 3] = mixed.r * v;
    colors[i * 3 + 1] = mixed.g * v;
    colors[i * 3 + 2] = mixed.b * v;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aRadius', new THREE.BufferAttribute(radii, 1));
  geo.setAttribute('aAngle', new THREE.BufferAttribute(angles, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkles, 1));
  // The shader rebuilds x/z every frame, so three's own bounds are wrong and a
  // culling test on them would pop the whole galaxy out of view.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius * 2);
  return geo;
}

/** Radial-gradient sprite used for the nucleus glow and the dust haze. */
function glowTexture(stops) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* -------------------------------------------------------------------------- */

export default function Galaxy({
  count = 90000,
  /**
   * ARMS AND WINDING ARE ONE SETTING, not two.
   *
   * `spin` is radians of twist per unit radius, so the arms wind through
   * `spin × radius` in total. Push that past a full turn and each arm crosses
   * every radial line more than once — with four arms that is eight crossings,
   * and the eye stops resolving arms and sees concentric RINGS instead. (The
   * previous 0.06 × 200 = 12 rad, almost two full turns, did exactly that.)
   *
   * Two arms winding through ~0.65 of a turn is the grand-design spiral shape
   * real photographs are full of, and it stays legible at any zoom.
   */
  arms = 2,
  radius = 180,
  spin = 0.023,
  thickness = 4.6,
  /**
   * Point scale before perspective attenuation. It has to rise with the
   * distance below: the shader divides by view depth, so a galaxy pushed back
   * to z=-740 renders every star at a third the size it had at z=-230.
   */
  starSize = 16,
  /** Radians/second at the very centre; the rim turns far slower. */
  spinSpeed = 0.9,
  coreColor = '#fff3c4',
  armColor = '#7dd3fc',
  rimColor = '#7c5cff',
  /**
   * PLACEMENT IS COMPOSITION, not an arbitrary offset.
   *
   * DISTANCE IS THE WHOLE ILLUSION. A galaxy whose arms sweep past the edges of
   * the frame does not read as a galaxy at all — it reads as a background
   * texture, because nothing real is both that big and that close, and you
   * cannot see a galaxy you are standing inside. But push it far enough and it
   * shrinks behind the HUD and the sky goes empty, which is just as wrong.
   *
   * At ~820 units this 180-unit disc subtends about 12° of half-frame — one
   * distinct OBJECT, sitting in open sky with room around it, still large
   * enough to read its arms.
   *
   * The offsets are angular composition, not decoration: centred, the nucleus —
   * the brightest thing in the scene — sits directly behind her face and blows
   * out her silhouette. Up and to one side it clears her head, stays clear of
   * the status pill along the top edge, and backlights her instead.
   */
  position = [95, 120, -820],
  /** Degrees. Near-zero would show the disc edge-on as a line. */
  tilt = 62,
  roll = -18,
  opacity = 1,
}) {
  const matRef = useRef();
  const coreRef = useRef();

  /* PORTRAIT FIT.
     A phone's frame is less than half as wide as it is tall, so a galaxy framed
     for a desktop window has its whole right-hand side outside the screen — the
     nucleus lands under the HUD and only one arm survives. Pushing it back on a
     narrow viewport fits the disc into the width instead of the height; the
     size is then recovered by scaling the point size by the same factor, so it
     reads identically on both, just further away. */
  const { size } = useThree();
  const push = useMemo(() => {
    const aspect = (size?.width || 1) / (size?.height || 1);
    if (aspect >= 1) return 1;
    /* Gentle on purpose. This scales the whole position vector, so it keeps the
       galaxy's DIRECTION (its place in the frame) and only changes its
       distance, shrinking it to fit a narrow viewport. Overdo it and the disc
       recedes to a smudge behind the HUD; a quarter-strength correction is
       enough to keep both arms inside a phone's width. */
    return THREE.MathUtils.clamp(1 + (1 / aspect - 1) * 0.25, 1, 1.5);
  }, [size?.width, size?.height]);

  const placed = useMemo(() => position.map((v) => v * push), [position, push]);

  const geometry = useMemo(
    () =>
      buildGalaxy({
        count,
        arms,
        radius,
        spin,
        thickness,
        coreColor,
        armColor,
        rimColor,
      }),
    [count, arms, radius, spin, thickness, coreColor, armColor, rimColor]
  );

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uSize: { value: starSize * push },
          uSpin: { value: spinSpeed },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexColors: true,
      }),
    [starSize, spinSpeed, push]
  );

  const glows = useMemo(
    () => ({
      nucleus: glowTexture([
        [0, 'rgba(255,255,255,1)'],
        [0.1, 'rgba(255,246,214,0.9)'],
        [0.26, 'rgba(255,206,120,0.42)'],
        [0.55, 'rgba(190,120,255,0.12)'],
        [1, 'rgba(80,40,160,0)'],
      ]),
      haze: glowTexture([
        [0, 'rgba(150,200,255,0.30)'],
        [0.45, 'rgba(110,140,255,0.13)'],
        [1, 'rgba(60,40,140,0)'],
      ]),
    }),
    []
  );

  // Geometry, shader and canvas textures all hold GPU memory until disposed.
  useMemo(
    () => () => {
      geometry.dispose();
      material.dispose();
      glows.nucleus.dispose();
      glows.haze.dispose();
    },
    [geometry, material, glows]
  );

  useFrame((state) => {
    if (matRef.current) matRef.current.uniforms.uTime.value = state.clock.elapsedTime;
    // Counter-rotate the nucleus sprite very slightly so the core does not look
    // welded to the arms.
    if (coreRef.current) coreRef.current.material.rotation = state.clock.elapsedTime * 0.01;
  });

  const D = Math.PI / 180;

  return (
    <group
      position={placed}
      rotation={[tilt * D, 0, roll * D]}
      renderOrder={-15}
      // The backdrop must never occlude the avatar, whatever its extent.
      frustumCulled={false}
    >
      {/* Broad haze: reads as unresolved starlight and softens the disc. */}
      <sprite scale={[radius * 2.5, radius * 2.5, 1]}>
        <spriteMaterial
          map={glows.haze}
          transparent
          opacity={0.75 * opacity}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </sprite>

      <points geometry={geometry} frustumCulled={false}>
        <primitive object={material} ref={matRef} attach="material" />
      </points>

      {/* Nucleus — the bright heart the arms wind out of. */}
      <sprite ref={coreRef} scale={[radius * 0.85, radius * 0.85, 1]}>
        <spriteMaterial
          map={glows.nucleus}
          transparent
          opacity={0.95 * opacity}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </sprite>
    </group>
  );
}
