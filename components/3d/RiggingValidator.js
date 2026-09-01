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
  { key: 'lefteye', label: 'Left Eye', aliases: ['lefteye', 'eyel', 'eyeleft'], critical: false },
  { key: 'righteye', label: 'Right Eye', aliases: ['righteye', 'eyer', 'eyeright'], critical: false },
];

/** Oculus/ARKit-style viseme morphs used by the lip-sync driver. */
export const REQUIRED_VISEMES = [
  'viseme_sil', 'viseme_PP', 'viseme_FF', 'viseme_TH', 'viseme_DD',
  'viseme_kk', 'viseme_CH', 'viseme_SS', 'viseme_nn', 'viseme_RR',
  'viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U',
];

/** Minimum viable mouth control when no viseme set exists. */
export const FALLBACK_MOUTH_MORPHS = ['mouthOpen', 'jawOpen', 'mouthOpen_Big', 'JawOpen', 'A'];

/** Expression morphs used for blinking and idle life. */
export const REQUIRED_EXPRESSIONS = [
  'eyeBlinkLeft', 'eyeBlinkRight', 'blink', 'eyesClosed',
  'mouthSmile', 'mouthSmileLeft', 'mouthSmileRight', 'browInnerUp',
];

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

  report.boneChecks = REQUIRED_BONES.map((req) => {
    const hit = normalizedBones.find((b) => matchesAlias(b.norm, req.aliases));
    const found = !!hit;
    if (!found) {
      const msg = `Bone "${req.label}" not found.`;
      if (req.critical) {
        report.errors.push(`${msg} Head tracking and posture animation will be limited.`);
        push('error', msg);
      } else {
        report.warnings.push(msg);
        push('warn', msg);
      }
    } else {
      push('ok', `Bone "${req.label}" → ${hit.raw}`);
    }
    return { ...req, found, matchedName: hit?.raw || null };
  });

  /* -- 2. Morph targets / visemes ---------------------------------------- */
  const morphLookup = new Map(report.morphTargets.map((m) => [m.toLowerCase(), m]));

  const visemeFound = [];
  const visemeMissing = [];
  REQUIRED_VISEMES.forEach((v) => {
    const hit = morphLookup.get(v.toLowerCase());
    if (hit) visemeFound.push(hit);
    else visemeMissing.push(v);
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

  if (!report.morphTargets.length) {
    report.errors.push(
      'No morph targets (blendshapes) on any mesh. Lip-sync will fall back to jaw-bone rotation.'
    );
    push('error', 'Zero blendshapes exported — check "Export Shape Keys" in your DCC tool.');
  } else if (visemeFound.length >= 8) {
    push('ok', `Viseme set present: ${visemeFound.length}/${REQUIRED_VISEMES.length} (${report.visemeChecks.coverage}%).`);
  } else if (report.mouthFallback.length) {
    report.warnings.push(
      `Only ${visemeFound.length}/${REQUIRED_VISEMES.length} visemes found. ` +
        `Falling back to amplitude-driven ${report.mouthFallback.join(' / ')}.`
    );
    push('warn', `Partial viseme coverage; using ${report.mouthFallback.join(', ')} instead.`);
  } else {
    report.errors.push(
      'Neither a viseme set nor mouthOpen/jawOpen morphs exist — the mouth cannot be driven.'
    );
    push('error', 'No usable mouth morph targets.');
  }

  const exprFound = [];
  const exprMissing = [];
  REQUIRED_EXPRESSIONS.forEach((e) => {
    const hit = morphLookup.get(e.toLowerCase());
    if (hit) exprFound.push(hit);
    else exprMissing.push(e);
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
  const hasMouth = visemeFound.length >= 4 || report.mouthFallback.length > 0;
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
export function findBone(scene, aliases) {
  let found = null;
  scene.traverse((node) => {
    if (found || !node.isBone) return;
    if (matchesAlias(normalizeName(node.name), aliases)) found = node;
  });
  return found;
}
