/**
 * Cold-open support for long session logs.
 *
 * A session log is a sequence of independent zstd frames. The durable checkpoint
 * written by dsh-surface-checkpoint records the SurfaceManager state at a cut,
 * so the prefix never has to be decoded or materialized: this module exposes it
 * as a lazy array-like window (length / index / slice / at / iterator) backed by
 * frame decompression, and hydrates a Session from {checkpoint, window}.
 *
 * Every entry point is fail-safe: any mismatch or error returns undefined and
 * the caller performs the original full decode/restore. A read that cannot be
 * served must throw ColdWindowMiss, never return undefined.
 *
 * Enabled by DSH_COLD_OPEN=1 or the marker file $DSH_HOME/cold-open.on.
 */
import fs from "node:fs";
import { appendFileSync } from "node:fs";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const FRAME_CACHE = 24;
const CHUNK = 4 << 20;
const MATERIALIZE_LIMIT = 20_000;

export class ColdWindowMiss extends Error {}

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Append one diagnostic line to $DSH_HOME/cold-open.log; never throws. */
globalThis.__coldTrace = (message) => coldTrace(message);
export function coldTrace(message) {
  try {
    appendFileSync(join(dshHome(), "cold-open.log"), `${new Date().toISOString()} ${message}
`);
  } catch {
    /* diagnostics must never take a session down */
  }
}

export function dshHome() {
  const env = process.env.DSH_HOME;
  return typeof env === "string" && env.trim() !== "" ? env.trim() : join(homedir(), ".dsh");
}

export function coldOpenEnabled() {
  if (process.env.DSH_COLD_OPEN === "0") return false;
  if (process.env.DSH_COLD_OPEN === "1") return true;
  try {
    return fs.existsSync(join(dshHome(), "cold-open.on"));
  } catch {
    return false;
  }
}

export function checkpointPath(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_");
  const override = typeof process.env.DSH_COLD_CHECKPOINT_DIR === "string" ? process.env.DSH_COLD_CHECKPOINT_DIR.trim() : "";
  return join(override !== "" ? override : join(dshHome(), "surface-checkpoints"), `${safe}.json`);
}

function frameStartsIn(buf) {
  const starts = [];
  let at = buf.indexOf(MAGIC);
  while (at !== -1) {
    starts.push(at);
    at = buf.indexOf(MAGIC, at + 1);
  }
  return starts;
}

/**
 * Build a lazy window over `buffer` (whole file) or `path`.
 * @param {{ buffer?: Buffer, path?: string, cut: number, materializeLimit?: number }} options
 */
