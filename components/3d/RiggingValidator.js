/**
 * ALOO — Automated 3D rigging / blendshape diagnostic engine.
 * ===========================================================================
 * `validateModelRigging(gltf)` walks an imported GLTF and answers the only
 * three questions that decide whether an avatar can actually *perform*:
 *
 *   1. Is there a skeleton, and does it contain the bones we animate
 *      (head look-at, neck, spine breathing, arm idle sway)?
 *   2. Does it expose the morph targets (blendshapes) lip-sync needs —
 *      either the Oculus viseme set, or at minimum mouthOpen/jawOpen?
 *   3. Are there baked animation clips we can play?
 *
 * NAME MATCHING IS FUZZY BY DESIGN. Every pipeline names bones differently —
 * Mixamo prefixes `mixamorig:`, VRM uses `J_Bip_C_Head`, ReadyPlayerMe uses
 * plain `Head`, Blender exports `DEF-spine`. Comparing raw strings would report
 * a perfectly good rig as broken, so we normalise aggressively and match on
 * canonical tokens.
 *
 * The returned report is rendered in the Settings drawer AND printed to the
 * console, per the PRD's "diagnostic status logs" requirement.
 */

/* -------------------------------------------------------------------------- */
/* Canonical requirements                                                      */
/* -------------------------------------------------------------------------- */

/** Bones ALOO's procedural animation actually drives. */
export const REQUIRED_BONES = [
  { key: 'head', label: 'Head', aliases: ['head'], critical: true },
  { key: 'neck', label: 'Neck', aliases: ['neck'], critical: true },
  { key: 'spine', label: 'Spine', aliases: ['spine', 'chest', 'torso'], critical: true },
  { key: 'hips', label: 'Hips / Root', aliases: ['hips', 'pelvis', 'root', 'armature'], critical: false },
  { key: 'leftarm', label: 'Left Arm', aliases: ['leftarm', 'larm', 'upperarml', 'armleft', 'lupperarm', 'shoulderl'], critical: false },
  { key: 'rightarm', label: 'Right Arm', aliases: ['rightarm', 'rarm', 'upperarmr', 'armright', 'rupperarm', 'shoulderr'], critical: false },
  { key: 'jaw', label: 'Jaw', aliases: ['jaw'], critical: false },
  { key: 'lefteye', label: 'Left Eye', aliases: ['lefteye', 'eyel', 'eyeleft'], critical: false },
  { key: 'righteye', label: 'Right Eye', aliases: ['righteye', 'eyer', 'eyeright'], critical: false },
];

/** Oculus/ReadyPlayerMe viseme morphs used by the lip-sync driver. */
export const REQUIRED_VISEMES = [
  'viseme_sil', 'viseme_PP', 'viseme_FF', 'viseme_TH', 'viseme_DD',
  'viseme_kk', 'viseme_CH', 'viseme_SS', 'viseme_nn', 'viseme_RR',
  'viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U',
];

/**
 * The same mouth shape has a different name in every pipeline. VRoid Studio
 * (by far the most common source of anime avatars) exports `Fcl_MTH_A`; ARKit
 * exports `jawOpen` + `mouthFunnel`; ReadyPlayerMe exports `viseme_aa`. Without
 * aliases, a perfectly capable model is graded as having no visemes at all.
 *
 * Each ALOO viseme maps to the candidate names, best first. Matching is
 * case-insensitive.
 */
