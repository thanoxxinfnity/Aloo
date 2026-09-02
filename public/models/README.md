# 3D assets

## What is bundled

| File | What it is | Diagnostic grade |
|---|---|---|
| `avatar.glb` | *Mika Melatika*, rigged humanoid — 55 bones, 28,253 triangles, unlit anime shading | **PARTIAL** — full skeleton, **no blendshapes** |
| `space.glb` | A galaxy disc of ~8,000 star quads (Sketchfab export) | n/a — static mesh |

### The avatar's rig, precisely

Run the app and open **Settings → Rig Diagnostics** (or the browser console) for
the live report. The summary:

| Check | Result |
|---|---|
| Skeleton | ✅ 55 bones — `Hips → Spine → Spine1 → Spine2 → Neck → Head`, both arms with **all finger joints**, both legs to the toes |
| Head / Neck / Spine | ✅ present — head look-at, breathing and speech motion all work |
| Viseme blendshapes | ❌ **0 of 15** |
| `mouthOpen` / `jawOpen` morphs | ❌ none |
| Jaw bone | ❌ none |
| Eye bones / blink morphs | ❌ none |
| Baked animation clips | ❌ none — ALOO supplies procedural idle motion and the A-pose |

**So: the model is rigged for body animation, but it carries no facial rig at
all.** Lip-sync by morph target is therefore impossible with this file — there
is nothing on the mesh to drive. ALOO falls back to its body-performance layer
(head nods at syllable rate, tilt, torso rotation, arm gestures), which reads as
talking but is not lip movement.

To get real lip-sync, the mouth needs shape keys. Either add `viseme_*` (or at
minimum `mouthOpen`) shape keys to this mesh in Blender, or use a
ReadyPlayerMe export — see *Getting a model that just works* below. Drop the new
file in as `avatar.glb` and the validator will re-grade it on the next reload;
nothing else needs changing.

## Bringing your own

Both files are **optional** — ALOO renders a procedural holo-construct and
starfield when they are absent, so the app is fully usable before you have any
assets.

| File | Role | Notes |
|---|---|---|
| `avatar.glb` | Foreground character | Needs a skeleton. Viseme blendshapes strongly recommended. |
| `space.glb` | Background environment | Auto-recentred, scaled to the configured size and pushed behind the avatar with `depthWrite` disabled, so it never occludes anything. |

Paths are configurable at runtime in **Settings → Holographic Projection** — a
remote `https://` URL works as well as a local file. Draco-compressed GLBs load
fine; the decoder is fetched on demand.

`.glb` / `.gltf` / `.bin` files in this folder are gitignored, since they are
usually large binaries.

---

## What the avatar needs

`components/3d/RiggingValidator.js` inspects the model on load and grades it.
Open **Settings → Rig Diagnostics** (or the browser console) to see the report.

### Bones — matched fuzzily

Naming conventions differ per pipeline, so `mixamorig:Head`, `J_Bip_C_Head`,
`DEF-head` and `Head` all match. ALOO drives:

| Bone | Used for | Critical |
|---|---|---|
| Head | look-at toward the pointer, speaking nods | yes |
| Neck | secondary follow at ⅓ the head angle | yes |
| Spine / Chest | breathing (~14/min at rest, faster while speaking) | yes |
| Hips / Root | micro-sway | no |
| Left/Right Arm | idle motion | no |
| Left/Right Eye | reserved | no |

### Mouth — three tiers, best available wins

1. **Full viseme set** (highest fidelity) — the 15 Oculus morphs
   `viseme_sil`, `viseme_PP`, `viseme_FF`, `viseme_TH`, `viseme_DD`,
   `viseme_kk`, `viseme_CH`, `viseme_SS`, `viseme_nn`, `viseme_RR`,
   `viseme_aa`, `viseme_E`, `viseme_I`, `viseme_O`, `viseme_U`.
2. **Amplitude fallback** — any of `mouthOpen`, `jawOpen`, `JawOpen`,
   `mouthOpen_Big`, `A`, driven by loudness alone.
3. **Jaw bone** — direct rotation of a bone named `jaw`, up to ~17°.

### Expressions — optional but they add a lot

`eyeBlinkLeft`, `eyeBlinkRight`, `blink`, `eyesClosed`, `mouthSmile`,
`mouthSmileLeft`, `mouthSmileRight`, `browInnerUp`.

Blinking runs on an irregular 2.2–6.4s timer, independent of speech.

---

## Getting a model that just works

**ReadyPlayerMe** (free, ~30 seconds):

1. Create an avatar at <https://readyplayer.me>.
2. Copy the download URL and append:
   `?morphTargets=ARKit,Oculus%20Visemes&textureAtlas=1024`
3. Save the result as `avatar.glb` here.

That export carries the complete viseme set and grades **PASS**.

**Mixamo**: rigs are good but ship no blendshapes, so lip-sync drops to the
jaw-bone tier. Add shape keys in Blender if you want tier 1.

**Blender exports**: enable *Include → Shape Keys* and *Data → Mesh → Apply
Modifiers* on the glTF exporter, or the morph targets will not survive.

---

## Scale and orientation

**You do not need to match any unit convention.** `autoFit` (on by default)
measures the model's bounding box on load and normalises it to
`avatarTargetHeight` (1.72 m) with the lowest vertex on the floor. The bundled
avatar, for example, arrives 23.3 units tall and is scaled by 0.0738
automatically — the measurement is logged to the console on every load.

The bundled environment is likewise recentred and scaled. Note it is a **galaxy
disc, not a skybox**: it is placed *behind* the avatar (distance, height and tilt
are all sliders under Settings → Holographic Projection) rather than wrapped
around the camera, because inside the disc the individual star quads read as
grey slabs instead of stars.

ALOO assumes a Y-up, Z-forward model standing with its feet at `y = 0`. The
camera presets frame a figure roughly 1.7 m tall:

| Preset | Camera | Looks at |
|---|---|---|
| Close-Up (Facial Focus) | `[0, 1.58, 0.82]` | `[0, 1.55, 0]` |
| Upper Body (Standard) | `[0, 1.46, 1.95]` | `[0, 1.34, 0]` |
| Full View | `[0, 1.15, 3.70]` | `[0, 0.95, 0]` |

If auto-fit gets it wrong (an unusual origin, a model lying down), switch it off
and use the **Avatar Scale** and **Offset X/Y/Z** sliders instead of re-exporting.

### T-pose

Rigs without an idle clip stand in a T-pose, which reads as a mannequin. **Auto
A-Pose** rotates the upper-arm bones down on load; the angle is a slider. If your
rig's bind orientation puts the arms *up* instead, set the angle to 0 and pose
the arms in your DCC tool.

---

## Performance budget

The validator warns past these thresholds:

- **> 250,000 triangles** — decimate below ~150k for smooth 60fps on laptops.
- **> 200 bones** — exceeds the typical 65-bone skinning budget on mobile GPUs.