export function createColdWindow(options) {
  const { cut } = options;
  const limit = options.materializeLimit ?? MATERIALIZE_LIMIT;
  const fd = options.path === undefined ? undefined : fs.openSync(options.path, "r");
  const size = options.buffer !== undefined ? options.buffer.length : fs.fstatSync(fd).size;
  const frames = new Map();
  let idx = null;
  let extendBroken = false;
  const indexPath = options.indexPath;
  const stats = { get: 0, decompress: 0, bytes: 0, hits: 0, misses: 0, materialized: 0, indexBuilds: 0 };

  function readAt(position, length) {
    if (options.buffer !== undefined) {
      stats.bytes += length;
      return options.buffer.subarray(position, position + length);
    }
    const buf = Buffer.allocUnsafe(length);
    const n = fs.readSync(fd, buf, 0, length, position);
    stats.bytes += n;
    return n === length ? buf : buf.subarray(0, n);
  }

  function frameAt(start, end) {
    const cached = frames.get(start);
    if (cached !== undefined) { stats.hits++; return cached; }
    let parsed;
    try {
      parsed = zlib.zstdDecompressSync(readAt(start, end - start))
        .toString("utf8").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
      stats.decompress++;
    } catch {
      return undefined;
    }
    const eventOffset = parsed.findIndex((item) => item !== null && typeof item === "object" && Object.hasOwn(item, "seq"));
    const frame = {
      start, end, lines: parsed, eventOffset,
      firstSeq: eventOffset === -1 ? undefined : parsed[eventOffset].seq,
      lastSeq: eventOffset === -1 ? undefined : parsed.at(-1).seq,
    };
    frames.set(start, frame);
    if (frames.size > FRAME_CACHE) frames.delete(frames.keys().next().value);
    return frame;
  }

  /** Walk frames backward; give up after maxFrames decompressions. */
  function walkBack(target, maxFrames = 2000) {
    let cursor = size;
    let seen = 0;
    while (cursor > 0) {
      const chunkStart = Math.max(0, cursor - CHUNK);
      const starts = frameStartsIn(readAt(chunkStart, cursor - chunkStart)).map((at) => chunkStart + at);
      for (let k = starts.length - 1; k >= 0; k--) {
        const frame = frameAt(starts[k], k + 1 < starts.length ? starts[k + 1] : cursor);
        if (frame === undefined) continue;
        if (++seen > maxFrames) return undefined;
        if (frame.firstSeq !== undefined && frame.firstSeq <= target) return frame;
      }
      if (starts.length === 0) { cursor = chunkStart + 16; continue; }
      cursor = starts[0];
    }
    return undefined;
  }

  /** Persist `idx` with the end offset of its last indexed frame (never the raw file end:
   *  a torn tail must not poison the next load, which re-decodes that last frame). */
  function saveIndex(builtSize) {
    if (indexPath === undefined || size > 0xFFFFFFFF || idx === null || idx.starts.length === 0) return;
    const { starts, firsts, counts } = idx;
    try {
      const out = Buffer.alloc(16 + starts.length * 12);
      out.write("DSHIDX", 0, "ascii");
      out[6] = 1;
      out.writeUInt32LE(starts.length, 8);
      out.writeUInt32LE(builtSize, 12);
      for (let i = 0; i < starts.length; i++) {
        out.writeUInt32LE(starts[i], 16 + i * 12);
        out.writeUInt32LE(firsts[i], 20 + i * 12);
        out.writeUInt32LE(counts[i], 24 + i * 12);
      }
      const tmp = indexPath + ".tmp";
      fs.writeFileSync(tmp, out);
      fs.renameSync(tmp, indexPath);
      coldTrace(`cold-open index saved: ${starts.length} frames, ${out.length} bytes, end=${builtSize}`);
    } catch {
      /* best effort: an unwritable sidecar only costs a rebuild next time */
    }
  }

  /** Build the dense frame index once; later random reads are O(log n) + one frame. */
  function buildIndex() {
    if (idx !== null) return;
    const starts = [];
    const firsts = [];
    const counts = [];
    let lastEnd = 0;
    let cursor = 0;
    while (cursor < size) {
      const len = Math.min(CHUNK, size - cursor);
      const magics = frameStartsIn(readAt(cursor, len)).map((at) => cursor + at);
      if (magics.length === 0 || magics[0] !== cursor) { cursor += 1; continue; }
      let next = cursor;
      for (let k = 0; k < magics.length; k++) {
        const end = k + 1 < magics.length ? magics[k + 1] : (cursor + len === size ? size : undefined);
        if (end === undefined) { next = magics[k]; break; }
        const frame = frameAt(magics[k], end);
        if (frame !== undefined && frame.firstSeq !== undefined) {
          starts.push(magics[k]);
          firsts.push(frame.firstSeq);
          counts.push(frame.lastSeq - frame.firstSeq + 1);
          lastEnd = end;
        }
        next = end;
      }
      if (next <= cursor) break;
      cursor = next;
    }
    idx = { starts, firsts, counts, end: lastEnd };
    stats.indexBuilds++;
    saveIndex(lastEnd);
    coldTrace(`cold-open index built: ${starts.length} frames, stack=${String(new Error().stack).split(String.fromCharCode(10))[2] ?? ""}`);
  }

  /**
   * Extend an index loaded from a sidecar over frames appended to the log since
   * it was written. Without this, every read past the old coverage falls back to
   * `walkBack`, which decodes up to 2000 frames per read: a projection restore of
   * a few thousand events then costs hundreds of millions of decompressions
   * (observed as a 100% CPU "loading history" stall after a long-lived log grew).
   * Appends and persists the new frames once; later reads are O(log n) again.
   */
  function extendIndex(target) {
    if (idx === null || idx.starts.length === 0 || extendBroken) return false;
    const before = idx.firsts.length;
    const firstStart = idx.starts[idx.starts.length - 1];
    let cursor = firstStart;
    let lastEnd = idx.end ?? cursor;
    let added = 0;
    let reached = false;
    let guard = 0;
    while (cursor < size && guard++ < 200000) {
      const len = Math.min(CHUNK, size - cursor);
      const magics = frameStartsIn(readAt(cursor, len)).map((at) => cursor + at);
      if (magics.length === 0 || magics[0] !== cursor) { extendBroken = true; break; }
      let next = cursor;
      for (let k = 0; k < magics.length; k++) {
        const end = k + 1 < magics.length ? magics[k + 1] : (cursor + len === size ? size : undefined);
        if (end === undefined) { next = magics[k]; break; }
        const frame = frameAt(magics[k], end);
        next = end;
        if (frame === undefined || frame.firstSeq === undefined) continue;
        lastEnd = end;
        if (reached === false && frame.lastSeq >= target) reached = true;
        if (magics[k] === firstStart) continue; // already indexed; re-decoded with its true end
        idx.starts.push(magics[k]);
        idx.firsts.push(frame.firstSeq);
        idx.counts.push(frame.lastSeq - frame.firstSeq + 1);
        added++;
      }
      if (next <= cursor) break;
      cursor = next;
      // Decode the whole scanned chunk before stopping: the sidecar then jumps
      // CHUNK bytes ahead per extension, so a slow sequential reader pays one
      // extension per chunk instead of one magic scan + 2.7 MB save per event.
      if (reached) break;
    }
    if (added > 0) {
      idx.end = lastEnd;
      saveIndex(lastEnd);
      coldTrace(`cold-open index extended: +${added} frames, coverage 0..${idx.firsts[idx.firsts.length - 1] + idx.counts[idx.counts.length - 1] - 1}`);
    }
    return idx.firsts.length > before && findInIndex(target) !== undefined;
  }

  function findInIndex(seq) {
    if (idx === null) return undefined;
    const { starts, firsts, counts } = idx;
    let lo = 0;
    let hi = firsts.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (firsts[mid] <= seq) { hit = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (hit < 0 || seq >= firsts[hit] + counts[hit]) return undefined;
    return frameAt(starts[hit], hit + 1 < starts.length ? starts[hit + 1] : (idx.end ?? size));
  }

  /** Highest seq the loaded index covers, or -1. */
  function indexEndSeq() {
    if (idx === null || idx.firsts.length === 0) return -1;
    return idx.firsts[idx.firsts.length - 1] + idx.counts[idx.counts.length - 1] - 1;
  }

  function findFrame(seq) {
    for (const frame of frames.values()) {
      if (frame.firstSeq !== undefined && seq >= frame.firstSeq && seq <= frame.lastSeq) return frame;
    }
    const indexed = findInIndex(seq);
    if (indexed !== undefined) return indexed;
    if (seq === 0) {
      const starts = frameStartsIn(readAt(0, Math.min(CHUNK, size)));
      for (let k = 0; k < starts.length; k++) {
        const frame = frameAt(starts[k], starts[k + 1] ?? size);
        if (frame !== undefined && frame.firstSeq !== undefined) return frame;
      }
      return undefined;
    }
    // A sidecar written before the log grew must be extended BEFORE walk-back:
    // walk-back decodes up to 2000 frames per read and still succeeds, so it
    // would never let the index catch up (the 100% CPU history-load stall).
    if (idx !== null && seq > indexEndSeq() && !extendBroken) {
      if (extendIndex(seq)) return findInIndex(seq);
    }
    const walked = walkBack(seq);
    if (walked !== undefined) return walked;
    buildIndex();
    return findInIndex(seq);
  }

  function eventOf(frame, seq) {
    if (frame === undefined || frame.firstSeq === undefined) return undefined;
    const line = frame.lines[frame.eventOffset + (seq - frame.firstSeq)];
    return line !== undefined && typeof line === "object" && Object.hasOwn(line, "seq") ? line : undefined;
  }

  function get(seq) {
    stats.get++;
    const frame = findFrame(seq);
    if (frame === undefined) { stats.misses++; throw new ColdWindowMiss(`seq ${seq} outside the window`); }
    return eventOf(frame, seq);
  }

  function* stream(from, to) {
    if (from >= to) return;
    const first = findFrame(from);
    if (first === undefined) throw new ColdWindowMiss(`seq ${from} outside the window`);
    if (first.firstSeq > from) throw new ColdWindowMiss(`gap at seq ${from}`);
    let seq = from;
    let yielded = 0;
    let cursor = first.start;
    while (seq < to && cursor < size) {
      const len = Math.min(CHUNK, size - cursor);
      const starts = frameStartsIn(readAt(cursor, len)).map((at) => cursor + at);
      if (starts.length === 0 || starts[0] !== cursor) throw new ColdWindowMiss(`frame boundary lost at ${cursor}`);
      let consumedTo = cursor;
      for (let k = 0; k < starts.length; k++) {
        const start = starts[k];
        const atEof = cursor + len === size;
        const end = k + 1 < starts.length ? starts[k + 1] : (atEof ? size : undefined);
        if (end === undefined) break;
        const frame = frameAt(start, end);
        consumedTo = end;
        if (frame === undefined || frame.firstSeq === undefined) continue;
        if (frame.firstSeq > seq) throw new ColdWindowMiss(`gap at seq ${seq}`);
        const last = Math.min(frame.lastSeq, to - 1);
        for (; seq <= last; seq++) {
          if (++yielded === 100000) coldTrace(`stream from=${from} exceeded 100000 events
${new Error().stack}`);
          yield eventOf(frame, seq);
        }
        if (seq >= to) return;
      }
      if (consumedTo <= cursor) throw new ColdWindowMiss(`no forward progress at ${cursor}`);
      cursor = consumedTo;
    }
  }

  const lastFrame = walkBack(Number.MAX_SAFE_INTEGER);
  if (lastFrame === undefined) throw new ColdWindowMiss("no readable frame at the end of the log");
  const lastSeq = lastFrame.lastSeq;
  const totalEvents = lastSeq + 1;
  if (cut < 0 || cut >= totalEvents) throw new ColdWindowMiss(`cut ${cut} outside log (${totalEvents})`);

  if (indexPath !== undefined && size <= 0xFFFFFFFF) {
    try {
      const raw = fs.readFileSync(indexPath);
      if (raw.length >= 16 && raw.toString("ascii", 0, 6) === "DSHIDX" && raw[6] === 1) {
        const count = raw.readUInt32LE(8);
        const builtSize = raw.readUInt32LE(12);
        if (count > 0 && raw.length === 16 + count * 12 && builtSize <= size) {
          const starts = new Array(count);
          const firsts = new Array(count);
          const counts = new Array(count);
          for (let i = 0; i < count; i++) {
            starts[i] = raw.readUInt32LE(16 + i * 12);
            firsts[i] = raw.readUInt32LE(20 + i * 12);
            counts[i] = raw.readUInt32LE(24 + i * 12);
          }
          const last = count - 1;
          const frame = frameAt(starts[last], builtSize);
          if (frame !== undefined && frame.firstSeq === firsts[last] && frame.lastSeq === firsts[last] + counts[last] - 1) {
            idx = { starts, firsts, counts, end: builtSize };
            coldTrace(`cold-open index loaded: ${count} frames, coverage 0..${firsts[last] + counts[last] - 1}, end=${builtSize}`);
          }
        }
      }
    } catch {
      /* a stale or malformed sidecar is ignored; the window rebuilds it on first far read */
    }
  }

  const base = totalEvents;

  function makeView(initial, shared = false) {
    const tail = [...initial];
    const lengthOf = () => base + tail.length;
    const readAtSeq = (seq) => (seq >= base ? tail[seq - base] : get(seq));

    function range(from, to) {
      const lo = Math.max(0, from);
      const hi = Math.min(lengthOf(), to);
      const count = Math.max(0, hi - lo);
      if (count <= limit) {
        const out = [];
        for (let seq = lo; seq < hi; seq++) out.push(readAtSeq(seq));
        stats.materialized += out.length;
        return out;
      }
      const step = () => (function* () {
        const headEnd = Math.min(hi, base);
        if (lo < headEnd) yield* stream(lo, headEnd);
        const fromTail = Math.max(0, lo - base);
        const toTail = Math.max(0, hi - base);
        for (let i = fromTail; i < toTail; i++) yield tail[i];
      })();
      const lazy = {
        __cold: true,
        __coldWindowRef: view,
        get length() { return count; },
        at(index) {
          const i = index < 0 ? count + index : index;
          return i < 0 || i >= count ? undefined : readAtSeq(lo + i);
        },
        slice(from = 0, to = count) {
          const a = from < 0 ? Math.max(0, count + from) : Math.min(from, count);
          const b = to < 0 ? Math.max(0, count + to) : Math.min(to, count);
          return range(lo + a, lo + b);
        },
        [Symbol.iterator]: step,
        values: step,
        *entries() { let i = 0; for (const event of step()) yield [i++, event]; },
        *keys() { for (let i = 0; i < count; i++) yield i; },
        map(fn) { const out = []; let i = 0; for (const event of step()) out.push(fn(event, i++)); return out; },
        filter(fn) { const out = []; let i = 0; for (const event of step()) if (fn(event, i++)) out.push(event); return out; },
        find(fn) { let i = 0; for (const event of step()) if (fn(event, i++)) return event; return undefined; },
        findLast(fn) { let last; let i = 0; for (const event of step()) if (fn(event, i++)) last = event; return last; },
        some(fn) { let i = 0; for (const event of step()) if (fn(event, i++)) return true; return false; },
        every(fn) { let i = 0; for (const event of step()) if (!fn(event, i++)) return false; return true; },
        forEach(fn) { let i = 0; for (const event of step()) fn(event, i++); },
        concat(...items) { return [...step(), ...items]; },
        reduce(fn, initial) { let acc = initial; let i = 0; for (const event of step()) acc = fn(acc, event, i++); return acc; },
        indexOf(target) { let i = 0; for (const event of step()) { if (event === target) return i; i++; } return -1; },
        includes(target) { return this.indexOf(target) !== -1; },
        toSorted(fn) { return [...step()].toSorted(fn); },
        toArray() { return [...step()]; },
        toReversed() { return [...step()].toReversed(); },
      };
      return new Proxy(lazy, {
        get(target, prop, recv) {
          if (typeof prop === "string" && /^-?\d+$/.test(prop)) {
            const index = Number(prop);
            const i = index < 0 ? count + index : index;
            return i < 0 || i >= count ? undefined : readAtSeq(lo + i);
          }
          return Reflect.get(target, prop, recv);
        },
      });
    }

    const view = {
      __cold: true,
      __coldWindow: true,
      cut,
      totalEvents,
      lastSeq,
      stats,
      get,
      get length() { return lengthOf(); },
      at(index) {
        const i = index < 0 ? lengthOf() + index : index;
        return i < 0 || i >= lengthOf() ? undefined : readAtSeq(i);
      },
      slice(from = 0, to = lengthOf()) { return range(from, to); },
      // Bulk materialization for fold loops that index every event (projection
      // replays). Reading through get() costs one frame decompression per two
      // events; a chunk here decompresses many concatenated frames in one call.
      materialize(from = 0, to = lengthOf()) {
        const lo = Math.max(0, from);
        const hi = Math.min(lengthOf(), to);
        const out = [];
        const headEnd = Math.min(hi, base);
        if (lo < headEnd) {
          const first = findFrame(lo);
          if (first === undefined) throw new ColdWindowMiss(`seq ${lo} outside the window`);
          if (first.firstSeq > lo) throw new ColdWindowMiss(`gap at seq ${lo}`);
          let cursor = first.start;
          while (cursor < size) {
            let len = Math.min(8 * 1024 * 1024, size - cursor);
            let buffer;
            let starts;
            let end;
            for (;;) {
              buffer = readAt(cursor, len);
              starts = frameStartsIn(buffer).map((at) => cursor + at);
              if (starts.length === 0 || starts[0] !== cursor) throw new ColdWindowMiss(`frame boundary lost at ${cursor}`);
              const atEof = cursor + len === size;
              end = atEof ? size : starts.length > 1 ? starts.at(-1) : undefined;
              if (end !== undefined) break;
              if (atEof) throw new ColdWindowMiss(`no complete frame at ${cursor}`);
              len = Math.min(len * 2, size - cursor);
            }
            const text = zlib.zstdDecompressSync(buffer.subarray(0, end - cursor)).toString("utf8");
            for (const line of text.split("\n")) {
              if (line.length === 0) continue;
              let event;
              try { event = JSON.parse(line); } catch { continue; }
              if (event !== null && typeof event === "object" && typeof event.seq === "number" && event.seq >= lo && event.seq < headEnd) out.push(event);
            }
            cursor = end;
            if (out.length >= headEnd - lo) break;
          }
        }
        const fromTail = Math.max(0, lo - base);
        const toTail = Math.max(0, hi - base);
        for (let i = fromTail; i < toTail; i++) out.push(tail[i]);
        coldTrace(`materialize from=${lo} to=${hi} events=${out.length}`);
        return out;
      },
      *entries() { let i = 0; for (const event of range(0, lengthOf())) yield [i++, event]; },
      findLast(fn) { let last; let i = 0; for (const event of range(0, lengthOf())) if (fn(event, i++)) last = event; return last; },
      push(event) { tail.push(event); return lengthOf(); },
      [Symbol.iterator]() { return range(0, lengthOf())[Symbol.iterator](); },
      map(fn) { return range(0, lengthOf()).map(fn); },
      filter(fn) { return range(0, lengthOf()).filter(fn); },
      toReversed() { return range(0, lengthOf()).toReversed(); },
      close() { if (shared && fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } } },
    };
    return view;
  }

  const window = makeView([], true);
  window.__makeView = makeView;
  window.__checkpointRef = undefined;
  return window;
}

