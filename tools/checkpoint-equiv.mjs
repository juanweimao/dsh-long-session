/**
 * Offline equivalence test: full fold from seq 0 vs checkpoint-at-cut + tail fold.
 *
 * Read-only. Loads the real session log, builds the surface twice:
 *   A) Session.fromRestore(all events)              -> final state
 *   B) Session.fromRestore(events[0..CUT]) then
 *      swap its SurfaceManager log to the tail and
 *      continue folding from CUT+1                   -> final state
 * Compares nodes / generations / projectedMessages and records any read that
 * reaches below the cut (a proxy returns undefined for negative indexes, the
 * same thing a plain array would do).
 *
 * Usage: DSH_RUNTIME=<runtime root> node --max-old-space-size=12288 \n *   tools/checkpoint-equiv.mjs <log> [cutSeq]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import util from 'node:util';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// DSH_RUNTIME: extracted desktop runtime (default: the Windows install path).
const runtimeRoot = process.env.DSH_RUNTIME ?? 'D:/DeepSeek Harness/resources/dsh-runtime';
const RT = pathToFileURL(path.join(runtimeRoot, 'node_modules', '@deepseek-ai')).href;
const { Session, SessionId, SessionLogOffset } = await import(RT + '/dsh-session/lib/index.js');
const { imageOffloadProjection } = await import(RT + '/dsh-compaction-image-offload/lib/types/projection.js');
const projections = [imageOffloadProjection];

const logPath = process.argv[2];
const CUT = Number(process.argv[3] ?? 435451);
const mb = (n) => (n / 1024 / 1024).toFixed(1);

// ---- load ------------------------------------------------------------------
let t = Date.now();
const buf = fs.readFileSync(logPath);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const starts = [];
let i = buf.indexOf(MAGIC);
while (i !== -1) { starts.push(i); i = buf.indexOf(MAGIC, i + 1); }

let header;
const events = [];
const frameRanges = []; // [firstEventIdx, endEventIdx, headerLineOffset]
for (let k = 0; k < starts.length; k++) {
  const end = starts[k + 1] ?? buf.length;
  const text = zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8');
  const from = events.length;
  let off = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (header === undefined) { header = JSON.parse(line); off = 1; continue; }
    events.push(JSON.parse(line));
  }
  frameRanges.push([from, events.length, off]);
}

// seq == index (verified below), so one frame decompress serves any random read
const coldCache = { k: -1, lines: null };
let coldDecompress = 0;
function frameOf(seq) {
  if (seq < 0 || seq >= events.length) return -1;
  let lo = 0, hi = frameRanges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = frameRanges[mid];
    if (seq < a) hi = mid - 1;
    else if (seq >= b) lo = mid + 1;
    else return mid;
  }
  return -1;
}
function coldGet(seq) {
  const k = frameOf(seq);
  if (k < 0) return undefined;
  if (coldCache.k !== k) {
    const end = starts[k + 1] ?? buf.length;
    coldCache.lines = zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8').split('\n');
    coldCache.k = k;
    coldDecompress++;
  }
  const [a, , off] = frameRanges[k];
  const line = coldCache.lines[seq - a + off];
  return line ? JSON.parse(line) : undefined;
}
console.log('frames :', starts.length);
console.log('events :', events.length, '| first seq', events[0].seq, '| last seq', events.at(-1).seq);
console.log('load   :', ((Date.now() - t) / 1000).toFixed(1), 's | rss', mb(process.memoryUsage().rss), 'MB');

const h = { ...header };
delete h.type;
h.version ??= 4;
h.id ??= 'session-unknown';
if (typeof h.createdAt !== 'number') h.createdAt = Date.now();
if (typeof h.isSeeded !== 'boolean') h.isSeeded = false;

const norm = (s) => ({
  nodes: [...s.nodes],
  replaceGeneration: s.replaceGeneration,
  contentGeneration: s.contentGeneration,
  projectedMessages: [...s.projectedMessages.entries()].sort((a, b) => a[0] - b[0]),
});

// ---- A: full fold from 0 ---------------------------------------------------
t = Date.now();
const full = Session.fromRestore(SessionId(h.id), events, h, SessionLogOffset(0), 'detached', projections);
void full.surfaceManager.replaceGeneration; // force the fold
const tFull = Date.now() - t;
const A = norm(full.surfaceManager._state);
console.log('\nA full fold      :', (tFull / 1000).toFixed(2), 's | nodes', A.nodes.length,
  '| replGen', A.replaceGeneration, '| contentGen', A.contentGeneration,
  '| projMsgs', A.projectedMessages.length);

// ---- B: cut + tail ---------------------------------------------------------
t = Date.now();
const seed = events.slice(0, CUT + 1);
const cut = Session.fromRestore(SessionId(h.id), seed, h, SessionLogOffset(0), 'detached', projections);
const sm = cut.surfaceManager;
void sm.replaceGeneration; // force the prefix fold
const tCut = Date.now() - t;

const C = norm(sm._state);
const checkpointJson = JSON.stringify({
  baseSeq: CUT,
  ...C,
  projections: [...sm._state.projections].map((p) => p.type),
});
console.log('checkpoint state :', checkpointJson.length, 'bytes | nodes', C.nodes.length,
  '| projMsgs', C.projectedMessages.length, '| at', events[CUT]?.type, events[CUT]?.seq);

// the prefix Session appended a synthetic session/end-seed; drop it (surface-neutral)
const appended = sm.log.at(-1);
if (appended?.type === 'session/end-seed') sm.log.pop();

const tailRaw = events.slice(CUT + 1);
const crossReads = [];
const tail = new Proxy(tailRaw, {
  get(target, prop, recv) {
    if (typeof prop === 'string' && /^-\d+$/.test(prop)) {
      const seq = CUT + 1 + Number(prop);
      const hit = coldGet(seq);
      crossReads.push({ seq, type: hit?.type ?? '(unresolved)' });
      return hit;
    }
    return Reflect.get(target, prop, recv);
  },
});

// ---- B: deserialize the checkpoint into a fresh manager, fold the tail -----
t = Date.now();
const cp = JSON.parse(checkpointJson);
const fresh = Session.fromRestore(SessionId(h.id), [], h, SessionLogOffset(0), 'detached', projections);
const fm = fresh.surfaceManager;
fm.log = tail;
fm.baseSeq = SessionLogOffset(CUT + 1);
fm._lastProcessedSeq = CUT;
fm._pendingPlan = undefined;
fm._state = {
  nodes: cp.nodes,
  replaceGeneration: cp.replaceGeneration,
  contentGeneration: cp.contentGeneration,
  projectedMessages: new Map(cp.projectedMessages),
  projections: new Set(cp.projections.map((type) => {
    const p = projections.find((x) => x.type === type);
    if (p === undefined) throw new Error('checkpoint references missing projection ' + type);
    return p;
  })),
};
void fm.replaceGeneration; // fold the tail from the deserialized state
const tTail = Date.now() - t;
const B = norm(fm._state);

console.log('B prefix fold    :', (tCut / 1000).toFixed(2), 's | checkpoint nodes', C.nodes.length,
  '| cut event', events[CUT]?.type, events[CUT]?.seq);
console.log('B cold fold      :', (tTail / 1000).toFixed(3), 's | tail events', tailRaw.length,
  '| nodes', B.nodes.length, '| replGen', B.replaceGeneration,
  '| contentGen', B.contentGeneration, '| projMsgs', B.projectedMessages.length);
console.log('cross-cut reads  :', crossReads.length, JSON.stringify(crossReads.slice(0, 8)),
  '| cold frame decompress', coldDecompress);

// ---- compare ---------------------------------------------------------------
const kA = frameOf(CUT + 1);
const kB = frameOf(events.length - 1);
const tailBytes = (starts[kB + 1] ?? buf.length) - starts[kA];
console.log('cold-open span   : frames', kB - kA + 1, '|', (tailBytes / 1024).toFixed(1), 'KB of file');

const sameNodes = util.isDeepStrictEqual(A.nodes, B.nodes);
const sameGen = A.replaceGeneration === B.replaceGeneration && A.contentGeneration === B.contentGeneration;
const sameMsgs = util.isDeepStrictEqual(A.projectedMessages, B.projectedMessages);
const unresolved = crossReads.filter((r) => r.type === '(unresolved)');
console.log('\nnodes equal      :', sameNodes);
console.log('generations equal:', sameGen, `(${A.replaceGeneration}/${A.contentGeneration} vs ${B.replaceGeneration}/${B.contentGeneration})`);
console.log('projMsgs equal   :', sameMsgs);
console.log('unresolved reads :', unresolved.length);
console.log('VERDICT          :', sameNodes && sameGen && sameMsgs && unresolved.length === 0 ? 'EQUIVALENT' : 'MISMATCH');

if (!sameNodes) {
  const lim = Math.max(A.nodes.length, B.nodes.length);
  for (let k = 0; k < lim; k++) {
    if (A.nodes[k] !== B.nodes[k]) {
      console.log('first node diff at', k, 'A=', A.nodes[k], 'B=', B.nodes[k]);
      console.log('A around:', A.nodes.slice(Math.max(0, k - 3), k + 4));
      console.log('B around:', B.nodes.slice(Math.max(0, k - 3), k + 4));
      break;
    }
  }
}
if (!sameMsgs) {
  const bm = new Map(B.projectedMessages);
  for (const [seq, msg] of A.projectedMessages) {
    if (!util.isDeepStrictEqual(msg, bm.get(seq))) { console.log('projMsg diff at seq', seq); break; }
  }
}
console.log('rss final        :', mb(process.memoryUsage().rss), 'MB');

// ---- artifacts for the cold-open benchmark ---------------------------------
const OK = sameNodes && sameGen && sameMsgs && unresolved.length === 0;
if (OK) {
  const OUT = process.env.COLD_EQUIV_OUT ?? path.join(os.tmpdir(), 'cold-open-equiv');
  fs.mkdirSync(OUT, { recursive: true });
  const idx = new Uint32Array(frameRanges.length * 2);
  for (let k = 0; k < frameRanges.length; k++) {
    idx[k * 2] = starts[k];
    idx[k * 2 + 1] = frameRanges[k][1] - frameRanges[k][0];
  }
  fs.writeFileSync(OUT + '/cold.idx', Buffer.from(idx.buffer));
  fs.writeFileSync(OUT + '/cold.checkpoint.json', checkpointJson);
  const digest = createHash('sha256').update(JSON.stringify({
    nodes: A.nodes,
    rg: A.replaceGeneration,
    cg: A.contentGeneration,
    pm: A.projectedMessages,
  })).digest('hex');
  fs.writeFileSync(OUT + '/cold.meta.json', JSON.stringify({
    log: logPath,
    id: h.id,
    totalEvents: events.length,
    cut: CUT,
    cutEvent: events[CUT]?.type,
    header: h,
    expected: digest,
    indexBytes: idx.byteLength,
    checkpointBytes: checkpointJson.length,
  }, null, 1));
  console.log('artifacts        :', OUT, '| idx', (idx.byteLength / 1024 / 1024).toFixed(2), 'MB | cp', checkpointJson.length, 'B');
  console.log('expected digest  :', digest);
}
