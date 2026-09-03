/**
 * ALOO — Procedural animation director.
 * ===========================================================================
 * Generates the avatar's body language at runtime instead of playing canned
 * clips. Nothing here is a recorded animation: every gesture is a small
 * parametric function whose amplitude, timing, side, phase and count are
 * sampled fresh each time it fires. Two playbacks of "nod" are never identical,
 * so the character does not visibly loop no matter how long you watch her.
 *
 * WHY THIS EXISTS
 * The bundled rig ships zero animation clips, and buying or authoring a library
 * of them would still leave the same problem: a fixed set repeats. A generator
 * gives unbounded variety from ~250 lines and no assets.
 *
 * THE THREE LAYERS
 *   1. POSTURE   a slow bias per emotion (lean in when curious, chin up when
 *                confident, shoulders in when apologetic). Always on.
 *   2. GESTURE   discrete motion phrases scheduled on speech beats and idle
 *                timers. This is the layer that generates variety.
 *   3. IDLE      the breathing / weight-shift / look-away already handled in
 *                AvatarCanvas and avatarMood.
 *
 * OUTPUT CONTRACT
 * `director.pose` is a mutable object of ADDITIVE bone offsets in radians,
 * rebuilt every frame and read by AvatarCanvas inside useFrame. Additive means
 * the director never fights the lip-sync, look-at or breathing layers — they
 * all sum onto the same rest pose.
 */

/* -------------------------------------------------------------------------- */
/* Emotions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Each emotion carries a posture bias and a weighted bag of gestures it likes.
 * `pace` scales how often gestures fire; `amp` scales how big they are.
 */
/**
 * `face` is a set of 0..1 weights for the expression channels resolved by
 * RiggingValidator (smile, browUp, browDown, sad, squint). Models without those
 * blendshapes simply ignore them — the body language still carries the emotion.
 */
export const EMOTIONS = {
  neutral: {
    label: 'Neutral',
    pace: 1,
    amp: 0.8,
    posture: { spineX: 0, headX: 0, shoulderY: 0 },
    face: { smile: 0.12 },
    gestures: { nod: 2, tilt: 2, openPalms: 1.5, sway: 2, clasp: 1 },
  },
  warm: {
    label: 'Warm',
    pace: 1.05,
    amp: 0.95,
    posture: { spineX: 0.02, headX: 0.02, shoulderY: -0.01 },
    face: { smile: 0.45, squint: 0.15 },
    gestures: { nod: 3, tilt: 3, handToChest: 2, openPalms: 2, hairTouch: 1.2, sway: 1.5 },
  },
  happy: {
    label: 'Happy',
    pace: 1.25,
    amp: 1.15,
    posture: { spineX: -0.02, headX: -0.02, shoulderY: -0.02 },
    face: { smile: 0.75, squint: 0.3, browUp: 0.2 },
    gestures: { nod: 3, bounce: 2.5, openPalms: 2, handRaise: 1.5, tilt: 2 },
  },
  excited: {
    label: 'Excited',
    pace: 1.55,
    amp: 1.35,
    posture: { spineX: -0.035, headX: -0.03, shoulderY: -0.03 },
    face: { smile: 0.9, squint: 0.35, browUp: 0.45 },
    gestures: { bounce: 3, handRaise: 3, openPalms: 2.5, nod: 2, pointForward: 1.5 },
  },
  thoughtful: {
    label: 'Thoughtful',
    pace: 0.75,
    amp: 0.7,
    posture: { spineX: 0.015, headX: 0.04, shoulderY: 0.005 },
    face: { smile: 0.05, browDown: 0.25, squint: 0.2 },
    gestures: { tilt: 3, handToChin: 2.5, slowNod: 2, hairTouch: 1.5, clasp: 2 },
  },
  curious: {
    label: 'Curious',
    pace: 1.1,
    amp: 0.95,
    posture: { spineX: -0.03, headX: 0.01, shoulderY: 0 },
    face: { smile: 0.2, browUp: 0.5 },
    gestures: { tilt: 4, leanIn: 2.5, openPalms: 1.5, nod: 1.5 },
  },
  concerned: {
    label: 'Concerned',
    pace: 0.85,
    amp: 0.8,
    posture: { spineX: 0.02, headX: 0.035, shoulderY: 0.02 },
    face: { sad: 0.4, browDown: 0.3 },
    gestures: { shake: 2.5, handToChest: 2, tilt: 2, slowNod: 1.5 },
  },
  apologetic: {
    label: 'Apologetic',
    pace: 0.7,
    amp: 0.7,
    posture: { spineX: 0.045, headX: 0.06, shoulderY: 0.03 },
    face: { sad: 0.55, browUp: 0.3, smile: 0.1 },
    gestures: { shrug: 3, handToChest: 2.5, slowNod: 2, tilt: 1.5 },
  },
  confident: {
    label: 'Confident',
    pace: 1.0,
    amp: 1.1,
    posture: { spineX: -0.03, headX: -0.035, shoulderY: -0.02 },
    face: { smile: 0.35, browDown: 0.1 },
    gestures: { pointForward: 2.5, openPalms: 2.5, nod: 2, handRaise: 1.5 },
  },
  playful: {
    label: 'Playful',
    pace: 1.3,
    amp: 1.2,
    posture: { spineX: -0.01, headX: -0.01, shoulderY: -0.015 },
    face: { smile: 0.7, squint: 0.25, browUp: 0.25 },
    gestures: { tilt: 3.5, bounce: 2, hairTouch: 2, shrug: 2, handRaise: 1.5 },
  },
};