export const VISEME_ALIASES = {
  sil: ['viseme_sil', 'Fcl_MTH_Close', 'mouthClose', 'sil'],
  PP: ['viseme_PP', 'Fcl_MTH_Close', 'mouthPress', 'PP'],
  FF: ['viseme_FF', 'Fcl_MTH_Fun', 'mouthFunnel', 'FF'],
  TH: ['viseme_TH', 'Fcl_MTH_A', 'tongueOut', 'TH'],
  DD: ['viseme_DD', 'Fcl_MTH_A', 'mouthShrugUpper', 'DD'],
  kk: ['viseme_kk', 'Fcl_MTH_A', 'kk'],
  CH: ['viseme_CH', 'Fcl_MTH_I', 'mouthPucker', 'CH'],
  SS: ['viseme_SS', 'Fcl_MTH_I', 'mouthStretchLeft', 'SS'],
  nn: ['viseme_nn', 'Fcl_MTH_N', 'nn'],
  RR: ['viseme_RR', 'Fcl_MTH_E', 'RR'],
  aa: ['viseme_aa', 'Fcl_MTH_A', 'A', 'aa', 'jawOpen'],
  E: ['viseme_E', 'Fcl_MTH_E', 'E', 'e'],
  I: ['viseme_I', 'Fcl_MTH_I', 'I', 'i'],
  O: ['viseme_O', 'Fcl_MTH_O', 'O', 'o'],
  U: ['viseme_U', 'Fcl_MTH_U', 'U', 'u'],
};

/** Minimum viable mouth control when no viseme set exists. */
export const FALLBACK_MOUTH_MORPHS = [
  'mouthOpen', 'jawOpen', 'mouthOpen_Big', 'JawOpen', 'A', 'Fcl_MTH_A',
];

/** Expression morphs used for blinking and idle life. */
export const REQUIRED_EXPRESSIONS = [
  'eyeBlinkLeft', 'eyeBlinkRight', 'blink', 'eyesClosed',
  'mouthSmile', 'mouthSmileLeft', 'mouthSmileRight', 'browInnerUp',
];

/**
 * Facial expression channels ALOO drives from the emotion director, each with
 * per-pipeline aliases. A model only needs to provide some of them.
 */
