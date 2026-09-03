/**
 * ALOO — palm stars.
 * ===========================================================================
 * A small burning star hovering in each palm. It is the one piece of the scene
 * that is pure spectacle, so it is built to read as LIGHT rather than as a
 * glowing ball of geometry:
 *
 *   • a white-hot core that is deliberately over-bright (toneMapped:false, so
 *     the renderer does not compress it back into the sky's dynamic range),
 *   • a soft additive halo whose falloff is drawn, not faked with opacity,
 *   • a four-point flare — the streaks the eye reads as "star", not "sphere",
 *   • a real PointLight, which is what actually sells it: the star lights her
 *     fingers and sleeves, so it belongs to the scene instead of floating in
 *     front of it.
 *
 * POSITIONING — why world-space and not `bone.add(star)`
 * Parenting to the hand bone is one line, but it inherits the rig's transform,
 * and this project's avatar is authored 23 units tall and auto-fitted down by
 * ~0.074. Any radius written in metres would come out 13× too big, and a model
 * with different units would break it again. So the stars live outside the rig
 * and copy the hand bones' WORLD position each frame, which makes every size
 * here a true world metre for any model the user loads.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { lipSync } from '@/services/ttsLipSyncService';

/* Scratch — never allocate inside useFrame. */
const tmpVec = new THREE.Vector3();
const tmpChild = new THREE.Vector3();
const tmpScaleVec = new THREE.Vector3();
const tmpQuatScratch = new THREE.Quaternion();

/**
 * A hand bone sits at the WRIST, so anchoring there buries the star in her
 * sleeve. The palm is roughly on the line from the wrist to the base of the
 * middle finger, so we borrow that child bone as a direction and push out along
 * it. Deriving the direction from the rig (rather than assuming a local axis)
 * means it stays correct as the hand rotates, and for any rig's bone
 * orientation convention.
 */
function palmChild(handBone) {
  if (!handBone) return null;
  const kids = handBone.children?.filter((c) => c.isBone) || [];
  if (!kids.length) return null;
  return kids.find((c) => /middle|mid/i.test(c.name)) || kids[Math.floor(kids.length / 2)];
}

/**
 * Radial-gradient sprite, drawn once into a canvas.
 *
 * `stops` is a list of [offset, 'rgba(...)'] — the falloff is authored
 * explicitly because a linear alpha ramp reads as a flat disc, while a steep
 * inner falloff with a long tail reads as glare.
 */
