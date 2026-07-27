// IndexedDB key-encoding microbench, shaped like DIPLOMATIC EntDB usage.
// Open via: npm run perf:idb  →  http://localhost:4177/

const DB_NAME = "diplomatic-idb-encode-bench";
const DB_VERSION = 2;
/** Typical EID: 8 random + 6 date bytes (see docs/docs/arch/entdb.md). */
const DEFAULT_ID_BYTES = 14;
const DEFAULT_N = 100_000;
const DEFAULT_POINT = 1000;
/** Distinct parents for typ+pid fan-out (EntDB child lists). */
const N_PARENTS = 500;
const TYPES = ["task", "note", "file", "tag", "evt"];
/** Small structured body (msgpack-ish payload stand-in). */
const BODY = { k: "v", n: 42, s: "x".repeat(32) };

// --- codecs -----------------------------------------------------------------

function btob64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function b64tob(b64) {
  if (typeof Uint8Array.fromBase64 === "function") {
    return Uint8Array.fromBase64(b64);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function btob64u(bytes) {
  if (typeof bytes.toBase64 === "function") {
    return bytes.toBase64({ omitPadding: true });
  }
  return btob64(bytes).replace(/=+$/, "");
}

function b64utob(b64u) {
  if (typeof Uint8Array.fromBase64 === "function") {
    try {
      return Uint8Array.fromBase64(b64u);
    } catch {
      // pad
    }
  }
  const pad = b64u.length % 4 === 0 ? "" : "=".repeat(4 - (b64u.length % 4));
  return b64tob(b64u + pad);
}

function btob128(bytes) {
  const codes = [];
  let bits = 0;
  let bitCount = 0;
  for (let i = 0; i < bytes.length; i++) {
    bits |= bytes[i] << bitCount;
    bitCount += 8;
    while (bitCount >= 7) {
      codes.push(bits & 0x7f);
      bits >>>= 7;
      bitCount -= 7;
    }
  }
  if (bitCount > 0) codes.push(bits & 0x7f);
  const CHUNK = 8192;
  let str = "";
  for (let j = 0; j < codes.length; j += CHUNK) {
    str += String.fromCharCode(...codes.slice(j, j + CHUNK));
  }
  return str;
}

function b128tob(str) {
  const bytes = [];
  let bits = 0;
  let bitCount = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c > 127) throw new Error("Invalid base128 character");
    bits |= c << bitCount;
    bitCount += 7;
    while (bitCount >= 8) {
      bytes.push(bits & 0xff);
      bits >>>= 8;
      bitCount -= 8;
    }
  }
  return new Uint8Array(bytes);
}

function btoh(bytes) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function htob(hex) {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * latin1: map each byte 0–255 to one JS string code unit via fromCharCode.
 * Same *character count* as byte length; not the same on-disk cost as binary
 * (JS strings are UTF-16; IDB may store them as UTF-16 or UTF-8).
 */
function btolatin1(bytes) {
  const CHUNK = 8192;
  let str = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    str += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return str;
}

function latin1tob(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

/** @typedef {{ name: string, encode: (b: Uint8Array) => unknown, decode: (k: unknown) => Uint8Array, keySizeLabel: (k: unknown) => string }} Variant */

/** @type {Variant[]} */
const VARIANTS = [
  {
    name: "binary",
    // Already Uint8Array — no copy, no conversion (true zero-encode baseline).
    encode: (b) => b,
    decode: (k) => {
      if (k instanceof Uint8Array) return k;
      if (k instanceof ArrayBuffer) return new Uint8Array(k);
      throw new Error("binary key is not ArrayBuffer/Uint8Array");
    },
    keySizeLabel: (k) => {
      const n = k instanceof ArrayBuffer
        ? k.byteLength
        : k instanceof Uint8Array
        ? k.byteLength
        : -1;
      return `${n} B`;
    },
  },
  {
    name: "base64",
    encode: btob64,
    decode: (k) => b64tob(/** @type {string} */ (k)),
    keySizeLabel: (k) => `${String(k).length} ch`,
  },
  {
    name: "base64u",
    encode: btob64u,
    decode: (k) => b64utob(/** @type {string} */ (k)),
    keySizeLabel: (k) => `${String(k).length} ch`,
  },
  {
    name: "base128",
    encode: btob128,
    decode: (k) => b128tob(/** @type {string} */ (k)),
    keySizeLabel: (k) => `${String(k).length} ch`,
  },
  {
    name: "hex",
    encode: btoh,
    decode: (k) => htob(/** @type {string} */ (k)),
    keySizeLabel: (k) => `${String(k).length} ch`,
  },
  {
    name: "latin1",
    encode: btolatin1,
    decode: (k) => latin1tob(/** @type {string} */ (k)),
    keySizeLabel: (k) => `${String(k).length} ch`,
  },
];

// --- IDB helpers ------------------------------------------------------------

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IDB request failed"));
  });
}

function idbTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IDB tx failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IDB tx aborted"));
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [...db.objectStoreNames]) {
        db.deleteObjectStore(name);
      }
      for (const v of VARIANTS) {
        // EntDB-shaped: inline keyPath eid + compound indexes.
        const store = db.createObjectStore(v.name, { keyPath: "eid" });
        store.createIndex("by_typ_pid", ["typ", "pid"], { unique: false });
        store.createIndex("by_typ_crd", ["typ", "crd"], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

// --- bench utils ------------------------------------------------------------

function msNow() {
  return performance.now();
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 0.001) return `${(ms * 1e6).toFixed(0)} ns`;
  if (ms < 1) return `${(ms * 1000).toFixed(1)} µs`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtOps(ops, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const perSec = (ops / ms) * 1000;
  if (perSec >= 1e6) return `${(perSec / 1e6).toFixed(2)} M/s`;
  if (perSec >= 1e3) return `${(perSec / 1e3).toFixed(1)} k/s`;
  return `${perSec.toFixed(0)} /s`;
}

function fmtNs(ms, n) {
  if (!Number.isFinite(ms) || n <= 0) return "—";
  const ns = (ms * 1e6) / n;
  if (ns >= 1000) return `${(ns / 1000).toFixed(1)} µs`;
  return `${ns.toFixed(0)} ns`;
}

function randomBytes(n, bytes) {
  const out = new Array(n);
  const maxBatch = Math.max(1, Math.floor(65536 / bytes));
  for (let i = 0; i < n; i += maxBatch) {
    const count = Math.min(maxBatch, n - i);
    const buf = new Uint8Array(count * bytes);
    crypto.getRandomValues(buf);
    for (let j = 0; j < count; j++) {
      out[i + j] = buf.subarray(j * bytes, (j + 1) * bytes).slice();
    }
  }
  return out;
}

function pickIndices(n, k, seed = 1) {
  const out = new Set();
  let x = seed >>> 0;
  while (out.size < k && out.size < n) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out.add(x % n);
  }
  return [...out];
}

/**
 * Build EntDB-like raw rows: eid, optional pid, typ, dates, body.
 * ~80% have a pid pointing at one of N_PARENTS parents (child-list workload).
 */
function buildRawRows(n, idBytes) {
  const eids = randomBytes(n, idBytes);
  const parents = randomBytes(Math.min(N_PARENTS, n), idBytes);
  const t0 = Date.now() - n * 1000;
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const hasPid = i >= parents.length && i % 5 !== 0; // ~80% with parent
    rows[i] = {
      eid: eids[i],
      pid: hasPid ? parents[i % parents.length] : null,
      typ: TYPES[i % TYPES.length],
      crd: new Date(t0 + i * 1000),
      upd: new Date(t0 + i * 1000 + 500),
      bod: BODY,
      ctr: i % 7 === 0 ? 0 : (i % 50),
    };
  }
  return { rows, parents, eids };
}

