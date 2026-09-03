/**
 * ALOO — Avatar mood & interaction bus.
 * ===========================================================================
 * A mutable singleton the render loop reads 60 times a second, in the same
 * spirit as `lipSync.frame`: pointer events and UI state write to it, and
 * `AvatarCanvas` samples it inside `useFrame`. Nothing here goes through React
 * state — a character's attention has to update every frame, and routing that
 * through the reconciler would both jank and re-render the whole HUD.
 *
 * WHAT MAKES A FIGURE READ AS ALIVE (in rough order of payoff):
 *  1. It looks at you — and, crucially, sometimes looks AWAY. A character that
 *     stares without pause reads as a mannequin with a webcam, not a person.
 *  2. It reacts to being touched.
 *  3. It shifts its weight. Nobody stands perfectly still.
 *  4. Its hands are not flat planks — relaxed hands are slightly curled.
 *
 * All four are procedural here, because the bundled rig ships no animation
 * clips at all.
 */

export const mood = {
  /** Where the eyes/head aim, in normalised device coords (-1..1). */
  gaze: { x: 0, y: 0 },

  /** 'user' — track the pointer. 'away' — a scheduled glance elsewhere. */
  attention: 'user',

  /** Timestamp (performance.now) the avatar was last tapped. */
  pokedAt: -1e9,

  /** Where on the body it was tapped, in local metres (y up from the floor). */
  pokePoint: { x: 0, y: 1.2, z: 0 },

  /** Timestamp a greeting wave started; -inf when not waving. */
  wavingAt: -1e9,

  /** 0..1 — how animated the procedural performance should be. */
  energy: 0.6,

  /** Set while the operator is typing, so she looks at the camera attentively. */
  focused: false,
};

/* -------------------------------------------------------------------------- */
/* Idle attention scheduler                                                    */
/* -------------------------------------------------------------------------- */

let scheduler = null;

/**
 * Periodically break eye contact and come back. The intervals are irregular on
 * purpose: a fixed cadence is immediately readable as a loop.
 */
export function startIdleAttention() {
  if (scheduler) return stopIdleAttention;

  const schedule = () => {
    // Look away for 0.8-2.0s, every 5-13s.
    const wait = 5000 + Math.random() * 8000;
    scheduler = setTimeout(() => {
      // Never glance away mid-tap-reaction; that reads as being ignored.
      if (performance.now() - mood.pokedAt > 2500 && !mood.focused) {
        mood.attention = 'away';
        mood.gaze.x = (Math.random() * 2 - 1) * 0.8;
        mood.gaze.y = (Math.random() * 2 - 1) * 0.4;

        setTimeout(() => {
          mood.attention = 'user';
        }, 800 + Math.random() * 1200);
      }
      schedule();
    }, wait);
  };
  schedule();

  return stopIdleAttention;
}

export function stopIdleAttention() {
  if (scheduler) clearTimeout(scheduler);
  scheduler = null;
  mood.attention = 'user';
}

/* -------------------------------------------------------------------------- */
/* Interactions                                                                */
/* -------------------------------------------------------------------------- */

/** Short, varied greetings for the tap reaction. Spoken locally, no API call. */
const GREETINGS = [
  'Hey.',
  'Mm? I am right here.',
  'You have my attention.',
  'Hi again.',
  'Yes?',
  'I am listening.',
];

export function randomGreeting() {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
}

/**
 * Register a tap on the avatar. She snaps her attention to the touch point and,
 * if it was near the upper body, waves.
 *
 * @param {{x:number,y:number,z:number}} point  local-space hit position
 */
export function poke(point) {
  const now = performance.now();
  mood.pokedAt = now;
  mood.attention = 'user';
  if (point) mood.pokePoint = point;
  // Wave only for a shoulders-and-up tap; a wave triggered by a poke to the
  // shin looks like a non-sequitur.
  if (!point || point.y > 1.0) mood.wavingAt = now;
  return now;
}

export function isWaving(now = performance.now()) {
  return now - mood.wavingAt < WAVE_MS;
}

export const WAVE_MS = 1500;

/** 0..1 progress through the current wave, or 0. */
export function waveProgress(now = performance.now()) {
  const t = (now - mood.wavingAt) / WAVE_MS;
  return t >= 0 && t <= 1 ? t : 0;
}

/** 0..1 decaying "was just touched" weight, for attention snapping. */
export function pokeAttention(now = performance.now()) {
  const t = (now - mood.pokedAt) / 2500;
  return t >= 0 && t <= 1 ? 1 - t : 0;
}
