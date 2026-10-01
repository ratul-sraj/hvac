/* drawstore.js — the uploaded drawing, kept in this browser only.
 *
 * The room table survives a refresh (it is small and lives in localStorage) but the PDF itself does
 * not, so after a reload the user was left with a table and no drawing — and could not draw the rooms
 * they had missed without finding the file again. A multi-megabyte PDF does not belong in
 * localStorage (about 5 MB total, and it is a string), so it goes in IndexedDB, which stores binary
 * data natively and is allowed to hold far more.
 *
 * Nothing here leaves the machine: IndexedDB is per-browser, per-origin, local storage. The file is
 * never uploaded.
 *
 * Every function resolves rather than throws — a browser without IndexedDB (some private modes,
 * file://) or a full quota must cost the user nothing more than the drawing not coming back.
 */

const DB_NAME = 'loadlens';
const DB_VERSION = 1;
const STORE = 'drawings';
const KEY = 'current';

function supported() {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch (err) {
    return false;
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB.open failed'));
    req.onblocked = () => reject(new Error('indexedDB.open blocked'));
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(STORE, mode);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error || new Error('transaction failed'));
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
    try {
      fn(t.objectStore(STORE));
    } catch (err) {
      reject(err);
    }
  });
}

/** True when this browser can keep a drawing for next time. */
export function isSupported() {
  return supported();
}

/**
 * Save the drawing for the next visit.
 * @param {{name?: string, bytes: ArrayBuffer|Uint8Array, page?: number}} rec
 * @returns {Promise<{ok: boolean, reason?: string, size?: number}>} never rejects
 */
export async function putDrawing(rec) {
  if (!supported()) return { ok: false, reason: 'unsupported' };
  const bytes = rec && rec.bytes;
  if (!bytes) return { ok: false, reason: 'empty' };
  // size first: copying a 200 MB buffer only to reject it would spike memory for nothing
  const rawSize = bytes.byteLength || 0;
  if (rawSize > MAX_BYTES) return { ok: false, reason: 'too-big', size: rawSize };
  // Copy unless the caller hands over a private buffer and says so: pdf.js DETACHES whatever it is
  // given, and a detached buffer stored here would come back as an empty drawing.
  const buf = rec.owned
    ? (bytes instanceof Uint8Array ? bytes.buffer : bytes)
    : (bytes instanceof Uint8Array ? bytes.slice().buffer : bytes.slice(0));
  const size = buf.byteLength;
  if (size > MAX_BYTES) return { ok: false, reason: 'too-big', size };
  let db;
  try {
    db = await openDb();
    await tx(db, 'readwrite', (store) => {
      store.put({ name: (rec && rec.name) || 'drawing.pdf', size, page: (rec && rec.page) || 1, savedAt: Date.now(), bytes: buf }, KEY);
    });
    return { ok: true, size };
  } catch (err) {
    const name = (err && err.name) || '';
    const reason = name === 'QuotaExceededError' ? 'quota' : 'error';
    return { ok: false, reason, size };
  } finally {
    if (db) { try { db.close(); } catch (err) { /* already closing */ } }
  }
}

/**
 * Read the stored drawing back.
 * @returns {Promise<{name: string, bytes: ArrayBuffer, page: number, savedAt: number, size: number}|null>}
 */
export async function getDrawing() {
  if (!supported()) return null;
  let db;
  try {
    db = await openDb();
    const rec = await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('read failed'));
    });
    if (!rec || !rec.bytes || !rec.bytes.byteLength) return null;
    return rec;
  } catch (err) {
    return null;
  } finally {
    if (db) { try { db.close(); } catch (err) { /* already closing */ } }
  }
}

/** Forget the stored drawing (used when the user clears everything). */
export async function clearDrawing() {
  if (!supported()) return false;
  let db;
  try {
    db = await openDb();
    await tx(db, 'readwrite', (store) => store.delete(KEY));
    return true;
  } catch (err) {
    return false;
  } finally {
    if (db) { try { db.close(); } catch (err) { /* already closing */ } }
  }
}

/** Roughly what fits comfortably; a CAD sheet is normally well under this. */
export const MAX_BYTES = 40 * 1024 * 1024;