function log(el, msg, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function clearLog(el) {
  el.replaceChildren();
}

// --- core bench -------------------------------------------------------------

/**
 * @param {Variant} variant
 * @param {ReturnType<typeof buildRawRows>} raw
 * @param {number[]} pointIdx
 * @param {number[]} parentProbeIdx indices into raw.parents for list-by-pid
 * @param {(s: string) => void} progress
 */
async function benchVariant(variant, raw, pointIdx, parentProbeIdx, progress) {
  const { rows, parents } = raw;
  const n = rows.length;
  /** @type {any} */
  const result = {
    name: variant.name,
    keySize: null,
    encodeMs: null,
    decodeMs: null,
    insertMs: null,
    pointMs: null,
    pointHits: 0,
    listPidMs: null,
    listPidRows: 0,
    typeScanMs: null,
    typeScanRows: 0,
    getAllMs: null,
    getAllCount: 0,
    error: null,
  };

  try {
    // Write-path tax: encode eid + pid for every row (matches entityToStored).
    progress(`${variant.name}: encode eid+pid ×${n}…`);
    const tEnc0 = msNow();
    const stored = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const eid = variant.encode(r.eid);
      const pid = r.pid ? variant.encode(r.pid) : undefined;
      const rec = {
        eid,
        typ: r.typ,
        crd: r.crd,
        upd: r.upd,
        bod: r.bod,
      };
      if (pid !== undefined) rec.pid = pid;
      if (r.ctr !== 0) rec.ctr = r.ctr;
      stored[i] = rec;
    }
    result.encodeMs = msNow() - tEnc0;
    result.keySize = variant.keySizeLabel(stored[0].eid);

    // Read-path tax: decode eid (+ pid when present) after load.
    progress(`${variant.name}: decode eid+pid ×${n}…`);
    const tDec0 = msNow();
    for (let i = 0; i < n; i++) {
      const s = stored[i];
      const eid = variant.decode(s.eid);
      if (eid.byteLength !== rows[0].eid.byteLength) {
        throw new Error(`decode eid length mismatch`);
      }
      if (s.pid !== undefined) variant.decode(s.pid);
    }
    result.decodeMs = msNow() - tDec0;

    const db = await openDb();
    {
      const tx = db.transaction(variant.name, "readwrite");
      tx.objectStore(variant.name).clear();
      await idbTxDone(tx);
    }

    // Apply-like bulk put (one tx).
    progress(`${variant.name}: insert/apply ${n} ents…`);
    const tIns0 = msNow();
    {
      const tx = db.transaction(variant.name, "readwrite");
      const store = tx.objectStore(variant.name);
      for (let i = 0; i < n; i++) store.put(stored[i]);
      await idbTxDone(tx);
    }
    result.insertMs = msNow() - tIns0;

    // Point get by eid + materialize decode (IEntDB.get).
    progress(`${variant.name}: point get ×${pointIdx.length}…`);
    const tPt0 = msNow();
    {
      const tx = db.transaction(variant.name, "readonly");
      const store = tx.objectStore(variant.name);
      let hits = 0;
      await Promise.all(
        pointIdx.map((i) =>
          idbReq(store.get(stored[i].eid)).then((row) => {
            if (!row) return;
            hits++;
            variant.decode(row.eid);
            if (row.pid !== undefined) variant.decode(row.pid);
          })
        ),
      );
      await idbTxDone(tx);
      result.pointHits = hits;
    }
    result.pointMs = msNow() - tPt0;

    // EntDB hot path: list by [typ, pid] (children of a parent).
    progress(`${variant.name}: list-by-pid ×${parentProbeIdx.length}…`);
    const tList0 = msNow();
    {
      const tx = db.transaction(variant.name, "readonly");
      const idx = tx.objectStore(variant.name).index("by_typ_pid");
      let rowCount = 0;
      await Promise.all(
        parentProbeIdx.map((pi) => {
          const parentKey = variant.encode(parents[pi]);
          // One type per probe (rotate) — still exercises compound index.
          const typ = TYPES[pi % TYPES.length];
          return idbReq(idx.getAll([typ, parentKey])).then((rowsOut) => {
            rowCount += rowsOut.length;
            for (const row of rowsOut) {
              variant.decode(row.eid);
              if (row.pid !== undefined) variant.decode(row.pid);
            }
          });
        }),
      );
      await idbTxDone(tx);
      result.listPidRows = rowCount;
    }
    result.listPidMs = msNow() - tList0;

    // Type scan via [typ, crd] index (list entities of a type).
    progress(`${variant.name}: type scan…`);
    const tType0 = msNow();
    {
      const typ = TYPES[0];
      const tx = db.transaction(variant.name, "readonly");
      const idx = tx.objectStore(variant.name).index("by_typ_crd");
      // Same upper-bound trick as EntIDB.getAllOfType.
      const range = IDBKeyRange.bound([typ], [typ, []]);
      const rowsOut = await idbReq(idx.getAll(range));
      // Decode a sample of returned eids (materialize cost).
      const sample = Math.min(rowsOut.length, pointIdx.length);
      for (let i = 0; i < sample; i++) {
        variant.decode(rowsOut[i].eid);
      }
      result.typeScanRows = rowsOut.length;
      await idbTxDone(tx);
    }
    result.typeScanMs = msNow() - tType0;

    // Full table getAll (less common; kept for bulk-export / wipe comparisons).
    progress(`${variant.name}: getAll…`);
    const tAll0 = msNow();
    {
      const tx = db.transaction(variant.name, "readonly");
      const all = await idbReq(tx.objectStore(variant.name).getAll());
      result.getAllCount = all.length;
      await idbTxDone(tx);
    }
    result.getAllMs = msNow() - tAll0;

    db.close();
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }

  return result;
}