export const EXPRESSION_ALIASES = {
  blink: ['eyeBlinkLeft', 'eyeBlinkRight', 'blink', 'eyesClosed', 'Fcl_EYE_Close', 'Blink'],
  smile: [
    'mouthSmile', 'mouthSmileLeft', 'mouthSmileRight',
    'Fcl_MTH_Joy', 'Fcl_ALL_Joy', 'Joy', 'Smile', 'happy',
  ],
  browUp: ['browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'Fcl_BRW_Surprised', 'Surprised'],
  browDown: ['browDownLeft', 'browDownRight', 'Fcl_BRW_Angry', 'Angry'],
  sad: ['mouthFrownLeft', 'mouthFrownRight', 'Fcl_ALL_Sorrow', 'Fcl_MTH_Sorrow', 'Sorrow', 'sad'],
  squint: ['eyeSquintLeft', 'eyeSquintRight', 'Fcl_EYE_Joy'],
};

/** Resolve an alias list against a model's actual morph names. */
export function resolveAliases(morphLookup, aliases) {
  const hits = [];
  for (const name of aliases) {
    const real = morphLookup.get(name.toLowerCase());
    if (real && !hits.includes(real)) hits.push(real);
  }
  return hits;
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/** Lowercase, drop rig prefixes and every separator, so names become comparable. */
export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^mixamorig[:_]?/, '')
    .replace(/^(def|org|mch|ctrl|j_bip_[a-z]_?|bip01_?|bone_)/, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Does a normalised bone name contain any of the aliases? */
function matchesAlias(normalized, aliases) {
  return aliases.some((a) => normalized.includes(a));
}

/* -------------------------------------------------------------------------- */
/* The validator                                                               */
/* -------------------------------------------------------------------------- */

/**
 * @param {Object} gltf  the object returned by GLTFLoader / useGLTF
 * @param {Object} [meta] optional { url, name } for nicer logs
 * @returns {Object} a structured diagnostic report
 */
export function validateModelRigging(gltf, meta = {}) {
  const report = {
    modelUrl: meta.url || 'unknown',
    timestamp: new Date().toISOString(),
    ok: false,
    grade: 'FAIL',
    bones: [],
    boneCount: 0,
    skeletons: [],
    skinnedMeshCount: 0,
    meshCount: 0,
    triangleCount: 0,
    materialNames: [],
    morphTargets: [],
    morphsByMesh: {},
    animations: [],
    boneChecks: [],
    visemeChecks: { found: [], missing: [], coverage: 0 },
    expressionChecks: { found: [], missing: [] },
    mouthFallback: [],
    hasJawBone: false,
    mouthDriveTier: 'none',
    visemeMap: {},
    expressionMap: {},
    warnings: [],
    errors: [],
    log: [],
  };

  const push = (level, message) => report.log.push({ level, message });

  if (!gltf || !gltf.scene) {
    report.errors.push('No GLTF scene was provided — the model failed to load.');
    push('error', 'GLTF scene missing.');
    return report;
  }

  /* -- Traverse ---------------------------------------------------------- */
  const boneNames = new Set();
  const skeletons = new Set();
  const morphSet = new Set();
  const materials = new Set();

  gltf.scene.traverse((node) => {
    if (node.isBone) boneNames.add(node.name);

    if (node.isMesh || node.isSkinnedMesh) {
      report.meshCount++;
      const geo = node.geometry;
      if (geo) {
        const index = geo.index;
        const pos = geo.attributes?.position;
        if (index) report.triangleCount += index.count / 3;
        else if (pos) report.triangleCount += pos.count / 3;
      }
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      mats.forEach((m) => m?.name && materials.add(m.name));

      // Morph targets live in `morphTargetDictionary` — a name -> index map.
      if (node.morphTargetDictionary) {
        const keys = Object.keys(node.morphTargetDictionary);
        report.morphsByMesh[node.name || 'unnamed'] = keys;
        keys.forEach((k) => morphSet.add(k));
      }
    }

    if (node.isSkinnedMesh) {
      report.skinnedMeshCount++;
      if (node.skeleton) {
        skeletons.add(node.skeleton);
        node.skeleton.bones.forEach((b) => b?.name && boneNames.add(b.name));
      }
    }
  });

  report.bones = Array.from(boneNames).sort();
  report.boneCount = report.bones.length;
  report.morphTargets = Array.from(morphSet).sort();
  report.materialNames = Array.from(materials);
  report.triangleCount = Math.round(report.triangleCount);
  report.animations = (gltf.animations || []).map((a) => ({
    name: a.name,
    duration: Number(a.duration?.toFixed?.(2) ?? 0),
    tracks: a.tracks?.length ?? 0,
  }));
  report.skeletons = Array.from(skeletons).map((sk, i) => ({
    index: i,
    boneCount: sk.bones.length,
    root: sk.bones[0]?.name || 'n/a',
  }));

  push('info', `Scene parsed: ${report.meshCount} meshes, ${report.triangleCount.toLocaleString()} triangles.`);

  /* -- 1. Skeleton ------------------------------------------------------- */
  if (!report.boneCount) {
    report.errors.push('No skeleton found. This is a static mesh — bone animation is unavailable.');
    push('error', 'No bones detected in the hierarchy.');
  } else {
    push('ok', `Skeleton found: ${report.boneCount} bones across ${report.skeletons.length || 1} armature(s).`);
  }

  const normalizedBones = report.bones.map((b) => ({ raw: b, norm: normalizeName(b) }));

  /* -- 1b. Which bones actually MOVE anything? ----------------------------
     A bone can exist, be found by name, and deform nothing at all: exporters
     routinely leave locator bones in the skeleton with no vertices weighted to
     them. The bundled avatar is exactly this case — it has LeftEye/RightEye
     bones, so every name-based check passes, yet 0 of its 20,294 vertices are
     weighted to them. Eye tracking then runs every frame and moves nothing, and
     from the outside the model simply "doesn't blink or look around" with no
     explanation anywhere.

     So we check the skin weights, not just the names, and report it. */
  report.inertBones = collectInertBones(gltf);

  report.boneChecks = REQUIRED_BONES.map((req) => {
    const hit = normalizedBones.find((b) => matchesAlias(b.norm, req.aliases));
    const found = !!hit;
    // Found by name but weighted to nothing: present, and useless.
    const inert = found && report.inertBones.includes(hit.raw);

    if (!found) {
      const msg = `Bone "${req.label}" not found.`;
      if (req.critical) {
        report.errors.push(`${msg} Head tracking and posture animation will be limited.`);
        push('error', msg);
      } else {
        report.warnings.push(msg);
        push('warn', msg);
      }
    } else if (inert) {
      const msg =
        `Bone "${req.label}" (${hit.raw}) exists but no vertices are weighted to it — ` +
        'rotating it will not move the mesh.';
      report.warnings.push(msg);
      push('warn', `Bone "${req.label}" → ${hit.raw} (inert: no skin weights)`);
    } else {
      push('ok', `Bone "${req.label}" → ${hit.raw}`);
    }
    return { ...req, found, inert, matchedName: hit?.raw || null };
  });

  // The eye bones are the ones this matters for in practice: a rig whose eyes
  // are inert AND which has no blink blendshape has no eye animation available
  // at all, and the UI should say so rather than leaving the user guessing.
  const eyeChecks = report.boneChecks.filter((b) => /eye/i.test(b.key || ''));
  report.eyeBonesUsable = eyeChecks.length > 0 && eyeChecks.some((b) => b.found && !b.inert);

  /* -- 2. Morph targets / visemes ---------------------------------------- */
  const morphLookup = new Map(report.morphTargets.map((m) => [m.toLowerCase(), m]));

  // Score against the ALIAS table, not the literal Oculus names — a VRoid model
  // has every one of these shapes, just under `Fcl_MTH_*`.
  const visemeFound = [];
  const visemeMissing = [];
  report.visemeMap = {};
  Object.entries(VISEME_ALIASES).forEach(([key, aliases]) => {
    const hit = resolveAliases(morphLookup, aliases)[0];
    if (hit) {
      visemeFound.push(hit);
      report.visemeMap[key] = hit;
    } else {
      visemeMissing.push(`viseme_${key}`);
    }
  });
  report.visemeChecks = {
    found: visemeFound,
    missing: visemeMissing,
    coverage: REQUIRED_VISEMES.length
      ? Math.round((visemeFound.length / REQUIRED_VISEMES.length) * 100)
      : 0,
  };

  report.mouthFallback = FALLBACK_MOUTH_MORPHS.filter((m) => morphLookup.has(m.toLowerCase())).map(
    (m) => morphLookup.get(m.toLowerCase())
  );

  // A jaw bone is a genuine (if coarse) mouth-drive channel, so its presence
  // decides whether "no blendshapes" is a failure or merely a downgrade.
  const jawCheck = report.boneChecks.find((b) => b.key === 'jaw');
  report.hasJawBone = !!jawCheck?.found;

  if (!report.morphTargets.length) {
    if (report.hasJawBone) {
      report.warnings.push(
        'No morph targets (blendshapes) on any mesh. Lip-sync will drive the jaw bone instead — ' +
          'coarser than visemes, but the mouth does open in time with speech.'
      );
      push('warn', `Zero blendshapes; falling back to jaw-bone rotation on "${jawCheck.matchedName}".`);
    } else {
      report.errors.push(
        'No morph targets (blendshapes) and no jaw bone. The mouth cannot be driven at all.'
      );
      push('error', 'Zero blendshapes exported — check "Export Shape Keys" in your DCC tool.');
    }
  } else if (visemeFound.length >= 8) {
    push('ok', `Viseme set present: ${visemeFound.length}/${REQUIRED_VISEMES.length} (${report.visemeChecks.coverage}%).`);
  } else if (report.mouthFallback.length) {
    report.warnings.push(
      `Only ${visemeFound.length}/${REQUIRED_VISEMES.length} visemes found. ` +
        `Falling back to amplitude-driven ${report.mouthFallback.join(' / ')}.`
    );
    push('warn', `Partial viseme coverage; using ${report.mouthFallback.join(', ')} instead.`);
  } else if (report.hasJawBone) {
    report.warnings.push('No usable mouth morphs — driving the jaw bone instead.');
    push('warn', `Using jaw-bone rotation on "${jawCheck.matchedName}".`);
  } else {
    report.errors.push(
      'Neither a viseme set, mouth morphs, nor a jaw bone exist — the mouth cannot be driven.'
    );
    push('error', 'No usable mouth drive channel.');
  }

  const exprFound = [];
  const exprMissing = [];
  report.expressionMap = {};
  Object.entries(EXPRESSION_ALIASES).forEach(([channel, aliases]) => {
    const hits = resolveAliases(morphLookup, aliases);
    if (hits.length) {
      report.expressionMap[channel] = hits;
      exprFound.push(...hits);
    } else {
      exprMissing.push(channel);
    }
  });
  report.expressionChecks = { found: exprFound, missing: exprMissing };
  if (!exprFound.length) {
    report.warnings.push('No blink/expression morphs — blinking will be simulated with eye bones if present.');
    push('warn', 'No expression blendshapes found.');
  } else {
    push('ok', `Expression morphs: ${exprFound.join(', ')}`);
  }

  /* -- 3. Animation clips ------------------------------------------------ */
  if (!report.animations.length) {
    report.warnings.push('No baked animation clips. ALOO will use procedural idle motion only.');
    push('warn', 'No AnimationClips in this GLB.');
  } else {
    push('ok', `Animation clips: ${report.animations.map((a) => a.name).join(', ')}`);
  }

  /* -- 4. Performance sanity --------------------------------------------- */
  if (report.triangleCount > 250000) {
    report.warnings.push(
      `${report.triangleCount.toLocaleString()} triangles is heavy for a real-time avatar; ` +
        'consider decimating below ~150k for smooth 60fps on laptops.'
    );
    push('warn', 'High triangle count.');
  }
  if (report.boneCount > 200) {
    report.warnings.push(`${report.boneCount} bones exceeds the typical 65-bone skinning budget on mobile GPUs.`);
    push('warn', 'High bone count.');
  }

  /* -- Grade -------------------------------------------------------------- */
  const hasSkeleton = report.boneCount > 0;
  const hasMouth =
    visemeFound.length >= 4 || report.mouthFallback.length > 0 || report.hasJawBone;
  const criticalBonesOk = report.boneChecks.filter((b) => b.critical).every((b) => b.found);

  if (hasSkeleton && hasMouth && criticalBonesOk && !report.errors.length) {
    report.grade = 'PASS';
    report.ok = true;
  } else if (hasSkeleton && hasMouth) {
    report.grade = 'DEGRADED';
    report.ok = true;
  } else if (hasSkeleton || hasMouth) {
    report.grade = 'PARTIAL';
    report.ok = false;
  } else {
    report.grade = 'FAIL';
    report.ok = false;
  }

  report.mouthDriveTier =
    visemeFound.length >= 4
      ? 'visemes'
      : report.mouthFallback.length
      ? 'amplitude'
      : report.hasJawBone
      ? 'jaw-bone'
      : 'none';

  logReport(report);
  return report;
}

/** Pretty console output — the PRD's "diagnostic status logs to the console". */
export function logReport(report) {
  if (typeof console === 'undefined') return;
  const style =
    report.grade === 'PASS'
      ? 'color:#34d399;font-weight:bold'
      : report.grade === 'FAIL'
      ? 'color:#f472b6;font-weight:bold'
      : 'color:#fbbf24;font-weight:bold';

  /* eslint-disable no-console */
  console.groupCollapsed(`%c[ALOO] Rigging Diagnostic — ${report.grade}`, style);
  console.log('Model:', report.modelUrl);
  console.log(`Bones: ${report.boneCount} | Meshes: ${report.meshCount} | Tris: ${report.triangleCount}`);
  console.log(`Visemes: ${report.visemeChecks.found.length}/${REQUIRED_VISEMES.length} (${report.visemeChecks.coverage}%)`);
  console.table(
    report.boneChecks.map((b) => ({
      Bone: b.label,
      Found: b.found ? '✔' : '✘',
      MatchedName: b.matchedName || '—',
      Critical: b.critical ? 'yes' : 'no',
    }))
  );
  if (report.morphTargets.length) console.log('Morph targets:', report.morphTargets);
  report.errors.forEach((e) => console.error('✘', e));
  report.warnings.forEach((w) => console.warn('▲', w));
  console.groupEnd();
  /* eslint-enable no-console */
}

/**
 * Build a fast lookup the render loop can use without re-searching every frame:
 * { meshes: [{ mesh, dict, influences }], viseme: {name->[[mesh,idx]]}, ... }
 */
export function buildMorphIndex(scene) {
  const index = { meshes: [], byName: new Map() };
  if (!scene) return index;

  scene.traverse((node) => {
    if (!node.morphTargetDictionary || !node.morphTargetInfluences) return;
    index.meshes.push(node);
    for (const [name, idx] of Object.entries(node.morphTargetDictionary)) {
      const key = name.toLowerCase();
      if (!index.byName.has(key)) index.byName.set(key, []);
      index.byName.get(key).push({ mesh: node, idx });
    }
  });

  return index;
}

/** Set a morph by name across every mesh that owns it. Returns true if applied. */
export function applyMorph(index, name, value) {
  const targets = index.byName.get(String(name).toLowerCase());
  if (!targets) return false;
  for (const { mesh, idx } of targets) {
    mesh.morphTargetInfluences[idx] = value;
  }
  return true;
}

/** Find the first bone whose normalised name matches any alias. */
/**
 * Find a bone by alias.
 *
 * RESOLUTION ORDER IS THE WHOLE POINT, and getting it wrong is subtle enough to
 * be worth spelling out. Aliases are matched by CONTAINMENT, so a short alias
 * can be swallowed by an unrelated bone: `handr` (meant for "hand_R") is a
 * substring of `lefthandring1`, so a naive scan hands you the left ring finger
 * when you asked for the right hand — a wrong bone, not a missing one, which
 * fails silently and looks like a rendering bug.
 *
 * So we resolve in three passes, each across the ENTIRE skeleton:
 *   1. exact match, aliases in the caller's preference order,
 *   2. prefix match — "RightHand" beats "RightHandRing1" for alias `righthand`,
 *   3. containment, still alias-first.
 *
 * Alias order therefore expresses intent: the caller's first alias wins over a
 * later one anywhere in the tree, rather than whichever bone happens to be
 * traversed first.
 */
/**
 * Bones that deform nothing — present in the skeleton, weighted to no vertex.
 *
 * Reads the skinIndex/skinWeight attributes directly. Every vertex references
 * up to four joints; a joint that never appears with a non-trivial weight
 * cannot move a single vertex, so rotating it is a no-op no matter how correct
 * the code driving it is.
 *
 * The 1e-4 floor ignores the numerically-zero weights that exporters emit as
 * padding in the unused slots of the four-wide attribute.
 *
 * @returns {string[]} bone names, sorted
 */
export function collectInertBones(gltf) {
  const root = gltf?.scene || gltf;
  if (!root?.traverse) return [];

  const influential = new Set(); // Skeleton bone objects that move something
  const allBones = new Set();

  root.traverse((node) => {
    if (node.isBone) allBones.add(node);
    if (!node.isSkinnedMesh || !node.skeleton) return;

    const bones = node.skeleton.bones || [];
    bones.forEach((b) => allBones.add(b));

    const idx = node.geometry?.attributes?.skinIndex;
    const wgt = node.geometry?.attributes?.skinWeight;
    if (!idx || !wgt) {
      // No skinning data to judge by — assume every bone is doing its job
      // rather than reporting a false positive.
      bones.forEach((b) => influential.add(b));
      return;
    }

    for (let v = 0; v < idx.count; v++) {
      for (let c = 0; c < 4; c++) {
        if (wgt.getComponent(v, c) > 1e-4) {
          const bone = bones[idx.getComponent(v, c)];
          if (bone) influential.add(bone);
        }
      }
    }
  });

  return [...allBones]
    .filter((b) => !influential.has(b))
    .map((b) => b.name)
    .sort();
}

export function findBone(scene, aliases) {
  const bones = [];
  scene.traverse((node) => {
    if (node.isBone) bones.push({ node, norm: normalizeName(node.name) });
  });

  for (const test of [
    (norm, alias) => norm === alias,
    (norm, alias) => norm.startsWith(alias),
    (norm, alias) => norm.includes(alias),
  ]) {
    for (const alias of aliases) {
      const hit = bones.find((b) => test(b.norm, alias));
      if (hit) return hit.node;
    }
  }
  return null;
}
