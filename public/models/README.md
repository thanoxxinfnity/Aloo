# 3D assets

Drop your models here. Both are **optional** — ALOO renders a procedural
holo-construct and starfield when they are absent, so the app is fully usable
before you have any assets.

| File | Role | Notes |
|---|---|---|
| `avatar.glb` | Foreground character | Needs a skeleton. Viseme blendshapes strongly recommended. |
| `space.glb` | Background environment | Rendered at 60× scale with `depthWrite` disabled, so it always reads as an infinitely distant backdrop. |

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

ALOO assumes metres and a Y-up, Z-forward model standing with its feet at
`y = 0`. The camera presets frame a figure roughly 1.7 m tall:

| Preset | Camera | Looks at |
|---|---|---|
| Close-Up (Facial Focus) | `[0, 1.58, 0.82]` | `[0, 1.55, 0]` |
| Upper Body (Standard) | `[0, 1.46, 1.95]` | `[0, 1.34, 0]` |
| Full View | `[0, 1.15, 3.70]` | `[0, 0.95, 0]` |

If your model imports at the wrong size or height, use the **Avatar Scale** and
**Offset X/Y/Z** sliders in the control drawer rather than re-exporting.

---

## Performance budget

The validator warns past these thresholds:

- **> 250,000 triangles** — decimate below ~150k for smooth 60fps on laptops.
- **> 200 bones** — exceeds the typical 65-bone skinning budget on mobile GPUs.