function bestCol(results, key) {
  let best = null;
  for (const r of results) {
    if (r.error || r[key] == null || !Number.isFinite(r[key])) continue;
    if (best == null || r[key] < best) best = r[key];
  }
  return best;
}

function renderTable(results, n, nPoint, idBytes) {
  const cols = [
    {
      key: "keySize",
      label: "key size",
      numeric: false,
      fmt: (r) => r.keySize ?? "—",
    },
    {
      key: "encodeMs",
      label: "encode eid+pid",
      numeric: true,
      fmt: (r) =>
        r.encodeMs == null
          ? "—"
          : `${fmtMs(r.encodeMs)} (${fmtNs(r.encodeMs, n)}/row)`,
    },
    {
      key: "decodeMs",
      label: "decode eid+pid",
      numeric: true,
      fmt: (r) =>
        r.decodeMs == null
          ? "—"
          : `${fmtMs(r.decodeMs)} (${fmtNs(r.decodeMs, n)}/row)`,
    },
    {
      key: "insertMs",
      label: "insert/apply",
      numeric: true,
      fmt: (r) =>
        r.insertMs == null
          ? "—"
          : `${fmtMs(r.insertMs)} (${fmtOps(n, r.insertMs)})`,
    },
    {
      key: "pointMs",
      label: `point×${nPoint}`,
      numeric: true,
      fmt: (r) =>
        r.pointMs == null
          ? "—"
          : `${fmtMs(r.pointMs)} (${
            fmtOps(nPoint, r.pointMs)
          }; ${r.pointHits}/${nPoint})`,
    },
    {
      key: "listPidMs",
      label: "list-by-pid",
      numeric: true,
      fmt: (r) =>
        r.listPidMs == null
          ? "—"
          : `${fmtMs(r.listPidMs)} (${r.listPidRows} rows)`,
    },
    {
      key: "typeScanMs",
      label: "type scan",
      numeric: true,
      fmt: (r) =>
        r.typeScanMs == null
          ? "—"
          : `${fmtMs(r.typeScanMs)} (${r.typeScanRows} rows)`,
    },
    {
      key: "getAllMs",
      label: "getAll",
      numeric: true,
      fmt: (r) =>
        r.getAllMs == null
          ? "—"
          : `${fmtMs(r.getAllMs)} (${r.getAllCount} rows)`,
    },
  ];

  const best = {};
  for (const c of cols) {
    if (c.numeric) best[c.key] = bestCol(results, c.key);
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.innerHTML = `<th>encoding</th>` +
    cols.map((c) => `<th>${c.label}</th>`).join("");
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const r of results) {
    const tr = document.createElement("tr");
    const nameTd = document.createElement("td");
    nameTd.textContent = r.name;
    tr.appendChild(nameTd);

    if (r.error) {
      const td = document.createElement("td");
      td.colSpan = cols.length;
      td.className = "fail";
      td.textContent = `FAILED: ${r.error}`;
      tr.appendChild(td);
    } else {
      for (const c of cols) {
        const td = document.createElement("td");
        td.textContent = c.fmt(r);
        if (
          c.numeric &&
          r[c.key] != null &&
          best[c.key] != null &&
          r[c.key] === best[c.key]
        ) {
          td.className = "best";
        }
        tr.appendChild(td);
      }
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const meta = document.createElement("p");
  meta.className = "notes";
  meta.textContent = `N=${n.toLocaleString()} ents · ${idBytes}-byte EIDs · ` +
    `~${N_PARENTS} parents · types=[${TYPES.join(",")}] · ` +
    `point sample=${nPoint.toLocaleString()} · ` +
    `UA: ${navigator.userAgent}`;

  const wrap = document.createElement("div");
  wrap.appendChild(table);
  wrap.appendChild(meta);
  return wrap;
}

// --- UI ---------------------------------------------------------------------

const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const runBtn = document.getElementById("run");
const wipeBtn = document.getElementById("wipe");
const nRowsEl = document.getElementById("nRows");
const nPointEl = document.getElementById("nPoint");
const idBytesEl = document.getElementById("idBytes");

function setBusy(busy) {
  runBtn.disabled = busy;
  wipeBtn.disabled = busy;
  nRowsEl.disabled = busy;
  nPointEl.disabled = busy;
  if (idBytesEl) idBytesEl.disabled = busy;
}

runBtn.addEventListener("click", async () => {
  const n = Math.max(1000, Number(nRowsEl.value) || DEFAULT_N);
  const nPoint = Math.min(
    n,
    Math.max(10, Number(nPointEl.value) || DEFAULT_POINT),
  );
  const idBytes = Math.max(
    4,
    Math.min(64, Number(idBytesEl?.value) || DEFAULT_ID_BYTES),
  );
  nRowsEl.value = String(n);
  nPointEl.value = String(nPoint);
  if (idBytesEl) idBytesEl.value = String(idBytes);

  setBusy(true);
  clearLog(statusEl);
  resultsEl.replaceChildren();
  log(
    statusEl,
    `Starting: N=${n}, eid=${idBytes}B, point=${nPoint}, parents=${N_PARENTS}`,
  );

  try {
    if (!indexedDB) throw new Error("IndexedDB unavailable");

    log(statusEl, "Resetting database…");
    await deleteDb();

    log(statusEl, `Building ${n} EntDB-like rows…`);
    const tGen0 = msNow();
    const raw = buildRawRows(n, idBytes);
    log(statusEl, `Built in ${fmtMs(msNow() - tGen0)}`, "ok");

    const pointIdx = pickIndices(n, nPoint, 42);
    const parentProbeIdx = pickIndices(
      raw.parents.length,
      Math.min(50, raw.parents.length),
      7,
    );
    const results = [];

    for (const v of VARIANTS) {
      log(statusEl, `—— ${v.name} ——`);
      const r = await benchVariant(
        v,
        raw,
        pointIdx,
        parentProbeIdx,
        (s) => log(statusEl, s),
      );
      results.push(r);
      if (r.error) log(statusEl, `${v.name} failed: ${r.error}`, "err");
      else {
        log(
          statusEl,
          `${v.name}: insert ${fmtMs(r.insertMs)}, point ${
            fmtMs(r.pointMs)
          }, ` +
            `list-pid ${fmtMs(r.listPidMs)}, type ${fmtMs(r.typeScanMs)}`,
          "ok",
        );
      }
      await new Promise((res) => setTimeout(res, 0));
    }

    resultsEl.replaceChildren(renderTable(results, n, nPoint, idBytes));
    log(statusEl, "Done.", "ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(statusEl, `Fatal: ${msg}`, "err");
  } finally {
    setBusy(false);
  }
});

wipeBtn.addEventListener("click", async () => {
  setBusy(true);
  clearLog(statusEl);
  try {
    await deleteDb();
    log(statusEl, `Deleted database ${DB_NAME}`, "ok");
    resultsEl.replaceChildren();
    const p = document.createElement("p");
    p.className = "notes";
    p.textContent = "No results yet.";
    resultsEl.appendChild(p);
  } catch (e) {
    log(statusEl, e instanceof Error ? e.message : String(e), "err");
  } finally {
    setBusy(false);
  }
});