/**
 * Validate a checkpoint against the log buffer and return `{ window, checkpoint }`.
 * Called at decode time, before any event is materialized.
 */
export function attachCheckpoint({ meta, buffer }) {
  if (!coldOpenEnabled()) return undefined;
  const reject = (why) => { coldTrace(`attach ${meta?.id ?? "?"} reject: ${why}`); return undefined; };
  try {
    if (meta === undefined || meta.isSeeded === true) return undefined;
    const cpPath = checkpointPath(meta.id);
    if (!fs.existsSync(cpPath)) return undefined;
    const doc = JSON.parse(fs.readFileSync(cpPath, "utf8"));
    if (doc.checkpointVersion !== 1) return reject("checkpointVersion");
    if (String(doc.sessionId) !== String(meta.id)) return reject("sessionId");
    if (doc.formatVersion !== meta.version) return reject(`formatVersion ${doc.formatVersion} != ${meta.version}`);
    const identity = doc.identity ?? {};
    if (identity.createdAt !== meta.createdAt) return reject("createdAt");
    if (identity.cwd !== meta.cwd) return reject("cwd");
    if (identity.isSeeded !== (meta.isSeeded === true)) return reject("isSeeded");
    if (identity.inheritedEventCount !== 0) return reject("inheritedEventCount");
    const opened = Date.now();
    const window = createColdWindow({ buffer, cut: doc.cut, indexPath: cpPath.replace(/\.json$/, ".idx") });
    const boundary = window.get(doc.cut);
    if (boundary === undefined || hash(JSON.stringify(boundary)) !== doc.boundaryHash) {
      window.close();
      return reject("boundaryHash");
    }
    window.__checkpointRef = doc;
    coldTrace(`attach ${meta.id} ok cut=${doc.cut} events=${window.totalEvents} open=${Date.now() - opened}ms`);
    return { window, checkpoint: doc };
  } catch (error) {
    return reject(`error ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Hydrate a Session from a checkpoint window. `seed` is the lazy range produced
 * by the window's slice (tagged __cold). Returns undefined when the checkpoint
 * cannot be trusted and the caller must fall back to a full restore.
 */
export function hydrateCold({ Session, SessionLogOffset, sessionId, options, projections }) {
  const reject = (why) => { coldTrace(`hydrate ${options?.meta?.id ?? "?"} reject: ${why}`); return undefined; };
  try {
    const cold = options?.seed?.__cold === true ? options.seed : undefined;
    if (cold === undefined) return reject("seed not cold");
    const shared = options.seed.__coldWindowRef;
    const checkpoint = shared?.__checkpointRef;
    if (shared === undefined || checkpoint === undefined) return reject("window/checkpoint missing");
    if (!coldOpenEnabled()) return reject("disabled");

    if (Array.isArray(checkpoint.nodes) && new Set(checkpoint.nodes).size !== checkpoint.nodes.length) return reject("duplicate surface nodes");
    const formatVersion = options?.meta?.version;
    if (checkpoint.formatVersion !== formatVersion) return reject(`formatVersion ${checkpoint.formatVersion} != ${formatVersion}`);
    for (const entry of checkpoint.projections ?? []) {
      const type = typeof entry === "string" ? entry : entry.type;
      const code = typeof entry === "string" ? undefined : entry.code;
      const live = projections.find((p) => p.type === type);
      if (live === undefined) return reject(`projection ${type} missing`);
      if (code !== undefined && hash(String(live.project)) !== code) return reject(`projection ${type} code changed`);
    }

    const empty = Session.fromRestore(sessionId, [], options.meta, SessionLogOffset(0), options.eventState, projections);
    if (hash(JSON.stringify(empty.header)) !== checkpoint.headerHash) return reject("headerHash");

    const marker = empty.log[0];
    const numeric = /^-?\d+$/;
    const view = shared.__makeView(Array.isArray(options.coldClosers) ? options.coldClosers : []);
    // The private tail view must expose the shared checkpoint: readers (title
    // fold, incremental search observation) reach it through the lazy range's
    // __coldWindowRef, and only the shared window carried the reference.
    view.__checkpointRef = checkpoint;
    const fullProxy = new Proxy(view, {
      get(target, prop, recv) {
        if (typeof prop === "string" && numeric.test(prop)) return target.at(Number(prop));
        return Reflect.get(target, prop, recv);
      },
    });
    const base = checkpoint.cut + 1;
    const tailProxy = new Proxy({}, {
      get(target, prop, recv) {
        if (prop === "length") return view.length - base;
        if (typeof prop === "string" && numeric.test(prop)) return view.at(base + Number(prop));
        return Reflect.get(target, prop, recv);
      },
    });

    empty.log = fullProxy;
    const sm = empty.surfaceManager;
    sm.log = tailProxy;
    sm.baseSeq = SessionLogOffset(base);
    sm._lastProcessedSeq = checkpoint.cut;
    sm._pendingPlan = undefined;
    sm._state = {
      nodes: [...checkpoint.nodes],
      replaceGeneration: checkpoint.replaceGeneration,
      contentGeneration: checkpoint.contentGeneration,
      projectedMessages: new Map(checkpoint.projectedMessages),
      projections: new Set((checkpoint.projections ?? []).map((entry) => {
        const type = typeof entry === "string" ? entry : entry.type;
        return projections.find((p) => p.type === type);
      })),
    };
    const liveSeq = view.length;
    if (fullProxy.at(-1)?.type !== "session/end-seed") {
      fullProxy.push({ ...marker, seq: liveSeq });
    }
    empty.firstLiveSeq = SessionLogOffset(liveSeq);
    empty.firstLifecycleSeq = empty.firstLiveSeq;
    empty.inheritedEventCount = SessionLogOffset(0);
    const derived = checkpoint.derived;
    if (derived !== undefined && derived !== null && typeof derived === "object") {
      if (derived.requestContext !== undefined) {
        empty.contextFold = derived.requestContext;
        empty.contextFoldSeq = checkpoint.cut + 1;
      }
      if (derived.toolHistory !== undefined && derived.toolHistory !== null) {
        const th = derived.toolHistory;
        const projection = empty.toolHistoryProjection;
        if (Array.isArray(th.declared)) projection.declared = new Map(th.declared);
        if (Array.isArray(th.active)) projection.active = th.active;
        if (Array.isArray(th.available)) projection.available = new Set(th.available);
        if (th.baselineSeq !== undefined) projection.baselineSeq = th.baselineSeq;
        if (th.history !== undefined) projection.history = th.history;
        empty.toolHistorySeq = checkpoint.cut + 1;
      }
      if (derived.title !== undefined) empty.__coldTitle = derived.title;
      if (derived.tokenMeter !== undefined) empty.__coldTokenMeter = derived.tokenMeter;
    }
    const slice = (from = 0, to = fullProxy.length) => fullProxy.slice(from, to);
    empty.snapshotEvents = (from, to) => slice(from, to);
    empty.ownEvents = () => slice(0, fullProxy.length);
    coldTrace(`hydrate ${options.meta.id} ok cut=${checkpoint.cut} seq=${empty.seq} live=${empty.firstLiveSeq} nodes=${empty.surface.nodes.length} closers=${(options.coldClosers ?? []).length} view=${view.length}`);
    return empty;
  } catch (error) {
    return reject(`error ${error instanceof Error ? error.message : String(error)}`);
  }
}
