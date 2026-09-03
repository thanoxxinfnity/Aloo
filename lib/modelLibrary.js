/**
 * ALOO — 3D model library.
 * ===========================================================================
 * Lets the operator keep several avatars and environments and switch between
 * them at will, from any device.
 *
 * THREE KINDS OF ENTRY
 *  1. BUILT-IN   — files shipped in /public/models. Always present.
 *  2. REMOTE     — an https URL the user pasted. Stored as a URL only.
 *  3. UPLOADED   — a .glb the user picked from their device. The FILE ITSELF is
 *                  stored in IndexedDB and re-issued as an object URL on every
 *                  load.
 *
 * WHY INDEXEDDB, NOT localStorage: a rigged GLB is 5-50 MB of binary.
 * localStorage caps out around 5 MB and only holds strings, so base64-ing a
 * model there would blow the quota on the first upload. IndexedDB stores Blobs
 * natively with no practical size limit.
 *
 * WHY OBJECT URLS ARE RE-ISSUED: `URL.createObjectURL` handles do not survive a
 * page reload, so an uploaded model cannot be referenced by a stored blob: URL.
 * The stable identity is the entry id (`lib:<id>`); the real URL is minted
 * fresh each session by `resolveModelUrl`.
 *
 * This is what makes model switching work inside the Android APK too — there is
 * no server there to upload files to, but IndexedDB works exactly the same.
 */

const DB_NAME = 'aloo-models';
const DB_VERSION = 1;
const STORE = 'models';

/** Entries that ship with the app. */
export const BUILT_IN_MODELS = [
  {
    id: 'builtin:avatar',
    kind: 'avatar',
    label: 'Mika Melatika (bundled)',
    url: '/models/avatar.glb',
    builtin: true,
    note: '59 bones · jaw + eye bones · no visemes',
  },
  {
    id: 'builtin:holo',
    kind: 'avatar',
    label: 'Procedural Holo-Construct',
    url: '',
    builtin: true,
    note: 'No file — the built-in generated avatar',
  },
  {
    id: 'builtin:space',
    kind: 'space',
    label: 'Galaxy Disc (bundled)',
    url: '/models/space.glb',
    builtin: true,
    note: '~8,000 star quads',
  },
  {
    id: 'builtin:stars',
    kind: 'space',
    label: 'Procedural Starfield',
    url: '',
    builtin: true,
    note: 'No file — generated stars, dust and nebulae',
  },
];

/**
 * Models the operator asked to have available. Sketchfab does NOT permit
 * programmatic download of these — every one is marked `isDownloadable: false`
 * by its author, which means even a logged-in account gets no download button;
 * they are store items sold by the artist. So ALOO cannot ship them, and
 * scraping them would be both technically blocked and a licence violation.
 *
 * They are listed here as a shortcut instead: open the page, obtain the model
 * from the artist, then add the .glb through Settings → Model Library → Add.
 */
export const SKETCHFAB_CATALOG = [
  {
    label: 'Anime Character — Miku',
    author: 'LessaB3D',
    url: 'https://sketchfab.com/3d-models/anime-character-miku-3d-model-ba274ad6107740039aa5ec41bbbe802b',
    stats: '41k tris · not rigged',
    downloadable: false,
  },
  {
    label: 'Anime Girl Bikini — Rigged | Shape Keys',
    author: 'LessaB3D',
    url: 'https://sketchfab.com/3d-models/anime-girl-bikini-rigged-shape-keys-50-tex-6b4a4e1e437a4cf1840586b769c9d071',
    stats: '150k tris · rigged · SHAPE KEYS (real visemes possible)',
    downloadable: false,
  },
  {
    label: 'Vermell — Anime Girl Character',
    author: 'ridho.mnf',
    url: 'https://sketchfab.com/3d-models/vermell-anime-girl-character-bf9f7f01be7b44f8ae81c6d7d24fff4c',
    stats: '79k tris · rigged · 1 animation',
    downloadable: false,
  },
  {
    label: 'Mio — Anime Girl Character',
    author: 'ridho.mnf',
    url: 'https://sketchfab.com/3d-models/mio-anime-girl-character-1e41cf5f9ef744739bc8095176e6d2ea',
    stats: '74k tris · rigged · 1 animation',
    downloadable: false,
  },
];

/* -------------------------------------------------------------------------- */
/* IndexedDB                                                                   */
/* -------------------------------------------------------------------------- */

let dbPromise = null;

function openDb() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB unavailable in this browser'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open the model database'));
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = () => resolve(result?.result ?? result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Transaction aborted'));
      })
  );
}

/** Every stored entry, newest first. Blobs are included. */
export async function listStoredModels() {
  const rows = await tx('readonly', (store) => store.getAll());
  return (rows || []).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

/**
 * Store a .glb the user picked. Returns the new entry.
 * @param {File} file
 * @param {'avatar'|'space'} kind
 * @param {string} [label]
 */
export async function addUploadedModel(file, kind, label) {
  if (!file) throw new Error('No file supplied');
  const name = file.name || 'model.glb';
  // The file input accepts everything (Android's picker matches nothing when
  // given a .glb accept list), so the real check happens here.
  if (!/\.(glb|gltf)$/i.test(name)) {
    throw new Error(`"${name}" is not a .glb or .gltf model — pick the model file itself.`);
  }
  if (file.size === 0) {
    throw new Error('That file is empty. Try picking it from device storage rather than a cloud shortcut.');
  }
  // 120 MB is far beyond any sane real-time avatar; refusing early beats
  // filling the user's storage quota and failing on load.
  if (file.size > 120 * 1024 * 1024) {
    throw new Error(`${(file.size / 1048576).toFixed(0)} MB is too large — keep models under 120 MB`);
  }

  const entry = {
    id: `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    kind,
    label: label?.trim() || name.replace(/\.(glb|gltf)$/i, ''),
    blob: file,
    size: file.size,
    addedAt: Date.now(),
    source: 'upload',
  };
  await tx('readwrite', (store) => store.put(entry));
  return entry;
}

/** Store a remote https model by URL (no file copied). */
export async function addRemoteModel(url, kind, label) {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) throw new Error('Enter a full http(s) URL');

  const entry = {
    id: `rm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    kind,
    label: label?.trim() || clean.split('/').pop() || 'Remote model',
    url: clean,
    addedAt: Date.now(),
    source: 'remote',
  };
  await tx('readwrite', (store) => store.put(entry));
  return entry;
}

export async function removeModel(id) {
  await tx('readwrite', (store) => store.delete(id));
}

/* -------------------------------------------------------------------------- */
/* URL resolution                                                              */
/* -------------------------------------------------------------------------- */

// Object URLs minted this session, keyed by entry id, so repeated resolution
// does not leak a new blob URL every render.
const objectUrls = new Map();

/**
 * Turn a stored entry into a URL the loader can use. Uploaded entries get a
 * fresh object URL (cached per session); everything else is already a URL.
 */
export function urlForEntry(entry) {
  if (!entry) return '';
  if (entry.url) return entry.url;
  if (!entry.blob) return '';
  if (!objectUrls.has(entry.id)) {
    objectUrls.set(entry.id, URL.createObjectURL(entry.blob));
  }
  return objectUrls.get(entry.id);
}

/** Release an entry's object URL (call after deleting it). */
export function releaseEntry(id) {
  const url = objectUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrls.delete(id);
  }
}

/** Built-in + stored entries of one kind, ready for a dropdown. */
export function mergeCatalog(stored, kind) {
  return [
    ...BUILT_IN_MODELS.filter((m) => m.kind === kind),
    ...stored.filter((m) => m.kind === kind),
  ];
}