/* -------------------------------------------------------------------------- */
/* Text -> emotion                                                             */
/* -------------------------------------------------------------------------- */

// Scored locally rather than asking the model for a tag: it costs nothing, adds
// no latency, cannot be refused or malformed, and works offline in the APK.
const CUES = [
  [/\b(sorry|apolog\w+|unfortunately|afraid i|my mistake|i was wrong|can'?t help)\b/i, 'apologetic', 3],
  [/\b(error|failed|problem|warning|careful|risk|danger|broken|issue)\b/i, 'concerned', 2.2],
  [/\b(hmm+|i think|perhaps|maybe|it depends|on one hand|arguably|roughly|approximately)\b/i, 'thoughtful', 2.2],
  [/\b(what|why|how|which|who|when|where|curious|wonder|tell me)\b/i, 'curious', 1.4],
  [/\b(haha+|lol|funny|joke|hehe|cheeky|silly)\b/i, 'playful', 2.6],
  [/\b(hi|hey|hello|welcome|good (morning|evening|night)|nice to|glad|happy to)\b/i, 'warm', 2],
  [/\b(great|excellent|awesome|amazing|brilliant|love it|perfect|wonderful)\b/i, 'happy', 2.2],
  [/\b(absolutely|definitely|certainly|of course|exactly|precisely|sure thing|no doubt)\b/i, 'confident', 2],
  [/\b(let'?s go|can'?t wait|incredible|wow|whoa|huge|massive)\b/i, 'excited', 2.4],
];

/**
 * Classify a reply into an emotion. Deliberately conservative — a wrong strong
 * emotion is far more jarring than a correct neutral one.
 *
 * @returns {{emotion: string, intensity: number}}
 */
export function classifyEmotion(text, hint) {
  if (hint && EMOTIONS[hint]) return { emotion: hint, intensity: 1 };

  const t = String(text || '').slice(0, 900); // the opening sets the tone
  if (!t.trim()) return { emotion: 'neutral', intensity: 0.6 };

  const scores = {};
  const add = (k, v) => {
    scores[k] = (scores[k] || 0) + v;
  };

  for (const [re, emotion, weight] of CUES) {
    const hits = (t.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) || []).length;
    if (hits) add(emotion, weight * Math.min(hits, 3));
  }

  // Structural signals, independent of vocabulary.
  const exclaims = (t.match(/!/g) || []).length;
  if (exclaims >= 2) add('excited', 1.8);
  else if (exclaims === 1) add('happy', 0.9);
  if (/\?\s*$/.test(t.trim())) add('curious', 1.5);
  if (t.length > 420) add('thoughtful', 1.2); // a long answer is an explanation
  if (t.length < 60) add('warm', 0.5);

  let best = 'neutral';
  let bestScore = 1.1; // neutral's implicit floor — beat it to win
  for (const [k, v] of Object.entries(scores)) {
    if (v > bestScore) {
      best = k;
      bestScore = v;
    }
  }
  return { emotion: best, intensity: Math.min(1, 0.55 + bestScore / 7) };
}

/* -------------------------------------------------------------------------- */
/* Gesture archetypes                                                          */
/* -------------------------------------------------------------------------- */

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = () => (Math.random() < 0.5 ? -1 : 1);

/** Smooth 0->1->0 envelope; `hold` widens the plateau. */
function envelope(u, hold = 0.35) {
  const rise = Math.min(1, u / ((1 - hold) / 2));
  const fall = Math.min(1, (1 - u) / ((1 - hold) / 2));
  const e = Math.min(rise, fall);
  return e * e * (3 - 2 * e); // smoothstep
}

/**
 * Each archetype returns a randomized INSTANCE: duration plus an `apply`
 * closure. Randomising inside the factory is what makes repeats impossible —
 * amplitude, speed, cycle count and handedness are all resampled per fire.
 */
const GESTURES = {
  nod: () => {
    const cycles = Math.round(rand(1, 3));
    const amp = rand(0.06, 0.13);
    return {
      dur: rand(0.7, 1.3),
      apply: (p, u, k) => {
        p.head.x += Math.sin(u * TAU * cycles) * amp * envelope(u, 0.5) * k;
      },
    };
  },

  slowNod: () => {
    const amp = rand(0.05, 0.09);
    return {
      dur: rand(1.4, 2.2),
      apply: (p, u, k) => {
        p.head.x += Math.sin(u * TAU * 1) * amp * envelope(u, 0.6) * k;
        p.spine.x += Math.sin(u * TAU * 1) * amp * 0.25 * k;
      },
    };
  },

  shake: () => {
    const cycles = Math.round(rand(2, 3));
    const amp = rand(0.07, 0.12);
    return {
      dur: rand(0.8, 1.2),
      apply: (p, u, k) => {
        p.head.y += Math.sin(u * TAU * cycles) * amp * envelope(u, 0.4) * k;
      },
    };
  },

  tilt: () => {
    const side = pick();
    const amp = rand(0.08, 0.17) * side;
    return {
      dur: rand(1.2, 2.6),
      apply: (p, u, k) => {
        const e = envelope(u, 0.65);
        p.head.z += amp * e * k;
        p.neck.z += amp * 0.3 * e * k;
      },
    };
  },

  leanIn: () => {
    const amp = rand(0.04, 0.075);
    return {
      dur: rand(1.6, 3.0),
      apply: (p, u, k) => {
        const e = envelope(u, 0.7);
        p.spine.x -= amp * e * k;
        p.head.x -= amp * 0.4 * e * k;
      },
    };
  },

  bounce: () => {
    const cycles = Math.round(rand(2, 4));
    const amp = rand(0.012, 0.026);
    return {
      dur: rand(0.6, 1.1),
      apply: (p, u, k) => {
        const e = envelope(u, 0.3);
        p.root.y += Math.abs(Math.sin(u * TAU * cycles * 0.5)) * amp * e * k;
        p.spine.x -= Math.sin(u * TAU * cycles * 0.5) * 0.02 * e * k;
      },
    };
  },

  shrug: () => {
    const amp = rand(0.06, 0.11);
    const fore = rand(0.35, 0.6);
    return {
      dur: rand(1.0, 1.8),
      apply: (p, u, k) => {
        const e = envelope(u, 0.5);
        // Shoulders lift; the palms turn up via the forearms. The upper arms
        // barely move, which is what a real shrug looks like.
        p.leftShoulder.z -= amp * e * k;
        p.rightShoulder.z += amp * e * k;
        p.leftArm.z -= 0.06 * e * k;
        p.rightArm.z += 0.06 * e * k;
        p.leftForeArm.y += fore * e * k;
        p.rightForeArm.y -= fore * e * k;
        p.head.x += 0.03 * e * k;
      },
    };
  },

  /*
   * ARM GESTURES, ANATOMICALLY
   * ---------------------------------------------------------------------
   * The rig rests in an A-pose (upper arms rotated ~74 deg down from the
   * T-pose bind). On that frame, upper-arm Z is ABDUCTION: pushing it swings
   * the arm back up toward horizontal, and a large value plants the arm
   * straight out sideways like a scarecrow.
   *
   * So every gesture below keeps the upper arm near its rest (|Z| <= ~0.22)
   * and does the expressive work in the FOREARM — which is also how people
   * actually gesture: the elbow moves, the shoulder mostly does not.
   * `fore.y` is elbow flexion, signed per side (+ for left, - for right).
   */

  openPalms: () => {
    const amp = rand(0.55, 0.95);
    const asym = rand(0.75, 1.0);
    return {
      dur: rand(1.2, 2.2),
      apply: (p, u, k) => {
        const e = envelope(u, 0.55);
        // A little clearance from the body, then open the forearms outward.
        p.leftArm.z -= 0.09 * e * k;
        p.rightArm.z += 0.09 * asym * e * k;
        p.leftArm.x -= 0.1 * e * k;
        p.rightArm.x -= 0.1 * asym * e * k;
        p.leftForeArm.y += amp * e * k;
        p.rightForeArm.y -= amp * asym * e * k;
      },
    };
  },

  handRaise: () => {
    const side = pick();
    const amp = rand(0.8, 1.15);
    const wob = rand(1.5, 3);
    return {
      dur: rand(1.1, 2.0),
      apply: (p, u, k) => {
        const e = envelope(u, 0.45);
        const arm = side < 0 ? p.leftArm : p.rightArm;
        const fore = side < 0 ? p.leftForeArm : p.rightForeArm;
        // Shoulder flexes FORWARD (x), not outward (z) — that is what lifts a
        // hand into view instead of throwing the arm out to the side.
        arm.x -= 0.22 * e * k;
        arm.z += -side * 0.08 * e * k;
        fore.y += -side * amp * e * k; // elbow does the lifting
        fore.z += Math.sin(u * TAU * wob) * 0.14 * e * k;
      },
    };
  },

  pointForward: () => {
    const side = pick();
    const amp = rand(0.6, 0.9);
    return {
      dur: rand(0.9, 1.6),
      apply: (p, u, k) => {
        const e = envelope(u, 0.4);
        const arm = side < 0 ? p.leftArm : p.rightArm;
        const fore = side < 0 ? p.leftForeArm : p.rightForeArm;
        arm.x -= 0.2 * e * k;
        arm.z += -side * 0.06 * e * k;
        fore.y += -side * amp * e * k;
        p.spine.x -= 0.015 * e * k;
      },
    };
  },

  handToChest: () => {
    const side = pick();
    const amp = rand(0.9, 1.25);
    return {
      dur: rand(1.4, 2.4),
      apply: (p, u, k) => {
        const e = envelope(u, 0.6);
        const arm = side < 0 ? p.leftArm : p.rightArm;
        const fore = side < 0 ? p.leftForeArm : p.rightForeArm;
        arm.x -= 0.14 * e * k;
        arm.z += side * 0.05 * e * k; // tuck slightly IN toward the body
        fore.y += -side * amp * e * k;
        p.head.x += 0.02 * e * k;
      },
    };
  },

  handToChin: () => {
    const side = pick();
    return {
      dur: rand(1.8, 3.2),
      apply: (p, u, k) => {
        const e = envelope(u, 0.7);
        const arm = side < 0 ? p.leftArm : p.rightArm;
        const fore = side < 0 ? p.leftForeArm : p.rightForeArm;
        arm.x -= 0.2 * e * k;
        arm.z += side * 0.04 * e * k;
        fore.y += -side * 1.25 * e * k; // deep elbow flexion brings it to the face
        p.head.z += side * 0.05 * e * k;
        p.head.x += 0.03 * e * k;
      },
    };
  },

  hairTouch: () => {
    const side = pick();
    return {
      dur: rand(1.6, 2.8),
      apply: (p, u, k) => {
        const e = envelope(u, 0.55);
        const arm = side < 0 ? p.leftArm : p.rightArm;
        const fore = side < 0 ? p.leftForeArm : p.rightForeArm;
        arm.z += -side * 0.18 * e * k;
        arm.x -= 0.2 * e * k;
        fore.y += -side * 1.2 * e * k;
        p.head.z += -side * 0.05 * e * k;
      },
    };
  },

  clasp: () => {
    const amp = rand(0.75, 1.0);
    return {
      dur: rand(2.0, 3.5),
      apply: (p, u, k) => {
        const e = envelope(u, 0.75);
        // Hands meet in front: elbows flex, upper arms stay tucked in.
        p.leftArm.z += 0.05 * e * k;
        p.rightArm.z -= 0.05 * e * k;
        p.leftForeArm.y += amp * e * k;
        p.rightForeArm.y -= amp * e * k;
      },
    };
  },

  sway: () => {
    const side = pick();
    return {
      dur: rand(2.4, 4.2),
      apply: (p, u, k) => {
        const e = envelope(u, 0.75);
        p.hips.y += side * 0.035 * e * k;
        p.spine.y -= side * 0.02 * e * k;
        p.head.y += side * 0.015 * e * k;
      },
    };
  },
};

export const GESTURE_NAMES = Object.keys(GESTURES);

/** Weighted pick from an emotion's bag, skipping the gesture just played. */
function chooseGesture(emotion, avoid) {
  const bag = EMOTIONS[emotion]?.gestures || EMOTIONS.neutral.gestures;
  const entries = Object.entries(bag).filter(([name]) => name !== avoid && GESTURES[name]);
  if (!entries.length) return 'nod';
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = Math.random() * total;
  for (const [name, w] of entries) {
    r -= w;
    if (r <= 0) return name;
  }
  return entries[0][0];
}

/* -------------------------------------------------------------------------- */
/* The director                                                                */
/* -------------------------------------------------------------------------- */

const CHANNELS = [
  'head', 'neck', 'spine', 'hips', 'root',
  'leftShoulder', 'rightShoulder',
  'leftArm', 'rightArm',
  'leftForeArm', 'rightForeArm',
];

/**
 * Per-channel ceilings in radians. Two gestures may overlap, and an excited
 * emotion multiplies both — without a clamp the sum can reach ~73° on a limb
 * and the character snaps into a pose no body makes. Necks and spines get tight
 * limits because that is where over-rotation looks broken rather than lively.
 */
const LIMITS = {
  head: 0.34,
  neck: 0.18,
  spine: 0.16,
  hips: 0.12,
  root: 0.05,
  leftShoulder: 0.18,
  rightShoulder: 0.18,
  // UPPER ARMS ARE DELIBERATELY TIGHT. The rig rests in an A-pose, so a large
  // positive/negative Z on the upper arm rotates it back toward the T-pose and
  // the arm ends up sticking straight out sideways — which looks broken, not
  // expressive. Real conversational gesture is almost all forearm and hand
  // anyway; the shoulder barely moves.
  leftArm: 0.3,
  rightArm: 0.3,
  leftForeArm: 1.3,
  rightForeArm: 1.3,
};

const clamp = (v, lim) => (v > lim ? lim : v < -lim ? -lim : v);

const FACE_CHANNELS = ['smile', 'browUp', 'browDown', 'sad', 'squint'];

function blankPose() {
  const p = {};
  for (const c of CHANNELS) p[c] = { x: 0, y: 0, z: 0 };
  // Facial weights live alongside the bone offsets so the avatar reads one
  // object per frame instead of two.
  p.face = {};
  for (const f of FACE_CHANNELS) p.face[f] = 0;
  return p;
}

class AnimationDirector {
  constructor() {
    /** Additive bone offsets, rebuilt every frame. Read, never replace. */
    this.pose = blankPose();

    this.emotion = 'neutral';
    this.intensity = 0.7;
    this.intensityTarget = 0.7;
    this.state = 'idle'; // idle | listening | thinking | speaking

    this.active = [];
    this.nextGestureIn = 2;
    this.lastGesture = null;
    this.enabled = true;
    this.scale = 1; // user-facing gesture intensity multiplier
    this.faceScale = 1; // user-facing facial expression multiplier

    this.listeners = new Set();
    this.history = []; // recent gestures, for the HUD read-out
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    const snapshot = {
      emotion: this.emotion,
      label: EMOTIONS[this.emotion]?.label || 'Neutral',
      intensity: this.intensity,
      state: this.state,
      last: this.history[0] || null,
    };
    this.listeners.forEach((fn) => {
      try {
        fn(snapshot);
      } catch (err) {
        console.error('[ALOO/anim] listener threw:', err);
      }
    });
  }

  setEmotion(emotion, intensity = 0.8) {
    if (!EMOTIONS[emotion]) emotion = 'neutral';
    const changed = emotion !== this.emotion;
    this.emotion = emotion;
    this.intensityTarget = Math.max(0.3, Math.min(1, intensity));
    if (changed) {
      // A new feeling shows up immediately rather than waiting for the timer.
      this.nextGestureIn = Math.min(this.nextGestureIn, 0.35);
      this.emit();
    }
  }

  /** Classify a reply and adopt its emotion. */
  setEmotionFromText(text, hint) {
    const { emotion, intensity } = classifyEmotion(text, hint);
    this.setEmotion(emotion, intensity);
    return emotion;
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    // Starting to speak should land a gesture almost immediately — a beat of
    // stillness at the start of a sentence reads as a freeze.
    if (state === 'speaking') this.nextGestureIn = Math.min(this.nextGestureIn, 0.25);
    if (state === 'thinking') this.setEmotion('thoughtful', 0.7);
    this.emit();
  }

  /** Fire a gesture now. Omit `name` to let the emotion choose. */
  trigger(name) {
    const key = name && GESTURES[name] ? name : chooseGesture(this.emotion, this.lastGesture);
    const instance = GESTURES[key]();
    instance.t = 0;
    instance.name = key;
    this.active.push(instance);
    this.lastGesture = key;
    this.history.unshift(key);
    if (this.history.length > 6) this.history.pop();
    this.emit();
    return key;
  }

  /**
   * Advance one frame and rebuild `pose`.
   * @param {number} dt seconds
   * @param {{speaking:boolean, energy:number}} ctx
   */
  update(dt, ctx = {}) {
    const p = this.pose;
    for (const c of CHANNELS) {
      p[c].x = 0;
      p[c].y = 0;
      p[c].z = 0;
    }
    for (const f of FACE_CHANNELS) p.face[f] = 0;
    if (!this.enabled) return p;

    // Ease intensity so an emotion change is a transition, not a jump.
    this.intensity += (this.intensityTarget - this.intensity) * Math.min(1, dt * 2.5);

    const em = EMOTIONS[this.emotion] || EMOTIONS.neutral;
    const gain = this.intensity * this.scale * em.amp;

    /* ---- Layer 0: facial expression ----
       Eased by the same intensity as the body, so a face and a posture always
       agree. Scaled by `faceScale` rather than the gesture scale: someone may
       want big gestures and a subtle face, or the reverse. */
    const face = em.face || {};
    for (const f of FACE_CHANNELS) {
      p.face[f] = (face[f] || 0) * this.intensity * this.faceScale;
    }

    /* ---- Layer 1: posture bias ---- */
    p.spine.x += em.posture.spineX * gain;
    p.head.x += em.posture.headX * gain;
    p.leftShoulder.z += em.posture.shoulderY * gain;
    p.rightShoulder.z -= em.posture.shoulderY * gain;

    /* ---- Layer 2: gestures ---- */
    for (let i = this.active.length - 1; i >= 0; i--) {
      const g = this.active[i];
      g.t += dt;
      const u = g.t / g.dur;
      if (u >= 1) {
        this.active.splice(i, 1);
        continue;
      }
      g.apply(p, u, gain);
    }

    /* ---- Scheduling ---- */
    this.nextGestureIn -= dt;
    if (this.nextGestureIn <= 0) {
      // Speaking gestures come thick and fast; idle ones are sparse. Speech
      // energy nudges the cadence so loud emphasis attracts movement.
      const speaking = !!ctx.speaking;
      const base = speaking ? 2.1 : 8.5;
      const spread = speaking ? 1.6 : 7;
      const energyBias = speaking ? 1 - Math.min(0.45, (ctx.energy || 0) * 0.5) : 1;
      const wait = ((base + Math.random() * spread) / em.pace) * energyBias;

      // Never stack more than two gestures: three at once reads as a seizure.
      if (this.active.length < 2) this.trigger();
      this.nextGestureIn = wait;
    }

    /* ---- Safety clamp ---- */
    for (const c of CHANNELS) {
      const lim = LIMITS[c];
      p[c].x = clamp(p[c].x, lim);
      p[c].y = clamp(p[c].y, lim);
      p[c].z = clamp(p[c].z, lim);
    }

    return p;
  }

  reset() {
    this.active.length = 0;
    this.pose = blankPose();
    this.emotion = 'neutral';
    this.intensity = this.intensityTarget = 0.7;
    this.emit();
  }
}

export const director = new AnimationDirector();

/**
 * DEV AFFORDANCE: tune emotions and gestures from the console without needing a
 * conversation to drive them —
 *
 *   __alooDirector.setEmotion('excited', 1)
 *   __alooDirector.trigger('handRaise')
 *   __alooDirector.setState('speaking')
 *
 * Guarded to development so it is not part of the shipped surface.
 */
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  window.__alooDirector = director;
}