function radialTexture(size, stops) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [offset, color] of stops) g.addColorStop(offset, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A horizontal streak — two of these crossed make the flare. */
function streakTexture(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.42, 'rgba(150,225,255,0.35)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.58, 'rgba(150,225,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Taper vertically so the streak ends in a point rather than a rectangle.
  const taper = ctx.createLinearGradient(0, 0, 0, h);
  taper.addColorStop(0, 'rgba(0,0,0,1)');
  taper.addColorStop(0.5, 'rgba(0,0,0,0)');
  taper.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = taper;
  ctx.fillRect(0, 0, w, h);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * One star. Kept as its own component so each palm owns its phase offset and
 * the two never pulse in lockstep — synchronised twins read as a UI effect,
 * offset ones read as two independent objects.
 */
function Star({ bone, phase, radius, color, glowColor, brightness }) {
  const root = useRef();
  const coreRef = useRef();
  const haloRef = useRef();
  const flareRef = useRef();
  const lightRef = useRef();

  const assets = useMemo(() => {
    const halo = radialTexture(128, [
      [0, 'rgba(255,255,255,1)'],
      [0.12, 'rgba(215,245,255,0.85)'],
      [0.32, 'rgba(90,200,255,0.34)'],
      [0.62, 'rgba(40,120,220,0.10)'],
      [1, 'rgba(20,60,160,0)'],
    ]);
    const flare = streakTexture(256, 64);
    return {
      halo,
      flare,
      haloMat: new THREE.SpriteMaterial({
        map: halo,
        color: glowColor,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
      flareMat: new THREE.MeshBasicMaterial({
        map: flare,
        color: glowColor,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
      coreMat: new THREE.MeshBasicMaterial({ color, toneMapped: false }),
      shellMat: new THREE.MeshBasicMaterial({
        color: glowColor,
        transparent: true,
        opacity: 0.42,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    };
  }, [color, glowColor]);

  // Canvas textures and materials are not garbage collected by three — they
  // hold GPU allocations until disposed explicitly.
  useEffect(
    () => () => {
      assets.halo.dispose();
      assets.flare.dispose();
      assets.haloMat.dispose();
      assets.flareMat.dispose();
      assets.coreMat.dispose();
      assets.shellMat.dispose();
    },
    [assets]
  );

  const finger = useMemo(() => palmChild(bone), [bone]);

  useFrame((state, delta) => {
    const g = root.current;
    if (!g) return;

    // No hand bone (a rig without one, or the procedural fallback): hide rather
    // than stranding a star at the origin.
    if (!bone) {
      g.visible = false;
      return;
    }
    g.visible = true;

    /* ---- Follow the palm ------------------------------------------------- */
    bone.getWorldPosition(tmpVec);
    if (finger) {
      // Push past the wrist and out over the fingers, so the star hovers in the
      // open hand rather than inside the sleeve.
      // 1.65 ≈ just past the knuckles: the core sits in the curl of the fingers
      // rather than at the wrist (0) or floating off the fingertips (>2).
      finger.getWorldPosition(tmpChild);
      tmpVec.lerp(tmpChild, 1.65);
    }
    if (g.parent) g.parent.worldToLocal(tmpVec);
    // Frame-rate independent smoothing: 0.0001 of the error survives each second.
    g.position.lerp(tmpVec, 1 - Math.pow(0.0001, delta));

    /* ---- Keep a true world size regardless of the rig's units ------------- */
    if (g.parent) {
      g.parent.matrixWorld.decompose(tmpVec, tmpQuatScratch, tmpScaleVec);
      const parentScale = Math.max(tmpScaleVec.x, 1e-6);
      const s = 1 / parentScale;
      if (Math.abs(g.scale.x - s) > 1e-5) g.scale.setScalar(s);
    }

    /* ---- Burn ------------------------------------------------------------ */
    const t = state.clock.elapsedTime + phase;
    // Three incommensurate frequencies: the flicker never visibly repeats.
    const flicker =
      0.82 + Math.sin(t * 5.3) * 0.07 + Math.sin(t * 11.7) * 0.045 + Math.sin(t * 2.1) * 0.065;
    // Flare with her voice — the star answers when she speaks.
    const voice = lipSync.frame?.speaking ? (lipSync.frame.energy || 0) * 0.55 : 0;
    const pulse = (flicker + voice) * brightness;

    if (coreRef.current) coreRef.current.scale.setScalar(radius * (0.92 + pulse * 0.12));
    if (haloRef.current) {
      const h = radius * 9.5 * (0.9 + pulse * 0.22);
      haloRef.current.scale.set(h, h, 1);
      haloRef.current.material.opacity = 0.5 + pulse * 0.42;
    }
    if (flareRef.current) {
      flareRef.current.rotation.z += delta * 0.25;
      const f = radius * (10 + pulse * 3.2);
      flareRef.current.scale.set(f, f, f);
      flareRef.current.children.forEach((c) => {
        c.material.opacity = 0.34 + pulse * 0.4;
      });
    }
    if (lightRef.current) lightRef.current.intensity = pulse * 2.6 * radius * 26;
  });

  return (
    <group ref={root}>
      {/* White-hot centre. Deliberately unlit and untonemapped. */}
      <mesh ref={coreRef} material={assets.coreMat}>
        <icosahedronGeometry args={[1, 3]} />
      </mesh>

      {/* Plasma shell just outside the core. */}
      <mesh scale={radius * 2.1} material={assets.shellMat}>
        <icosahedronGeometry args={[1, 2]} />
      </mesh>

      {/* Camera-facing glare. */}
      <sprite ref={haloRef} material={assets.haloMat} />

      {/* Four-point flare: two crossed streaks, slowly rotating. */}
      <group ref={flareRef}>
        <mesh material={assets.flareMat}>
          <planeGeometry args={[1, 0.25]} />
        </mesh>
        <mesh material={assets.flareMat} rotation={[0, 0, Math.PI / 2]}>
          <planeGeometry args={[1, 0.25]} />
        </mesh>
      </group>

      {/* The part that makes it real: it lights her hands. */}
      <pointLight ref={lightRef} color={glowColor} distance={radius * 60} decay={2} />
    </group>
  );
}

/**
 * Both palm stars.
 *
 * @param {Object}  bones       the rig's bone map (needs leftHand / rightHand)
 * @param {boolean} enabled
 * @param {number}  size        star radius in world metres
 * @param {number}  brightness  overall intensity multiplier
 */
export default function HandStars({ bones, enabled = true, size = 0.035, brightness = 1 }) {
  if (!enabled) return null;
  return (
    <group>
      <Star
        bone={bones?.leftHand}
        phase={0}
        radius={size}
        color="#ffffff"
        glowColor="#7fd8ff"
        brightness={brightness}
      />
      <Star
        bone={bones?.rightHand}
        // Half a beat out of step with the left one.
        phase={3.7}
        radius={size}
        color="#ffffff"
        glowColor="#9ec2ff"
        brightness={brightness}
      />
    </group>
  );
}
