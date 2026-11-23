// Cold-open support for long DSH sessions (2026-11-14).
//
// Makes the desktop host open a 435k-event session from
// {dsh-surface-checkpoint sidecar, lazy zstd frame window} instead of decoding
// and materializing the whole log. Result on the real session: 11 s / 879 MB
// instead of 134 s / 6.1 GB.
//
//   node apply-cold-open.cjs [path-to-runtime]
//
// Idempotent; aborts on anchor drift. Rerun after re-extracting the runtime.
// Companion plugin (outside the runtime, untouched by app updates):
//   %USERPROFILE%\.dsh\plugins\dsh-surface-checkpoint   (writes the sidecar)
// Enable marker: %USERPROFILE%\.dsh\cold-open.on
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const root = process.argv[2] || 'D:/DeepSeek Harness/resources/dsh-runtime';
const BASE = path.join(root, 'node_modules', '@deepseek-ai');

function log(message) {
  console.log('[cold-open] ' + message);
}
function die(message) {
  console.error('[cold-open] ABORT: ' + message);
  process.exit(1);
}
function check(file, src) {
  const tmp = path.join(os.tmpdir(), `cold-open-${path.basename(file)}-${process.pid}.mjs`);
  fs.writeFileSync(tmp, src, 'utf8');
  const result = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  fs.unlinkSync(tmp);
  if (result.status !== 0) die(`${file}: patched source does not parse\n${result.stderr || result.stdout}`);
}

function edit(rel, patches) {
  const file = path.join(BASE, rel);
  if (!fs.existsSync(file)) die(`${rel} not found under ${BASE}`);
  let src = fs.readFileSync(file, 'utf8');
  let changed = false;
  for (const patch of patches) {
    if (src.includes(patch.mark)) {
      log(`${rel}: ${patch.label} already applied`);
      continue;
    }
    const match = src.match(patch.find);
    if (match === null) {
      if (patch.optional === true) { log(`${rel}: ${patch.label} not present in this version, skipped`); continue; }
      die(`${rel}: anchor drift for "${patch.label}" — refusing to guess`);
    }
    src = src.replace(patch.find, patch.replace);
    changed = true;
    log(`${rel}: ${patch.label} applied`);
  }
  if (!changed) return;
  check(rel, src);
  const backup = file + '.bak-before-coldopen';
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, src, 'utf8');
}

// ---- 1) the lazy window / hydration module ---------------------------------
const moduleSource = path.join(__dirname, 'cold-open.js');
if (!fs.existsSync(moduleSource)) die('cold-open.js is missing next to apply-cold-open.cjs');
const moduleTarget = path.join(BASE, 'dsh-session', 'lib', 'cold-open.js');
fs.mkdirSync(path.dirname(moduleTarget), { recursive: true });
const wanted = fs.readFileSync(moduleSource, 'utf8');
const current = fs.existsSync(moduleTarget) ? fs.readFileSync(moduleTarget, 'utf8') : null;
if (current === wanted) log('dsh-session/lib/cold-open.js already current');
else {
  if (current !== null) {
    const backup = moduleTarget + '.bak-before-coldopen';
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, current, 'utf8');
  }
  fs.writeFileSync(moduleTarget, wanted, 'utf8');
  log('dsh-session/lib/cold-open.js written');
}

// ---- 2) dsh-session: import / export / prepare / create / closers / fork ---
edit('dsh-session/lib/index.js', [
  {
    label: 'import cold-open helpers',
    mark: 'from "./cold-open.js";',
    find: /import \{ callConfigEquals \} from "@deepseek-ai\/dsh-llm";/,
    replace: 'import { callConfigEquals } from "@deepseek-ai/dsh-llm";\nimport { attachCheckpoint, hydrateCold, coldTrace } from "./cold-open.js";',
  },
  {
    label: 'export attachCheckpoint',
    mark: ', attachCheckpoint,',
    find: /export \{ KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION, Session,/,
    replace: 'export { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION, attachCheckpoint, Session,',
  },
  {
    label: 'cold hydrate in prepare()',
    mark: 'seedCells(cold, options.seed)',
    find: /([ \t]*)case "detached":\n\1case "shared-frozen": \{\n\1\tconst session = Session\.fromRestore\(sessionId, options\.seed, options\.meta, options\.inheritedEventCount, eventState, this\.projections\);/,
    replace: (m, i) =>
      `${i}case "detached":\n${i}case "shared-frozen": {\n` +
      `${i}\tif (options.seed?.__cold === true) {\n` +
      `${i}\t\tconst cold = hydrateCold({ Session, SessionLogOffset, sessionId, options, projections: this.projections });\n` +
      `${i}\t\tif (cold !== undefined) {\n` +
      `${i}\t\t\ttry {\n` +
      `${i}\t\t\t\tconst cache = this.ctx.get("sessionProjectionCache");\n` +
      `${i}\t\t\t\tif (cache !== void 0 && typeof cache.seedCells === "function") cache.seedCells(cold, options.seed);\n` +
      `${i}\t\t\t} catch {\n` +
      `${i}\t\t\t\t/* cell seeding is an optimization; unseeded cells still work */\n` +
      `${i}\t\t\t}\n` +
      `${i}\t\t\tattachments.set(cold, null);\n` +
      `${i}\t\t\treturn cold;\n` +
      `${i}\t\t}\n` +
      `${i}\t\tcoldTrace(\`prepare fallback: materializing \${options.seed.length} events for \${String(sessionId)}\`);\n` +
      `${i}\t\toptions = { ...options, seed: [...options.seed] };\n` +
      `${i}\t}\n` +
      `${i}\tconst session = Session.fromRestore(sessionId, options.seed, options.meta, options.inheritedEventCount, eventState, this.projections);`,
  },
  {
    label: 'cold hydrate in Session.create',
    mark: 'if (seed?.__cold === true) {',
    find: /([ \t]*)static create\(id, seed, header, inheritedEventCount, projections\) \{\n\1\treturn new Session\(id, seed, header, "snapshot", inheritedEventCount, projections\);\n\1\}/,
    replace: (m, i) =>
      `${i}static create(id, seed, header, inheritedEventCount, projections, coldClosers) {\n` +
      `${i}\tif (seed?.__cold === true) {\n` +
      `${i}\t\tconst cold = hydrateCold({ Session, SessionLogOffset, sessionId: id, options: { seed, meta: header, inheritedEventCount, eventState: "detached", coldClosers }, projections });\n` +
      `${i}\t\tif (cold !== undefined) return cold;\n` +
      `${i}\t\tseed = [...seed];\n` +
      `${i}\t}\n` +
      `${i}\treturn new Session(id, seed, header, "snapshot", inheritedEventCount, projections);\n` +
      `${i}}`,
  },
  {
    label: 'closed-turn fast path in openTurnClosers',
    mark: 'Fast path for cold logs',
    find: /([ \t]*)function openTurnClosers\(events, cause\) \{\n\1\tlet openTurn = null;/,
    replace: (m, i) =>
      `${i}function openTurnClosers(events, cause) {\n` +
      `${i}\t// Fast path for cold logs: when a recent turn/end precedes any turn/start,\n` +
      `${i}\t// the turn is closed and no closers or tool recovery can be produced, so the\n` +
      `${i}\t// whole log does not need to be scanned. Equivalent to the full fold below.\n` +
      `${i}\tfor (let i = 1; i <= Math.min(256, events.length); i++) {\n` +
      `${i}\t\tconst event = events.at(-i);\n` +
      `${i}\t\tif (event === void 0) break;\n` +
      `${i}\t\tif (event.type === "turn/end") return [];\n` +
      `${i}\t\tif (event.type === "turn/start") break;\n` +
      `${i}\t}\n` +
      `${i}\tlet openTurn = null;`,
  },
  {
    label: 'materialize non-array fork seeds',
    mark: 'Array.isArray(events) ? events.slice(0, boundary + 1)',
    find: /([ \t]*)function buildForkSeed\(events, boundary\) \{\n\1\tconst prefix = events\.slice\(0, boundary \+ 1\);/,
    replace: (m, i) =>
      `${i}function buildForkSeed(events, boundary) {\n` +
      `${i}\tconst prefix = Array.isArray(events) ? events.slice(0, boundary + 1) : [...events.slice(0, boundary + 1)];`,
  },
  {
    label: 'scan request headers from the tail',
    mark: 'for (let i = events.length - 1; i >= 0; i--)',
    find: /([ \t]*)function foldRequestHeader\(events, from\) \{\n\1\tlet state = from;\n\1\tfor \(const event of events\) if \(event\.type === "request\/header"\) state = canonicalHeader\(event\.data\.header\);\n\1\treturn state;\n\1\}/,
    replace: (m, i) =>
      `${i}function foldRequestHeader(events, from) {\n` +
      `${i}\tfor (let i = events.length - 1; i >= 0; i--) {\n` +
      `${i}\t\tconst event = events[i];\n` +
      `${i}\t\tif (event !== undefined && event.type === "request/header") return canonicalHeader(event.data.header);\n` +
      `${i}\t}\n` +
      `${i}\treturn from;\n` +
      `${i}}`,
  },
]);

// ---- 3) persistence: cold-aware validation --------------------------------
edit('dsh-session-persistence/lib/index.js', [
  {
    label: 'streaming validation for cold windows',
    mark: 'if (events.__cold === true) {',
    find: /([ \t]*)function validateStoredEvents\(meta, events, location\) \{\n\1\tfor \(const event of events\) \{/,
    replace: (m, i) =>
      `${i}function validateStoredEvents(meta, events, location) {\n` +
      `${i}\tif (events.__cold === true) {\n` +
      `${i}\t\tconst from = Number.isSafeInteger(events.cut) ? events.cut + 1 : 0;\n` +
      `${i}\t\tfor (let seq = from; seq < events.length; seq++) {\n` +
      `${i}\t\t\tconst event = events.at(seq);\n` +
      `${i}\t\t\tif (event === undefined) continue;\n` +
      `${i}\t\t\tif (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(\`session "\${meta.id}" contains event type "\${event.type}" (seq \${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness\`, location);\n` +
      `${i}\t\t\tif (event.type === "request/header") {\n` +
      `${i}\t\t\t\tconst data = event.data;\n` +
      `${i}\t\t\t\tif (typeof data === "object" && data !== null && data["reason"] === "fallback") throw unsupported(\`session "\${meta.id}" contains a request/header event (seq \${event.seq}) with the unsupported legacy reason "fallback"; refusing to interpret the log — it was written by a retired pre-release harness\`, location);\n` +
      `${i}\t\t\t}\n` +
      `${i}\t\t}\n` +
      `${i}\t\treturn events;\n` +
      `${i}\t}\n` +
      `${i}\tfor (const event of events) {`,
  },
]);

// ---- 4) jsonl persistence: decode-time short circuit ----------------------
edit('dsh-session-persistence-jsonl/lib/index.js', [
  {
    label: 'import attachCheckpoint',
    mark: ', attachCheckpoint }',
    // 0.2.2-rc5: imports Session, SessionId, SessionLogOffset
    // 0.2.3:      drops Session/SessionId, adds validateSessionLog
    find: /import \{ KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION, [^}]*\} from "@deepseek-ai\/dsh-session";/,
    replace: (matched) => matched.replace(' } from "@deepseek-ai/dsh-session";', ', attachCheckpoint } from "@deepseek-ai/dsh-session";'),
  },
  {
    label: 'stop decoding after the header frame',
    mark: 'const cold = attachCheckpoint({ meta: scanner.meta, buffer });',
    find: /([ \t]*)assertZstdHeaderFrame\(headerFrame\.value\);\n\1const scanner = new SessionLogScanner\(headerFrame\.value\);\n\1let remainingFrames = frames\.length - 1;/,
    replace: (m, i) =>
      `${i}assertZstdHeaderFrame(headerFrame.value);\n` +
      `${i}const scanner = new SessionLogScanner(headerFrame.value);\n` +
      `${i}const cold = attachCheckpoint({ meta: scanner.meta, buffer });\n` +
      `${i}if (cold !== undefined) return {\n` +
      `${i}\tmeta: scanner.meta,\n` +
      `${i}\tinheritedEventCount: SessionLogOffset(cold.checkpoint.identity.inheritedEventCount),\n` +
      `${i}\tevents: cold.window,\n` +
      `${i}\ttornTruncateTo: void 0,\n` +
      `${i}\trecoveredTail: []\n` +
      `${i}};\n` +
      `${i}let remainingFrames = frames.length - 1;`,
  },
  {
    label: 'skip freezing cold windows',
    mark: 'if (events.__cold === true) return {',
    find: /([ \t]*)function freezeStoredEvents\(events\) \{\n\1\tfor \(const event of events\) freezeStoredEvent\(event\);/,
    replace: (m, i) =>
      `${i}function freezeStoredEvents(events) {\n` +
      `${i}\tif (events.__cold === true) return {\n` +
      `${i}\t\teventState: "detached",\n` +
      `${i}\t\tevents\n` +
      `${i}\t};\n` +
      `${i}\tfor (const event of events) freezeStoredEvent(event);`,
  },
]);

// ---- 5) session-query: keep the lazy seed in the cold read ----------------
edit('dsh-session-query/lib/index.js', [
  {
    label: 'keep the lazy range in readColdSessionLog',
    mark: 'const coldSeed = events.__cold === true;',
    // 0.2.3 inserted `persistedEventCount` into the returned object, so rebuild
    // only the head of the return and patch the events line separately (5b).
    find: /([ \t]*)const \{ events \} = read;\n(\1return \{)/,
    replace: (m, i, ret) =>
      `${i}const { events } = read;\n` +
      `${i}const closers = interruptedTurnClosers(events);\n` +
      `${i}const coldSeed = events.__cold === true;\n` +
      `${ret}`,
  },
  {
    label: 'cold closers on the events line',
    mark: 'events: coldSeed ? events',
    find: /([ \t]*)events: \[\.\.\.events, \.\.\.interruptedTurnClosers\(events\)\]/,
    replace: (m, i) =>
      `${i}events: coldSeed ? events : [...events, ...closers],\n` +
      `${i}closers: coldSeed ? closers : []`,
  },
  {
    label: 'pass cold closers into prepare',
    mark: 'coldClosers: loaded.closers',
    find: /([ \t]*)session = this\.ctx\.sessions\.prepare\(sessionId, \{\n\1\tseed,\n\1\tmeta: structuredClone\(loaded\.header\),\n\1\tinheritedEventCount: loaded\.inheritedEventCount,\n\1\teventState: loaded\.eventState\n\1\}\);/,
    replace: (m, i) =>
      `${i}session = this.ctx.sessions.prepare(sessionId, {\n` +
      `${i}\tseed,\n` +
      `${i}\tmeta: structuredClone(loaded.header),\n` +
      `${i}\tinheritedEventCount: loaded.inheritedEventCount,\n` +
      `${i}\teventState: loaded.eventState,\n` +
      `${i}\tcoldClosers: loaded.closers\n` +
      `${i}});`,
  },
  {
    label: 'pass cold closers into Session.create',
    mark: 'currentSessionMessageProjections, loaded.closers',
    // 0.2.3 removed the Session.create() path: every cold read goes through
    // sessions.prepare() now, so only the prepare patch applies there.
    optional: true,
    find: /([ \t]*)Session\.create\(sessionId, loaded\.events, loaded\.header, loaded\.inheritedEventCount, currentSessionMessageProjections\);/,
    replace: (m, i) =>
      `${i}Session.create(sessionId, loaded.events, loaded.header, loaded.inheritedEventCount, currentSessionMessageProjections, loaded.closers);`,
  },
  {
    label: 'lazy events for cold live snapshots',
    mark: 'events: cold ? session.snapshotEvents()',
    find: /function snapshotLive\(session\) \{\n\treturn \{\n\t\theader: structuredClone\(session\.header\),\n\t\tinheritedEventCount: session\.inheritedEventCount,\n\t\tevents: session\.snapshotEvents\(\)\.map\(\(event\) => structuredClone\(event\)\)\n\t\};\n\}/,
    replace: () =>
      'function snapshotLive(session) {\n' +
      '\tconst cold = session.log?.__cold === true;\n' +
      '\treturn {\n' +
      '\t\theader: structuredClone(session.header),\n' +
      '\t\tinheritedEventCount: session.inheritedEventCount,\n' +
      '\t\tevents: cold ? session.snapshotEvents() : session.snapshotEvents().map((event) => structuredClone(event))\n' +
      '\t};\n' +
      '}',
  },
]);

// ---- 5b) projection replay: materialize a cold window once -----------------
// A stateVersion bump (an app upgrade) makes every stored row unusable, and
// restore() then folds the whole log. Indexing a lazy cold view costs one frame
// decompression per event; materialize() decodes whole chunks at once, so the
// replay runs over a plain array instead (2026-11-23: 3 units x 480k events had
// the host pinned for 20+ minutes after the 0.2.3 upgrade).
edit('dsh-session-projection/lib/index.js', [
  {
    label: 'materialize cold events before a replay',
    mark: 'events.materialize(0, events.length)',
    find: /([ \t]*)const endSeq = events\.at\(-1\)\?\.seq \?\? cursorBefore\(baseSeq\);\n\1const beforeBase = cursorBefore\(baseSeq\);/,
    replace: (m, i) =>
      `${i}const endSeq = events.at(-1)?.seq ?? cursorBefore(baseSeq);\n` +
      `${i}const beforeBase = cursorBefore(baseSeq);\n` +
      `${i}if (events !== undefined && events.__cold === true && typeof events.materialize === "function") {\n` +
      `${i}\tconst needsReplay = [...this.registrations.values()].some((registration) => {\n` +
      `${i}\t\tif (registration.refs === 0) return false;\n` +
      `${i}\t\tconst row = checkpoint[registration.def.key];\n` +
      `${i}\t\treturn !(row !== undefined && row.ver === registration.def.stateVersion && row.seq >= beforeBase && row.seq <= endSeq);\n` +
      `${i}\t});\n` +
      `${i}\tif (needsReplay) {\n` +
      `${i}\t\tconst materialized = events.materialize(0, events.length);\n` +
      `${i}\t\tif (materialized.length !== events.length) throw new Error(\`cold window materialized \${materialized.length} of \${events.length} events\`);\n` +
      `${i}\t\tevents = materialized;\n` +
      `${i}\t}\n` +
      `${i}}`,
  },
]);

// ---- 6) projection cache: seed cells, skip cold checkpointing -------------
edit('dsh-session-projection-cache/lib/index.js', [
  {
    label: 'seedCells() for cold Sessions',
    mark: 'seedCells(session, events) {',
    find: /([ \t]*)\/\*\*\n\1\* Durably checkpoint one live session NOW/,
    replace: (m, i) =>
      `${i}/**\n` +
      `${i}* Seed a cold Session's projection cells from its durable record.\n` +
      `${i}* Units with a usable row advance only the tail; a missing record leaves the\n` +
      `${i}* cells unbuilt (the caller's own paths still work, just slower). Never falls\n` +
      `${i}* back to folding the whole log here.\n` +
      `${i}* @param session - cold hydrated Session.\n` +
      `${i}* @param events - the Session's lazy log window/range.\n` +
      `${i}* @returns whether a record was applied.\n` +
      `${i}*/\n` +
      `${i}seedCells(session, events) {\n` +
      `${i}\tlet record;\n` +
      `${i}\ttry {\n` +
      `${i}\t\trecord = this.recordFor(session.id, identityOf(session.header, session.inheritedEventCount));\n` +
      `${i}\t} catch {\n` +
      `${i}\t\treturn false;\n` +
      `${i}\t}\n` +
      `${i}\tif (record === void 0) return false;\n` +
      `${i}\ttry {\n` +
      `${i}\t\tthis.ctx.sessionProjections.hydrate(session, record.rows, events, SessionLogOffset(0));\n` +
      `${i}\t\t// Every live unit now owns a cell at the observation cut, so the\n` +
      `${i}\t\t// throttled write can advance the rows over the tail instead of folding\n` +
      `${i}\t\t// the whole cold log once per unit (see write()).\n` +
      `${i}\t\tsession.__coldProjectionSeeded = true;\n` +
      `${i}\t\treturn true;\n` +
      `${i}\t} catch (error) {\n` +
      `${i}\t\tthis.ctx.logger.warn(\`session projection cache: cold cell hydration failed for "\${session.id}": \${String(error)}\`);\n` +
      `${i}\t\treturn false;\n` +
      `${i}\t}\n` +
      `${i}}\n` +
      `${i}/**\n` +
      `${i}* Durably checkpoint one live session NOW`,
  },
  {
    label: 'skip checkpointing cold observation Sessions',
    mark: 'A cold observation Session is a transient read view',
    find: /([ \t]*)async write\(session\) \{\n\1\tconst rows = this\.ctx\.sessionProjections\.checkpoint\(session\);/,
    replace: (m, i) =>
      `${i}async write(session) {\n` +
      `${i}\tif (session.log?.__cold === true) {\n` +
      `${i}\t\t// A cold observation Session is a transient read view: its durable rows\n` +
      `${i}\t\t// already exist, and checkpointing it would fold every registered unit\n` +
      `${i}\t\t// over the whole cold log (one full decompression scan per unit). The\n` +
      `${i}\t\t// one cold Session worth writing is the *live* one seedCells() primed:\n` +
      `${i}\t\t// its cells sit at the observation cut, so the rows advance over the\n` +
      `${i}\t\t// tail only. Skipping that write leaves the durable record frozen at the\n` +
      `${i}\t\t// seq it was last written at, and every reopen replays thousands of\n` +
      `${i}\t\t// events through every registered unit.\n` +
      `${i}\t\tif (this.ctx.sessions.get(session.id) !== session || session.__coldProjectionSeeded !== true) {\n` +
      `${i}\t\t\tthis.markClean(session);\n` +
      `${i}\t\t\treturn;\n` +
      `${i}\t\t}\n` +
      `${i}\t}\n` +
      `${i}\tconst rows = this.ctx.sessionProjections.checkpoint(session);`,
  },
]);

// ---- 7) agent loop: lazy reverse scan + lazy resume seed -------------------
edit('dsh-agent-loop/lib/index.js', [
  {
    label: 'lazy reverse event scan',
    mark: 'function* eventsNewestFirst(session)',
    find: /([ \t]*)function eventsNewestFirst\(session\) \{\n\1\treturn session\.snapshotEvents\(\)\.toReversed\(\);\n\1\}/,
    replace: (m, i) =>
      `${i}function* eventsNewestFirst(session) {
` +
      `${i}	const nodes = session.surface.nodes;
` +
      `${i}	for (let i = nodes.length - 1; i >= 0; i--) {
` +
      `${i}		const event = session.eventAt(nodes[i]);
` +
      `${i}		if (event !== undefined) yield event;
` +
      `${i}	}
` +
      `${i}}`,
  },
  {
    label: 'keep the lazy seed on resume',
    mark: 'const coldSeed = persisted.__cold === true;',
    find: /([ \t]*)const persisted = coldRead\.events;\n\1const closers = interruptedTurnClosers\(persisted\);\n\1if \(closers\.length > 0\) await handle\.append\(closers\);\n\1preparation = SessionPreparation\.create\(this\.runtime\.ctx\.sessions\.prepare\(id, \{\n\1\tseed: \[\.\.\.persisted, \.\.\.closers\],/,
    replace: (m, i) =>
      `${i}const persisted = coldRead.events;\n` +
      `${i}const closers = interruptedTurnClosers(persisted);\n` +
      `${i}if (closers.length > 0) await handle.append(closers);\n` +
      `${i}const coldSeed = persisted.__cold === true;\n` +
      `${i}preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(id, {\n` +
      `${i}\tseed: coldSeed ? persisted : [...persisted, ...closers],\n` +
      `${i}\t...(coldSeed ? { coldClosers: closers } : {}),`,
  },
]);

// ---- 7b) coalesce incremental system-prompt writes -------------------------
// 0.2.3 appends one system message per systemPrompt section change and keeps
// every copy until a compaction rebuild. A large volatile section (a memory
// index) therefore adds a full copy per write. Replace the previous increment
// in place instead of appending another one — but only when the new message
// covers every section the previous increment carried: the admission returns a
// delta, so replacing a delta that holds other sections would silently drop
// their latest text and fall back to the head's stale copy.
edit('dsh-agent-loop/lib/index.js', [
  {
    label: 'coalesce incremental system-prompt writes',
    mark: 'this.systemPromptAppend = { sessionId',
    // 0.2.2 has no systemUpdates() at all (per-source incremental admission is
    // new in 0.2.3), so the anchor is absent there and the section is skipped.
    optional: true,
    find: /([ \t]*)for \(const \{ message, intent \} of assembly\.systemUpdates\(!firstAttempt\)\) this\.session\.append\("system\/message", \{\n\1\tturn,\n\1\tstep,\n\1\tmessage\n\1\}, intent\);/,
    replace: (m, i) =>
      `${i}for (const { message, intent } of assembly.systemUpdates(!firstAttempt)) {\n` +
      `${i}\tconst nodes = this.session.surface.nodes;\n` +
      `${i}\tconst prev = this.systemPromptAppend;\n` +
      `${i}\tconst isPromptAppend = intent?.surfaceOp === "append" && message.source?.kind === "system-prompt";\n` +
      `${i}\tconst names = isPromptAppend ? (message.source.sections ?? []).map((section) => section.name) : [];\n` +
      `${i}\tconst covers = prev !== void 0 && prev.sessionId === this.session.id && prev.names.every((name) => names.includes(name));\n` +
      `${i}\tconst replaceable = isPromptAppend && covers && nodes[0] !== prev.seq && nodes.includes(prev.seq);\n` +
      `${i}\tconst written = this.session.append("system/message", {\n` +
      `${i}\t\tturn,\n` +
      `${i}\t\tstep,\n` +
      `${i}\t\tmessage\n` +
      `${i}\t}, replaceable ? {\n` +
      `${i}\t\tsurfaceOp: {\n` +
      `${i}\t\t\top: "replace",\n` +
      `${i}\t\t\tstartSeq: prev.seq,\n` +
      `${i}\t\t\tendSeq: prev.seq\n` +
      `${i}\t\t},\n` +
      `${i}\t\tsourceEventSeqs: [prev.seq]\n` +
      `${i}\t} : intent);\n` +
      `${i}\tif (isPromptAppend) this.systemPromptAppend = { sessionId: this.session.id, seq: written.seq, names };\n` +
      `${i}\telse if (intent?.surfaceOp !== "append") this.systemPromptAppend = void 0;\n` +
      `${i}}`,
  },
]);

// ---- 8) session title: memoize the folded title per Session ----------------
edit('dsh-session-title/lib/index.js', [
  {
    label: 'title memo field',
    mark: 'titleMemo = /* @__PURE__ */ new WeakMap();',
    find: /([ \t]*)titleInputProjectionHandle;\n\1config;/,
    replace: (m, i) =>
      `${i}titleInputProjectionHandle;\n` +
      `${i}/** Folded-title memo: the log scan stops at the first read per title revision. */\n` +
      `${i}titleMemo = /* @__PURE__ */ new WeakMap();\n` +
      `${i}config;`,
  },
  {
    label: 'memoized title read',
    mark: 'if (this.titleMemo.has(session)) return this.titleMemo.get(session);',
    find: /([ \t]*)get\(session\) \{\n\1\treturn foldSessionTitle\(session\.snapshotEvents\(\)\);\n\1\}/,
    replace: (m, i) =>
      `${i}get(session) {\n` +
      `${i}\tif (session.__coldTitle !== undefined) return session.__coldTitle;\n` +
      `${i}\tif (this.titleMemo.has(session)) return this.titleMemo.get(session);\n` +
      `${i}\tconst value = foldSessionTitle(session.snapshotEvents());\n` +
      `${i}\tthis.titleMemo.set(session, value);\n` +
      `${i}\treturn value;\n` +
      `${i}}`,
  },
  {
    label: 'invalidate title memo on session/title',
    mark: 'case "session/title": delete session.__coldTitle; this.titleMemo.delete(session); break;',
    find: /([ \t]*)switch \(event\.type\) \{\n\1\tcase "user\/message": return this\.onUserMessage\(session, event\);\n\1\tcase "request\/header":/,
    replace: (m, i) =>
      `${i}switch (event.type) {\n` +
      `${i}\tcase "session/title": delete session.__coldTitle; this.titleMemo.delete(session); break;\n` +
      `${i}\tcase "user/message": return this.onUserMessage(session, event);\n` +
      `${i}\tcase "request/header":`,
  },
  {
    label: 'fold the title from the checkpoint cut on cold windows',
    mark: 'events?.__coldWindowRef',
    find: /function foldSessionTitle\(events\) \{\n\tconst event = events\.findLast\(\(item\) => item\.type === "session\/title"\);\n\tif \(event === void 0\) return void 0;\n\treturn titleSnapshotFromState\(\{\n\t\ttitle: event\.data\.title,\n\t\tmessageSeqs: event\.data\.messageSeqs,\n\t\tsource: event\.data\.source,\n\t\teventSeq: event\.seq,\n\t\tupdatedAt: event\.time\n\t\}\);\n\}/,
    replace: () =>
      'function foldSessionTitle(events) {\n' +
      '\t// A cold window carries the folded title at its checkpoint cut; only events\n' +
      '\t// after that cut can change it. Without this shortcut every title snapshot\n' +
      '\t// (the session list reads them) folded the whole 439k-event log (~12 s).\n' +
      '\tconst ref = events?.__coldWindowRef;\n' +
      '\tif (ref !== void 0 && Number.isSafeInteger(ref.cut) && ref.cut + 1 <= events.length) {\n' +
      '\t\tlet aligned = true;\n' +
      '\t\tlet latest;\n' +
      '\t\tfor (let seq = ref.cut + 1; seq < events.length; seq++) {\n' +
      '\t\t\tconst item = events[seq];\n' +
      '\t\t\tif (item === void 0 || item.seq !== seq) {\n' +
      '\t\t\t\taligned = false;\n' +
      '\t\t\t\tbreak;\n' +
      '\t\t\t}\n' +
      '\t\t\tif (item.type === "session/title") latest = item;\n' +
      '\t\t}\n' +
      '\t\tif (aligned) {\n' +
      '\t\t\tif (latest !== void 0) return titleSnapshotFromState({\n' +
      '\t\t\t\ttitle: latest.data.title,\n' +
      '\t\t\t\tmessageSeqs: latest.data.messageSeqs,\n' +
      '\t\t\t\tsource: latest.data.source,\n' +
      '\t\t\t\teventSeq: latest.seq,\n' +
      '\t\t\t\tupdatedAt: latest.time\n' +
      '\t\t\t});\n' +
      '\t\t\tconst derived = ref.__checkpointRef?.derived?.title;\n' +
      '\t\t\tif (derived !== void 0) return derived;\n' +
      '\t\t}\n' +
      '\t}\n' +
      '\tconst event = events.findLast((item) => item.type === "session/title");\n' +
      '\tif (event === void 0) return void 0;\n' +
      '\treturn titleSnapshotFromState({\n' +
      '\t\ttitle: event.data.title,\n' +
      '\t\tmessageSeqs: event.data.messageSeqs,\n' +
      '\t\tsource: event.data.source,\n' +
      '\t\teventSeq: event.seq,\n' +
      '\t\tupdatedAt: event.time\n' +
      '\t});\n' +
      '}',
  },
]);

// ---- 9) prompt receipts: start at the restore point, not seq 0 -------------
edit('dsh-api-session-controller/lib/index.js', [
  {
    label: 'prompt receipts start at the restore point',
    mark: 'offset: session.firstLiveSeq',
    find: /([ \t]*)receipts = \{\n\1\toffset: SessionLogOffset\(0\),/,
    replace: (m, i) =>
      `${i}receipts = {\n` +
      `${i}\toffset: session.firstLiveSeq,`,
  },
]);

// ---- 10) token meter: resume from the checkpoint instead of eventAt(0..n) --
edit('dsh-token-meter/lib/index.js', [
  {
    label: 'cold-start the token meter from the checkpoint',
    mark: 'session.__coldTokenMeter',
    find: /([ \t]*)let state = this\.states\.get\(session\);\n\1if \(state === void 0\) \{\n\1\tstate = \{\n\1\t\tconsumedEvents: SessionLogOffset\(0\),\n\1\t\tsurface: \[\],\n\1\t\theader: void 0,\n\1\t\tanchorHeader: void 0,\n\1\t\tanchorNodes: \[\],\n\1\t\tpendingMeasurement: measurementProjectionDefinition\.init\(\)\n\1\t\};\n\1\tthis\.states\.set\(session, state\);\n\1\}/,
    replace: (m, i) =>
      `${i}let state = this.states.get(session);\n` +
      `${i}if (state === void 0) {\n` +
      `${i}\tconst cold = session.__coldTokenMeter;\n` +
      `${i}\tstate = {\n` +
      `${i}\t\tconsumedEvents: cold !== void 0 ? SessionLogOffset(Math.min(Number(cold.consumedEvents ?? 0), session.seq)) : SessionLogOffset(0),\n` +
      `${i}\t\tsurface: cold !== void 0 && Array.isArray(cold.surface) ? cold.surface : [],\n` +
      `${i}\t\theader: cold?.header,\n` +
      `${i}\t\tanchorHeader: cold?.anchorHeader,\n` +
      `${i}\t\tanchorNodes: cold !== void 0 && Array.isArray(cold.anchorNodes) ? cold.anchorNodes : [],\n` +
      `${i}\t\tpendingMeasurement: measurementProjectionDefinition.init()\n` +
      `${i}\t};\n` +
      `${i}\tthis.states.set(session, state);\n` +
      `${i}}`,
  },
]);

// ---- 11) message feedback: fold only past the checkpoint ------------------
// `list`/`put`/`delete` derive feedback items by streaming the canonical log
// from seq 0. On a cold Session that is a full decode of every frame (~12 s for
// 439k events), once per call. The checkpoint carries the same fold at its cut,
// so the cold path folds only the tail.
edit('dsh-message-feedback/lib/index.js', [
  {
    label: 'fold message feedback past the checkpoint cut',
    mark: '__coldFeedback = { items',
    find: /function currentItems\(sessionId, events\) \{\n\tconst items = \/\* @__PURE__ \*\/ new Map\(\);\n\tfor \(const event of events\) switch \(event\.type\) \{\n\t\tcase "feedback\/message-put":\n\t\t\tputSchema\.parse\(event\.data\);\n\t\t\tif \(event\.data\.sessionId === sessionId\) items\.set\(event\.data\.item\.messageId, event\.data\.item\);\n\t\t\tbreak;\n\t\tcase "feedback\/message-delete":\n\t\t\tdeleteSchema\.parse\(event\.data\);\n\t\t\tif \(event\.data\.sessionId === sessionId\) items\.delete\(event\.data\.messageId\);\n\t\t\tbreak;\n\t\tdefault: break;\n\t\}\n\treturn \[\.\.\.items\.values\(\)\];\n\}/,
    replace: () =>
      'function currentItems(sessionId, events) {\n' +
      '\tconst items = /* @__PURE__ */ new Map();\n' +
      '\tlet start = 0;\n' +
      '\tconst derived = events?.__cold === true ? events.__coldWindowRef?.__checkpointRef?.derived : undefined;\n' +
      '\tif (derived !== undefined && Array.isArray(derived.feedback) && Number.isSafeInteger(derived.feedbackCut) && derived.feedbackCut + 1 <= events.length) {\n' +
      '\t\tfor (const entry of derived.feedback) items.set(entry[0], entry[1]);\n' +
      '\t\tstart = derived.feedbackCut + 1;\n' +
      '\t}\n' +
      '\tfor (let index = start; index < events.length; index++) {\n' +
      '\t\tconst event = events[index];\n' +
      '\t\tswitch (event.type) {\n' +
      '\t\t\tcase "feedback/message-put":\n' +
      '\t\t\t\tputSchema.parse(event.data);\n' +
      '\t\t\t\tif (event.data.sessionId === sessionId) items.set(event.data.item.messageId, event.data.item);\n' +
      '\t\t\t\tbreak;\n' +
      '\t\t\tcase "feedback/message-delete":\n' +
      '\t\t\t\tdeleteSchema.parse(event.data);\n' +
      '\t\t\t\tif (event.data.sessionId === sessionId) items.delete(event.data.messageId);\n' +
      '\t\t\t\tbreak;\n' +
      '\t\t\tdefault: break;\n' +
      '\t\t}\n' +
      '\t}\n' +
      '\tif (events?.__cold === true && events.__coldWindowRef !== undefined) {\n' +
      '\t\t// Hand the fold to the checkpoint writer: turn/end must not decode the\n' +
      '\t\t// whole log again just to store what this call already computed.\n' +
      '\t\tevents.__coldWindowRef.__coldFeedback = { items: [...items.entries()], cut: events.length - 1 };\n' +
      '\t}\n' +
      '\treturn [...items.values()];\n' +
      '}',
  },
]);

// ---- 12) session search: incremental live observation and index ----------
// searchSessions/searchEvents reconcile by observing every live Session:
// buildSessionEventSearchDocuments() + sha256(JSON.stringify(every event)).
// A 439k-event cold Session paid ~6 GB of clones, ~25 s to rebuild the documents
// and ~20 s to rewrite 187k FTS rows ON EVERY SEARCH — searching appends its own
// tool call/result, so the event count changes between requests. Documents hold
// only extracted text and the log is append-only, so an observation extends by
// the appended events and the index appends only their rows.
edit('dsh-session-query-sqlite/lib/index.js', [
  {
    label: 'import the text extractor for incremental documents',
    mark: 'extractSessionEventText',
    // the named-import list drifts between releases (SessionSearchCursor came and
    // went); locate the import by its module and splice the extractor in.
    find: /import SessionQueryEngine, \{([^}]*)\} from "@deepseek-ai\/dsh-session-query";/,
    replace: (m, names) => `import SessionQueryEngine, {${names.replace('buildSessionEventSearchDocuments,', 'buildSessionEventSearchDocuments, extractSessionEventText,')}} from "@deepseek-ai/dsh-session-query";`,
  },
  {
    label: 'extend live observations over appended events only',
    mark: 'function extendObservation(session, cached, seq)',
    find: /function observeLive\(session\) \{\n\treturn observeSession\(session\.header, session\.inheritedEventCount, session\.snapshotEvents\(\)\);\n\}\nfunction observeSession\(header, inheritedEventCount, events\) \{\n\tconst detachedHeader = structuredClone\(header\);\n\tconst detachedEvents = events\.map\(\(event\) => structuredClone\(event\)\);\n\treturn \{\n\t\theader: detachedHeader,\n\t\tinheritedEventCount,\n\t\tdocuments: buildSessionEventSearchDocuments\(detachedHeader\.id, detachedEvents\),\n\t\tfingerprint: createHash\("sha256"\)\.update\(JSON\.stringify\(\{\n\t\t\theader: detachedHeader,\n\t\t\tinheritedEventCount,\n\t\t\tevents: detachedEvents\n\t\t\}\)\)\.digest\("base64url"\)\n\t\};\n\}/,
    replace: () => "/** Fingerprint tuple shared by full and incremental observations. */\nfunction observationFingerprint(header, inheritedEventCount, count, last) {\n\treturn createHash(\"sha256\").update(JSON.stringify({\n\t\theader,\n\t\tinheritedEventCount,\n\t\tcount,\n\t\tlastSeq: last?.seq ?? -1,\n\t\tlastHash: createHash(\"sha256\").update(JSON.stringify(last ?? null)).digest(\"base64url\")\n\t})).digest(\"base64url\");\n}\nconst liveObservations = /* @__PURE__ */ new WeakMap();\n/**\n* Extend a cached live observation over appended events. An append-only delta\n* leaves every earlier document's surface label valid, so the documents are\n* appended rather than rebuilt. A full rebuild costs a whole-log decode (~25 s\n* for 439k events) plus a full FTS rewrite (~20 s) on every search, because the\n* search's own tool call and result grow the log between requests. A replacement\n* event can re-label earlier documents, so it falls back to a full observation.\n*/\nfunction extendObservation(session, cached, seq) {\n\tconst events = session.snapshotEvents(cached.seq, seq);\n\tconst nodes = new Set(session.surface.nodes);\n\tconst observed = cached.observed;\n\tconst documents = observed.documents;\n\t// A replacement shadows earlier surface nodes. Only those documents' labels\n\t// change (current -> shadowed), so the index relabels their rows instead of\n\t// re-decoding the whole log and rewriting every row (~45 s per compaction).\n\tconst shadowed = new Set();\n\tfor (const event of events) {\n\t\tconst op = event.surfaceOp;\n\t\tif (op !== null && typeof op === \"object\" && Array.isArray(event.sourceEventSeqs)) for (const source of event.sourceEventSeqs) shadowed.add(source);\n\t}\n\tconst appended = [];\n\tfor (const event of events) {\n\t\tconst text = extractSessionEventText(event);\n\t\tif (text.length === 0) continue;\n\t\tappended.push({\n\t\t\tsessionId: observed.header.id,\n\t\t\tseq: event.seq,\n\t\t\ttype: event.type,\n\t\t\ttime: event.time,\n\t\t\tsurface: nodes.has(event.seq) ? \"current\" : shadowed.has(event.seq) ? \"shadowed\" : \"log-only\",\n\t\t\ttext\n\t\t});\n\t}\n\tfor (const document of appended) documents.push(document);\n\tconst relabel = [];\n\tfor (const source of shadowed) if (source < cached.seq) relabel.push(source);\n\tif (relabel.length > 0) observed.__relabel = [...new Set([...(observed.__relabel ?? []), ...relabel])];\n\tconst last = events.at(-1);\n\tobserved.fingerprint = observationFingerprint(observed.header, observed.inheritedEventCount, seq, last);\n\tobserved.__count = seq;\n\tobserved.__appendOnly = true;\n\tglobalThis.__coldTrace?.(`search observe extend +${appended.length} docs seq ${cached.seq}->${seq}${relabel.length > 0 ? ` relabel=${relabel.length}` : \"\"}`);\n\tcached.seq = seq;\n\treturn observed;\n}\nfunction observeLive(session) {\n\t// Searching re-observes every live Session. The log is append-only, so its\n\t// event count is an exact freshness token: the same count reuses the cached\n\t// observation and a grown one extends it by the appended events only.\n\tconst seq = session.seq;\n\tconst cached = liveObservations.get(session);\n\tif (cached !== void 0) {\n\t\tif (cached.seq === seq) return cached.observed;\n\t\tif (cached.seq < seq) try {\n\t\t\tconst extended = extendObservation(session, cached, seq);\n\t\t\tif (extended !== void 0) return extended;\n\t\t} catch {\n\t\t\t/* an unreadable delta falls back to a full observation */\n\t\t}\n\t}\n\tconst observed = observeSession(session.header, session.inheritedEventCount, session.snapshotEvents());\n\tobserved.__count = seq;\n\tglobalThis.__coldTrace?.(`search observe full ${session.header.id} seq=${seq}`);\n\tliveObservations.set(session, {\n\t\tseq,\n\t\tobserved\n\t});\n\treturn observed;\n}\nfunction observeSession(header, inheritedEventCount, events) {\n\tconst detachedHeader = structuredClone(header);\n\t// No per-event clone: documents keep only the extracted text, and Session log\n\t// events are immutable. The fingerprint hashes a cheap tuple instead of the\n\t// whole event list (which built a multi-GB JSON string per search).\n\tconst documents = buildSessionEventSearchDocuments(detachedHeader.id, events);\n\tconst last = events.at(-1);\n\treturn {\n\t\theader: detachedHeader,\n\t\tinheritedEventCount,\n\t\tdocuments,\n\t\tfingerprint: observationFingerprint(detachedHeader, inheritedEventCount, events.length, last),\n\t\t__count: events.length,\n\t\t__appendOnly: false\n\t};\n}",
  },
  {
    label: 'append only the new search documents',
    mark: 'entry.__appendOnly === true',
    find: /\t_replaceLiveSession\(entry, generation, persisted\) \{\n\t\tthis\._deleteSession\("live", entry\.header\.id\);\n\t\tconst db = this\._requireDb\(\);/,
    replace: () => "\t_replaceLiveSession(entry, generation, persisted) {\n" + "\t\tconst db = this._requireDb();\n\t\t// An append-only observation keeps every stored row below the last stored\n\t\t// seq valid, so only the appended documents are written. A full\n\t\t// delete + insert of 187k FTS rows costs ~20 s per search on a 439k-event\n\t\t// Session, and searching appends events between requests.\n\t\tif (entry.__appendOnly === true) {\n\t\t\tconst prior = db.prepare(\"SELECT id FROM temp.live_sessions WHERE id = ?\").get(entry.header.id);\n\t\t\tif (prior !== void 0) {\n\t\t\t\tconst storedMax = db.prepare(\"SELECT MAX(seq) AS m FROM temp.live_docs WHERE session_id = ?\").get(entry.header.id)?.m;\n\t\t\t\tconst from = storedMax === null || storedMax === undefined ? 0 : storedMax + 1;\n\t\t\t\tconst insert = db.prepare(`\n      INSERT INTO temp.live_docs (text, session_id, seq, type, time, surface, codepoint_length)\n      VALUES (?, ?, ?, ?, ?, ?, ?)\n    `);\n\t\t\t\tfor (const document of entry.documents) {\n\t\t\t\t\tif (document.seq < from) continue;\n\t\t\t\t\tconst text = sanitizeFtsText(document.text);\n\t\t\t\t\tinsert.run(text, document.sessionId, document.seq, document.type, document.time, document.surface, Array.from(text).length);\n\t\t\t\t}\n\t\t\t\tconst relabel = entry.__relabel;\n\t\t\t\tif (Array.isArray(relabel) && relabel.length > 0) {\n\t\t\t\t\t// A compaction shadowed earlier surface nodes: flip their stored\n\t\t\t\t\t// labels in place (one rowid scan + point updates) instead of\n\t\t\t\t\t// rebuilding the Session's whole document set.\n\t\t\t\t\tconst rowids = new Map();\n\t\t\t\t\tfor (const row of db.prepare(\"SELECT rowid, seq FROM temp.live_docs WHERE session_id = ?\").all(entry.header.id)) rowids.set(Number(row.seq), row.rowid);\n\t\t\t\t\tconst relabelRow = db.prepare(\"UPDATE temp.live_docs SET surface = 'shadowed' WHERE rowid = ?\");\n\t\t\t\t\tfor (const seq of relabel) {\n\t\t\t\t\t\tconst rowid = rowids.get(Number(seq));\n\t\t\t\t\t\tif (rowid !== void 0) relabelRow.run(rowid);\n\t\t\t\t\t}\n\t\t\t\t\tentry.__relabel = [];\n\t\t\t\t}\n\t\t\t\tdb.prepare(`\n      UPDATE temp.live_sessions\n         SET fingerprint = ?, persisted = ?, generation = ?\n       WHERE id = ?\n    `).run(entry.fingerprint, persisted ? 1 : 0, generation, entry.header.id);\n\t\t\t\treturn;\n\t\t\t}\n\t\t\t// The temp rows vanished (connection reset) while our cached documents\n\t\t\t// were released after the previous write: they only cover the delta, so\n\t\t\t// rebuild the full observation before inserting rather than storing a\n\t\t\t// partial index.\n\t\t\tconst live = this.ctx.sessions.get(entry.header.id);\n\t\t\tif (live !== void 0) entry = observeSession(live.header, live.inheritedEventCount, live.snapshotEvents());\n\t\t}\n" + "\t\tthis._deleteSession(\"live\", entry.header.id);",
  },
  {
    label: 'release the cached documents after the durable write',
    mark: 'entry.documents = [];',
    find: /\t\t\t\tdb\.exec\("COMMIT"\);/,
    replace: () =>
      '\t\t\t\tdb.exec("COMMIT");\n' +
      '\t\t\t\t// The durable rows now hold every document, so the in-memory copy is\n' +
      '\t\t\t\t// dead weight (~545 MB for a 439k-event Session). Later searches append\n' +
      '\t\t\t\t// only their new documents, and a later full rebuild makes a new array.\n' +
      '\t\t\t\tfor (const { entry } of liveReplacements) entry.documents = [];',
  },
]);

// ---- 13) session search: phase timings (diagnostics) ----------------------
// A search's wall time splits into ensure/reconcile/query; reconcile splits into
// observe/write. Anything else in the log is the model's own thinking time.
edit('dsh-session-query-sqlite/lib/index.js', [
  {
    label: 'time searchSessions phases',
    mark: 'search sessions total=',
    find: /		return this\._serialized\(signal, async \(\) => \{\n			await this\._ensureReady\(signal\);\n			const persistenceBinding = await this\._reconcile\(signal\);\n			assertNotAborted\(signal\);\n			const generation = String\(this\._globalGeneration\);\n			const fingerprint = requestFingerprint\(normalized\);\n			const offset = normalized\.cursor === void 0 \? 0 : decodeCursor\(normalized\.cursor, this\._instance, "sessions", fingerprint, generation\);\n			return page\(this\._querySessions\(normalized, offset, persistenceBinding\), normalized\.limit, \(row\) => this\._sessionHit\(row\), \(cursorOffset\) => encodeCursor\(\{\n				version: 1,\n				instance: this\._instance,\n				scope: "sessions",\n				fingerprint,\n				generation,\n				offset: cursorOffset\n			\}\), offset\);\n		\}\);\n/,
    replace: () => "\t\treturn this._serialized(signal, async () => {\n\t\t\tconst searchStarted = Date.now();\n\t\t\tawait this._ensureReady(signal);\n\t\t\tconst searchReadyAt = Date.now();\n\t\t\tconst persistenceBinding = await this._reconcile(signal);\n\t\t\tconst searchReconciledAt = Date.now();\n\t\t\tassertNotAborted(signal);\n\t\t\tconst generation = String(this._globalGeneration);\n\t\t\tconst fingerprint = requestFingerprint(normalized);\n\t\t\tconst offset = normalized.cursor === void 0 ? 0 : decodeCursor(normalized.cursor, this._instance, \"sessions\", fingerprint, generation);\n\t\t\tconst result = page(this._querySessions(normalized, offset, persistenceBinding), normalized.limit, (row) => this._sessionHit(row), (cursorOffset) => encodeCursor({\n\t\t\t\tversion: 1,\n\t\t\t\tinstance: this._instance,\n\t\t\t\tscope: \"sessions\",\n\t\t\t\tfingerprint,\n\t\t\t\tgeneration,\n\t\t\t\toffset: cursorOffset\n\t\t\t}), offset);\n\t\t\tglobalThis.__coldTrace?.(`search sessions total=${Date.now() - searchStarted}ms ensure=${searchReadyAt - searchStarted} reconcile=${searchReconciledAt - searchReadyAt} query=${Date.now() - searchReconciledAt}`);\n\t\t\treturn result;\n\t\t});\n",
  },
  {
    label: 'time searchEvents phases',
    mark: 'search events total=',
    find: /		return this\._serialized\(signal, async \(\) => \{\n			await this\._ensureReady\(signal\);\n			const persistenceBinding = await this\._reconcile\(signal\);\n			assertNotAborted\(signal\);\n			const target = this\._targetObservation\(normalized\.sessionId, persistenceBinding\);\n			const fingerprint = requestFingerprint\(normalized\);\n			const offset = normalized\.cursor === void 0 \? 0 : decodeCursor\(normalized\.cursor, this\._instance, "events", fingerprint, target\.generation\);\n			const rows = this\._queryEvents\(normalized, offset, persistenceBinding\);\n			return \{\n				session: target\.header,\n				\.\.\.page\(rows, normalized\.limit, \(row\) => this\._eventHit\(row\), \(cursorOffset\) => encodeCursor\(\{\n					version: 1,\n					instance: this\._instance,\n					scope: "events",\n					fingerprint,\n					generation: target\.generation,\n					offset: cursorOffset\n				\}\), offset\)\n			\};\n		\}\);\n/,
    replace: () => "\t\treturn this._serialized(signal, async () => {\n\t\t\tconst searchStarted = Date.now();\n\t\t\tawait this._ensureReady(signal);\n\t\t\tconst searchReadyAt = Date.now();\n\t\t\tconst persistenceBinding = await this._reconcile(signal);\n\t\t\tconst searchReconciledAt = Date.now();\n\t\t\tassertNotAborted(signal);\n\t\t\tconst target = this._targetObservation(normalized.sessionId, persistenceBinding);\n\t\t\tconst fingerprint = requestFingerprint(normalized);\n\t\t\tconst offset = normalized.cursor === void 0 ? 0 : decodeCursor(normalized.cursor, this._instance, \"events\", fingerprint, target.generation);\n\t\t\tconst rows = this._queryEvents(normalized, offset, persistenceBinding);\n\t\t\tconst result = {\n\t\t\t\tsession: target.header,\n\t\t\t\t...page(rows, normalized.limit, (row) => this._eventHit(row), (cursorOffset) => encodeCursor({\n\t\t\t\t\tversion: 1,\n\t\t\t\t\tinstance: this._instance,\n\t\t\t\t\tscope: \"events\",\n\t\t\t\t\tfingerprint,\n\t\t\t\t\tgeneration: target.generation,\n\t\t\t\t\toffset: cursorOffset\n\t\t\t\t}), offset)\n\t\t\t};\n\t\t\tglobalThis.__coldTrace?.(`search events total=${Date.now() - searchStarted}ms ensure=${searchReadyAt - searchStarted} reconcile=${searchReconciledAt - searchReadyAt} query=${Date.now() - searchReconciledAt}`);\n\t\t\treturn result;\n\t\t});\n",
  },
  {
    label: 'timestamp the reconcile observation',
    mark: 'const reconcileObservedAt = Date.now();',
    find: /\t\tconst observation = await this\._observeStable\(persistedById, signal\);/,
    replace: () => '\t\tconst observation = await this._observeStable(persistedById, signal);\n\t\tconst reconcileObservedAt = Date.now();',
  },
  {
    label: 'time the reconcile observe and write',
    mark: 'search reconcile observe=',
    find: /\t\t\}\n\t\tif \(hasWrites \|\| pointerChanged\) this\._globalGeneration \+= 1;/,
    replace: () => '\t\t}\n\t\tglobalThis.__coldTrace?.(`search reconcile observe=${reconcileObservedAt - reconcileStarted}ms write=${Date.now() - reconcileObservedAt}ms persisted=${observation.persisted.size} live=${observation.live.size} liveChanges=${liveChanges.length} persistentChanges=${persistentChanges.length}`);\n\t\tif (hasWrites || pointerChanged) this._globalGeneration += 1;',
  },
  {
    label: 'timestamp the reconcile start',
    mark: 'const reconcileStarted = Date.now();',
    find: /\tasync _reconcile\(signal\) \{\n\t\tassertNotAborted\(signal\);/,
    replace: () => '\tasync _reconcile(signal) {\n\t\tassertNotAborted(signal);\n\t\tconst reconcileStarted = Date.now();',
  },
]);

// ---- 14) session search tool: collapse duplicate event snippets -----------
// A common word matches many events whose rendered fragment is identical, so a
// ranked list turns into dozens of copies of one sentence. Group by the
// normalized snippet (highlight markers stripped), keep the best-ranked seq, and
// list the other seqs. Index speed does not fix this; result shape does.
edit('dsh-tool-session-query/lib/index.js', [
  {
    label: 'collapse identical event snippets',
    mark: 'function groupEventHits(items)',
    find: /function formatEventSearch\(sessionId, title, collected\) \{[\s\S]*?\n\}/,
    replace: () => "/**\n* Collapse hits that render the same or a near-identical snippet. A common word\n* matches many events whose displayed fragment is the same sentence with small\n* edits, so a ranked list can be dozens of copies. Exact copies are equal after\n* normalization; near copies group by shingle Jaccard similarity. The first\n* (best-ranked) seq represents each group.\n* U+FDD0/U+FDD1 are the snippet highlight markers.\n*/\nfunction snippetShingles(text) {\n\tconst normalized = String(text ?? \"\").replace(/[\\uFDD0\\uFDD1]/g, \"\").replace(/\\s+/g, \" \").trim().toLowerCase();\n\tconst shingles = /* @__PURE__ */ new Set();\n\tfor (let i = 0; i + 4 <= normalized.length; i++) shingles.add(normalized.slice(i, i + 4));\n\tif (shingles.size === 0 && normalized.length > 0) shingles.add(normalized);\n\treturn shingles;\n}\n/** Jaccard similarity of two shingle sets, in [0, 1]. */\nfunction shingleSimilarity(a, b) {\n\tif (a.size === 0 || b.size === 0) return 0;\n\tconst [small, large] = a.size <= b.size ? [a, b] : [b, a];\n\tlet shared = 0;\n\tfor (const shingle of small) if (large.has(shingle)) shared += 1;\n\tconst union = a.size + b.size - shared;\n\treturn union === 0 ? 0 : shared / union;\n}\nfunction groupEventHits(items) {\n\tconst groups = [];\n\tfor (const hit of items) {\n\t\tconst shingles = snippetShingles(hit.snippet);\n\t\tlet group;\n\t\tfor (const candidate of groups) {\n\t\t\tif (shingleSimilarity(candidate.shingles, shingles) >= 0.8) {\n\t\t\t\tgroup = candidate;\n\t\t\t\tbreak;\n\t\t\t}\n\t\t}\n\t\tif (group === void 0) {\n\t\t\tgroups.push({\n\t\t\t\thit,\n\t\t\t\tshingles,\n\t\t\t\tmore: [],\n\t\t\t\tcount: 0\n\t\t\t});\n\t\t\tcontinue;\n\t\t}\n\t\tgroup.count += 1;\n\t\tif (group.more.length < 4) group.more.push(hit.seq);\n\t}\n\treturn groups;\n}\nfunction formatEventSearch(sessionId, title, collected) {\n\tconst lines = [`Session ${sessionId} — ${workspaceAccess.titleText(title)}`];\n\tif (collected.items.length === 0) {\n\t\tlines.push(\"\", \"No prior event matches found.\");\n\t\treturn lines.join(\"\\n\");\n\t}\n\tconst groups = groupEventHits(collected.items);\n\tconst collapsed = collected.items.length - groups.length;\n\tlines.push(\"\", collapsed > 0 ? `Event search results (${groups.length} distinct; ${collapsed} duplicate or near-duplicate snippet${collapsed === 1 ? \"\" : \"s\"} collapsed):` : `Event search results (${groups.length}):`);\n\tfor (const [index, group] of groups.entries()) {\n\t\tconst { hit } = group;\n\t\tlines.push(`${index + 1}. seq ${hit.seq} | ${hit.type} | ${hit.surface} | ${formatTime(hit.time)}`, `   Snippet: ${hit.snippet}`);\n\t\tif (group.count > 0) lines.push(`   also at seq ${group.more.join(\", \")}${group.count > group.more.length ? ` … (+${group.count - group.more.length} more)` : \"\"}`);\n\t}\n\tif (collected.capped) lines.push(\"\", \"Result cap reached. Narrow the query or add filters to find additional matches.\");\n\treturn lines.join(\"\\n\");\n}",
  },
]);

// ---- 15) session search: durable live index (survives restarts) --------
// Live rows used to live in connection-local TEMP tables, so every restart
// re-decoded the whole log on the first search (~25 s) and rewrote every
// row (~11 s). The live tables are persistent now: `active` marks the rows
// observed by this process (stale cache rows stay out of every query), and
// the first observation seeds from the stored rows, processing only the
// appended events.
edit('dsh-session-query-sqlite/lib/index.js', [
  {
    label: "persistent live index: \"persisted_docs_docsize\",",
    mark: "\t\"persisted_docs_docsize\",\n\t\"persisted_docs_config\",\n\t\"live_sessions\",\n\t\"live_docs\",\n\t\"live_docs_data\",\n\t\"live_docs_idx\",\n\t\"live_docs_content\",\n\t\"live_docs_docsize\",\n\t\"live_docs_config\"\n]);\n",
    find: /	"persisted_docs_docsize",\n	"persisted_docs_config"\n\]\);\n/,
    replace: () => "\t\"persisted_docs_docsize\",\n\t\"persisted_docs_config\",\n\t\"live_sessions\",\n\t\"live_docs\",\n\t\"live_docs_data\",\n\t\"live_docs_idx\",\n\t\"live_docs_content\",\n\t\"live_docs_docsize\",\n\t\"live_docs_config\"\n]);\n",
  },
  {
    label: "persistent live index: function ensureTemporarySchema(db) {",
    mark: "function ensureTemporarySchema(db) {\n\t// Live rows are a durable cache: they survive a restart so the first search\n\t// seeds the observation from them instead of re-decoding the whole log.\n\t// `active` marks the rows observed by THIS process; cache rows from earlier\n\t// runs stay out of every query until their session is observed again.\n\tdb.exec(`\n    CREATE TABLE IF NOT EXISTS live_sessions (\n      id             TEXT PRIMARY KEY,\n",
    find: /function ensureTemporarySchema\(db\) \{\n	db\.exec\(`\n    CREATE TEMP TABLE IF NOT EXISTS live_sessions \(\n      id             TEXT PRIMARY KEY,\n/,
    replace: () => "function ensureTemporarySchema(db) {\n\t// Live rows are a durable cache: they survive a restart so the first search\n\t// seeds the observation from them instead of re-decoding the whole log.\n\t// `active` marks the rows observed by THIS process; cache rows from earlier\n\t// runs stay out of every query until their session is observed again.\n\tdb.exec(`\n    CREATE TABLE IF NOT EXISTS live_sessions (\n      id             TEXT PRIMARY KEY,\n",
  },
  {
    label: "persistent live index: persisted      INTEGER NOT NULL CHECK (persisted IN (0, 1)),",
    mark: "      persisted      INTEGER NOT NULL CHECK (persisted IN (0, 1)),\n      generation     INTEGER NOT NULL,\n      active         INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))\n    ) STRICT\n",
    find: /      persisted      INTEGER NOT NULL CHECK \(persisted IN \(0, 1\)\),\n      generation     INTEGER NOT NULL\n    \) STRICT\n/,
    replace: () => "      persisted      INTEGER NOT NULL CHECK (persisted IN (0, 1)),\n      generation     INTEGER NOT NULL,\n      active         INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))\n    ) STRICT\n",
  },
  {
    label: "persistent live index: db.exec(`",
    mark: "\tdb.exec(`\n    CREATE VIRTUAL TABLE IF NOT EXISTS live_docs USING fts5(\n      text,\n",
    find: /	db\.exec\(`\n    CREATE VIRTUAL TABLE IF NOT EXISTS temp\.live_docs USING fts5\(\n      text,\n/,
    replace: () => "\tdb.exec(`\n    CREATE VIRTUAL TABLE IF NOT EXISTS live_docs USING fts5(\n      text,\n",
  },
  {
    label: "persistent live index: )",
    mark: "    )\n  `);\n\tdb.exec(\"UPDATE live_sessions SET active = 0\");\n}\nfunction quoteIdentifier(value) {\n",
    find: /    \)\n  `\);\n\}\nfunction quoteIdentifier\(value\) \{\n/,
    replace: () => "    )\n  `);\n\tdb.exec(\"UPDATE live_sessions SET active = 0\");\n}\nfunction quoteIdentifier(value) {\n",
  },
  {
    label: "persistent live index: const persistedRows = db.prepare(\"SELECT id, revision, gener",
    mark: "\t\tconst persistedRows = db.prepare(\"SELECT id, revision, generation FROM persisted_sessions\").all();\n\t\tconst liveRows = db.prepare(\"SELECT id, fingerprint, persisted, generation FROM live_sessions WHERE active = 1\").all();\n\t\tconst persistedById = new Map(persistedRows.map((row) => [row.id, row]));\n",
    find: /		const persistedRows = db\.prepare\("SELECT id, revision, generation FROM persisted_sessions"\)\.all\(\);\n		const liveRows = db\.prepare\("SELECT id, fingerprint, persisted, generation FROM temp\.live_sessions"\)\.all\(\);\n		const persistedById = new Map\(persistedRows\.map\(\(row\) => \[row\.id, row\]\)\);\n/,
    replace: () => "\t\tconst persistedRows = db.prepare(\"SELECT id, revision, generation FROM persisted_sessions\").all();\n\t\tconst liveRows = db.prepare(\"SELECT id, fingerprint, persisted, generation FROM live_sessions WHERE active = 1\").all();\n\t\tconst persistedById = new Map(persistedRows.map((row) => [row.id, row]));\n",
  },
  {
    label: "persistent live index: if (persistentChanges.length > 0 || persistentDeletes.length",
    mark: "\t\t\t\tif (persistentChanges.length > 0 || persistentDeletes.length > 0) db.prepare(\"UPDATE search_state SET global_generation = ? WHERE singleton = 1\").run(nextMainGeneration);\n\t\t\t\tfor (const row of liveDeletes) db.prepare(\"UPDATE live_sessions SET active = 0 WHERE id = ?\").run(row.id);\n\t\t\t\tfor (const { entry, generation, persisted } of liveReplacements) this._replaceLiveSession(entry, generation, persisted);\n",
    find: /				if \(persistentChanges\.length > 0 \|\| persistentDeletes\.length > 0\) db\.prepare\("UPDATE search_state SET global_generation = \? WHERE singleton = 1"\)\.run\(nextMainGeneration\);\n				for \(const row of liveDeletes\) this\._deleteSession\("live", row\.id\);\n				for \(const \{ entry, generation, persisted \} of liveReplacements\) this\._replaceLiveSession\(entry, generation, persisted\);\n/,
    replace: () => "\t\t\t\tif (persistentChanges.length > 0 || persistentDeletes.length > 0) db.prepare(\"UPDATE search_state SET global_generation = ? WHERE singleton = 1\").run(nextMainGeneration);\n\t\t\t\tfor (const row of liveDeletes) db.prepare(\"UPDATE live_sessions SET active = 0 WHERE id = ?\").run(row.id);\n\t\t\t\tfor (const { entry, generation, persisted } of liveReplacements) this._replaceLiveSession(entry, generation, persisted);\n",
  },
  {
    label: "persistent live index: this._localGeneration = nextLocalGeneration;",
    mark: "\t\tthis._localGeneration = nextLocalGeneration;\n\t\tthis._lastPersistenceIdentity = observation.persistenceBinding.identity;\n\t\tif (observation.persistenceBinding.service !== void 0) {\n\t\t\t// A deleted Session leaves its live cache rows behind (inactive). Drop\n\t\t\t// rows whose id is neither persisted nor live so the index does not grow\n\t\t\t// with history that no longer exists. Best effort: never fail a search.\n\t\t\ttry {\n\t\t\t\tconst known = new Set([...observation.persisted.keys(), ...observation.live.keys()]);\n\t\t\t\tconst stale = db.prepare(\"SELECT id FROM live_sessions\").all().filter((row) => !known.has(row.id));\n\t\t\t\tif (stale.length > 0) {\n\t\t\t\t\tconst removeDocs = db.prepare(\"DELETE FROM live_docs WHERE session_id = ?\");\n\t\t\t\t\tconst removeSession = db.prepare(\"DELETE FROM live_sessions WHERE id = ?\");\n\t\t\t\t\tfor (const row of stale) {\n\t\t\t\t\t\tremoveDocs.run(row.id);\n\t\t\t\t\t\tremoveSession.run(row.id);\n\t\t\t\t\t}\n\t\t\t\t\tglobalThis.__coldTrace?.(`search cache pruned ${stale.length} deleted session(s)`);\n\t\t\t\t}\n\t\t\t} catch {\n\t\t\t\t/* cache pruning is best effort */\n\t\t\t}\n\t\t}\n\t\treturn observation.persistenceBinding;\n\t}\n",
    find: /		this\._localGeneration = nextLocalGeneration;\n		this\._lastPersistenceIdentity = observation\.persistenceBinding\.identity;\n		return observation\.persistenceBinding;\n	\}\n/,
    replace: () => "\t\tthis._localGeneration = nextLocalGeneration;\n\t\tthis._lastPersistenceIdentity = observation.persistenceBinding.identity;\n\t\tif (observation.persistenceBinding.service !== void 0) {\n\t\t\t// A deleted Session leaves its live cache rows behind (inactive). Drop\n\t\t\t// rows whose id is neither persisted nor live so the index does not grow\n\t\t\t// with history that no longer exists. Best effort: never fail a search.\n\t\t\ttry {\n\t\t\t\tconst known = new Set([...observation.persisted.keys(), ...observation.live.keys()]);\n\t\t\t\tconst stale = db.prepare(\"SELECT id FROM live_sessions\").all().filter((row) => !known.has(row.id));\n\t\t\t\tif (stale.length > 0) {\n\t\t\t\t\tconst removeDocs = db.prepare(\"DELETE FROM live_docs WHERE session_id = ?\");\n\t\t\t\t\tconst removeSession = db.prepare(\"DELETE FROM live_sessions WHERE id = ?\");\n\t\t\t\t\tfor (const row of stale) {\n\t\t\t\t\t\tremoveDocs.run(row.id);\n\t\t\t\t\t\tremoveSession.run(row.id);\n\t\t\t\t\t}\n\t\t\t\t\tglobalThis.__coldTrace?.(`search cache pruned ${stale.length} deleted session(s)`);\n\t\t\t\t}\n\t\t\t} catch {\n\t\t\t\t/* cache pruning is best effort */\n\t\t\t}\n\t\t}\n\t\treturn observation.persistenceBinding;\n\t}\n",
  },
  {
    label: "persistent live index: for (const session of this.ctx.sessions.list()) {",
    mark: "\t\t\tfor (const session of this.ctx.sessions.list()) {\n\t\t\t\tconst observed = observeLive(this, session);\n\t\t\t\tconst durable = persisted.get(session.id);\n",
    find: /			for \(const session of this\.ctx\.sessions\.list\(\)\) \{\n				const observed = observeLive\(session\);\n				const durable = persisted\.get\(session\.id\);\n/,
    replace: () => "\t\t\tfor (const session of this.ctx.sessions.list()) {\n\t\t\t\tconst observed = observeLive(this, session);\n\t\t\t\tconst durable = persisted.get(session.id);\n",
  },
  {
    label: "persistent live index: } else {",
    mark: "\t\t} else {\n\t\t\tdb.prepare(\"DELETE FROM live_docs WHERE session_id = ?\").run(id);\n\t\t\tdb.prepare(\"DELETE FROM live_sessions WHERE id = ?\").run(id);\n\t\t}\n",
    find: /		\} else \{\n			db\.prepare\("DELETE FROM temp\.live_docs WHERE session_id = \?"\)\.run\(id\);\n			db\.prepare\("DELETE FROM temp\.live_sessions WHERE id = \?"\)\.run\(id\);\n		\}\n/,
    replace: () => "\t\t} else {\n\t\t\tdb.prepare(\"DELETE FROM live_docs WHERE session_id = ?\").run(id);\n\t\t\tdb.prepare(\"DELETE FROM live_sessions WHERE id = ?\").run(id);\n\t\t}\n",
  },
  {
    label: "persistent live index: if (entry.__appendOnly === true) {",
    mark: "\t\tif (entry.__appendOnly === true) {\n\t\t\tconst prior = db.prepare(\"SELECT id FROM live_sessions WHERE id = ?\").get(entry.header.id);\n\t\t\tif (prior !== void 0) {\n\t\t\t\tconst storedMax = db.prepare(\"SELECT MAX(seq) AS m FROM live_docs WHERE session_id = ?\").get(entry.header.id)?.m;\n\t\t\t\tconst from = storedMax === null || storedMax === undefined ? 0 : storedMax + 1;\n\t\t\t\tconst insert = db.prepare(`\n      INSERT INTO live_docs (text, session_id, seq, type, time, surface, codepoint_length)\n      VALUES (?, ?, ?, ?, ?, ?, ?)\n",
    find: /		if \(entry\.__appendOnly === true\) \{\n			const prior = db\.prepare\("SELECT id FROM temp\.live_sessions WHERE id = \?"\)\.get\(entry\.header\.id\);\n			if \(prior !== void 0\) \{\n				const storedMax = db\.prepare\("SELECT MAX\(seq\) AS m FROM temp\.live_docs WHERE session_id = \?"\)\.get\(entry\.header\.id\)\?\.m;\n				const from = storedMax === null \|\| storedMax === undefined \? 0 : storedMax \+ 1;\n				const insert = db\.prepare\(`\n      INSERT INTO temp\.live_docs \(text, session_id, seq, type, time, surface, codepoint_length\)\n      VALUES \(\?, \?, \?, \?, \?, \?, \?\)\n/,
    replace: () => "\t\tif (entry.__appendOnly === true) {\n\t\t\tconst prior = db.prepare(\"SELECT id FROM live_sessions WHERE id = ?\").get(entry.header.id);\n\t\t\tif (prior !== void 0) {\n\t\t\t\tconst storedMax = db.prepare(\"SELECT MAX(seq) AS m FROM live_docs WHERE session_id = ?\").get(entry.header.id)?.m;\n\t\t\t\tconst from = storedMax === null || storedMax === undefined ? 0 : storedMax + 1;\n\t\t\t\tconst insert = db.prepare(`\n      INSERT INTO live_docs (text, session_id, seq, type, time, surface, codepoint_length)\n      VALUES (?, ?, ?, ?, ?, ?, ?)\n",
  },
  {
    label: "persistent live index: const rowids = new Map();",
    mark: "\t\t\t\t\tconst rowids = new Map();\n\t\t\t\t\tfor (const row of db.prepare(\"SELECT rowid, seq FROM live_docs WHERE session_id = ?\").all(entry.header.id)) rowids.set(Number(row.seq), row.rowid);\n\t\t\t\t\tconst relabelRow = db.prepare(\"UPDATE live_docs SET surface = 'shadowed' WHERE rowid = ?\");\n\t\t\t\t\tfor (const seq of relabel) {\n",
    find: /					const rowids = new Map\(\);\n					for \(const row of db\.prepare\("SELECT rowid, seq FROM temp\.live_docs WHERE session_id = \?"\)\.all\(entry\.header\.id\)\) rowids\.set\(Number\(row\.seq\), row\.rowid\);\n					const relabelRow = db\.prepare\("UPDATE temp\.live_docs SET surface = 'shadowed' WHERE rowid = \?"\);\n					for \(const seq of relabel\) \{\n/,
    replace: () => "\t\t\t\t\tconst rowids = new Map();\n\t\t\t\t\tfor (const row of db.prepare(\"SELECT rowid, seq FROM live_docs WHERE session_id = ?\").all(entry.header.id)) rowids.set(Number(row.seq), row.rowid);\n\t\t\t\t\tconst relabelRow = db.prepare(\"UPDATE live_docs SET surface = 'shadowed' WHERE rowid = ?\");\n\t\t\t\t\tfor (const seq of relabel) {\n",
  },
  {
    label: "persistent live index: db.prepare(`",
    mark: "\t\t\t\tdb.prepare(`\n      UPDATE live_sessions\n         SET fingerprint = ?, persisted = ?, generation = ?, active = 1\n       WHERE id = ?\n",
    find: /				db\.prepare\(`\n      UPDATE temp\.live_sessions\n         SET fingerprint = \?, persisted = \?, generation = \?\n       WHERE id = \?\n/,
    replace: () => "\t\t\t\tdb.prepare(`\n      UPDATE live_sessions\n         SET fingerprint = ?, persisted = ?, generation = ?, active = 1\n       WHERE id = ?\n",
  },
  {
    label: "persistent live index: db.prepare(`",
    mark: "\t\tdb.prepare(`\n      INSERT INTO live_sessions\n        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, fingerprint, persisted, generation, active)\n      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)\n    `).run(...headerBindings(entry.header, entry.inheritedEventCount), entry.fingerprint, persisted ? 1 : 0, generation);\n\t\tconst insert = db.prepare(`\n      INSERT INTO live_docs (text, session_id, seq, type, time, surface, codepoint_length)\n      VALUES (?, ?, ?, ?, ?, ?, ?)\n",
    find: /		db\.prepare\(`\n      INSERT INTO temp\.live_sessions\n        \(id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, fingerprint, persisted, generation\)\n      VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)\n    `\)\.run\(\.\.\.headerBindings\(entry\.header, entry\.inheritedEventCount\), entry\.fingerprint, persisted \? 1 : 0, generation\);\n		const insert = db\.prepare\(`\n      INSERT INTO temp\.live_docs \(text, session_id, seq, type, time, surface, codepoint_length\)\n      VALUES \(\?, \?, \?, \?, \?, \?, \?\)\n/,
    replace: () => "\t\tdb.prepare(`\n      INSERT INTO live_sessions\n        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, fingerprint, persisted, generation, active)\n      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)\n    `).run(...headerBindings(entry.header, entry.inheritedEventCount), entry.fingerprint, persisted ? 1 : 0, generation);\n\t\tconst insert = db.prepare(`\n      INSERT INTO live_docs (text, session_id, seq, type, time, surface, codepoint_length)\n      VALUES (?, ?, ?, ?, ?, ?, ?)\n",
  },
  {
    label: "persistent live index: id AS session_id, version, created_at, cwd, parent_session, ",
    mark: "        id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation\n      FROM live_sessions\n      WHERE id = ? AND active = 1`).get(sessionId);\n\t\tif (live !== void 0) return {\n",
    find: /        id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation\n      FROM temp\.live_sessions\n      WHERE id = \?`\)\.get\(sessionId\);\n		if \(live !== void 0\) return \{\n/,
    replace: () => "        id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation\n      FROM live_sessions\n      WHERE id = ? AND active = 1`).get(sessionId);\n\t\tif (live !== void 0) return {\n",
  },
  {
    label: "persistent live index: AND ? = 1",
    mark: "        AND ? = 1\n        AND NOT EXISTS (SELECT 1 FROM live_sessions AS ls WHERE ls.id = pd.session_id AND ls.active = 1)\n      UNION ALL\n",
    find: /        AND \? = 1\n        AND NOT EXISTS \(SELECT 1 FROM temp\.live_sessions AS ls WHERE ls\.id = pd\.session_id\)\n      UNION ALL\n/,
    replace: () => "        AND ? = 1\n        AND NOT EXISTS (SELECT 1 FROM live_sessions AS ls WHERE ls.id = pd.session_id AND ls.active = 1)\n      UNION ALL\n",
  },
  {
    label: "persistent live index: CAST(ld.codepoint_length AS INTEGER) AS document_length",
    mark: "        CAST(ld.codepoint_length AS INTEGER) AS document_length\n      FROM live_docs AS ld\n      JOIN live_sessions AS ls ON ls.id = ld.session_id AND ls.active = 1\n      WHERE live_docs MATCH ?\n",
    find: /        CAST\(ld\.codepoint_length AS INTEGER\) AS document_length\n      FROM temp\.live_docs AS ld\n      JOIN temp\.live_sessions AS ls ON ls\.id = ld\.session_id\n      WHERE live_docs MATCH \?\n/,
    replace: () => "        CAST(ld.codepoint_length AS INTEGER) AS document_length\n      FROM live_docs AS ld\n      JOIN live_sessions AS ls ON ls.id = ld.session_id AND ls.active = 1\n      WHERE live_docs MATCH ?\n",
  },
  {
    label: "persistent live index: }",
    mark: "}\nconst liveObservations = /* @__PURE__ */ new WeakMap();\nconst SEARCH_TOOL_ECHOES = /* @__PURE__ */ new Set([\"session_event_search\", \"session_search\"]);\n/**\n* Extend a cached live observation over appended events. An append-only delta\n",
    find: /\}\nconst liveObservations = \/\* @__PURE__ \*\/ new WeakMap\(\);\n\/\*\*\n\* Extend a cached live observation over appended events\. An append-only delta\n/,
    replace: () => "}\nconst liveObservations = /* @__PURE__ */ new WeakMap();\nconst SEARCH_TOOL_ECHOES = /* @__PURE__ */ new Set([\"session_event_search\", \"session_search\"]);\n/**\n* Extend a cached live observation over appended events. An append-only delta\n",
  },
  {
    label: "persistent live index: const appended = [];",
    mark: "\tconst appended = [];\n\t// The search tools' own calls/results are echoes; the full builder skips them\n\t// and so must the incremental path, or every new search re-indexes itself.\n\tconst searchCalls = /* @__PURE__ */ new Set();\n\tfor (const event of events) {\n\t\tif (event.type === \"tool/call\" && SEARCH_TOOL_ECHOES.has(event.data.name)) searchCalls.add(String(event.data.callId));\n\t}\n\tfor (const event of events) {\n\t\tif (event.type === \"tool/call\" && SEARCH_TOOL_ECHOES.has(event.data.name)) continue;\n\t\tif (event.type === \"tool/result\" && searchCalls.has(String(event.data.message?.toolCallId ?? event.data.toolCallId))) continue;\n\t\tconst text = extractSessionEventText(event);\n",
    find: /	const appended = \[\];\n	for \(const event of events\) \{\n		const text = extractSessionEventText\(event\);\n/,
    replace: () => "\tconst appended = [];\n\t// The search tools' own calls/results are echoes; the full builder skips them\n\t// and so must the incremental path, or every new search re-indexes itself.\n\tconst searchCalls = /* @__PURE__ */ new Set();\n\tfor (const event of events) {\n\t\tif (event.type === \"tool/call\" && SEARCH_TOOL_ECHOES.has(event.data.name)) searchCalls.add(String(event.data.callId));\n\t}\n\tfor (const event of events) {\n\t\tif (event.type === \"tool/call\" && SEARCH_TOOL_ECHOES.has(event.data.name)) continue;\n\t\tif (event.type === \"tool/result\" && searchCalls.has(String(event.data.message?.toolCallId ?? event.data.toolCallId))) continue;\n\t\tconst text = extractSessionEventText(event);\n",
  },
  {
    label: "persistent live index: }",
    mark: "}\n/**\n* Rebuild a live observation from the durable live index left by a previous\n* process: the rows below the stored max seq are already in live_docs, so the\n* observation starts with no in-memory documents and only the appended events\n* are turned into documents. Without this every restart re-decoded the whole\n* log on the first search (~25 s) and rewrote every row (~11 s).\n*/\nfunction seedLiveObservation(engine, session, seq) {\n\tconst db = engine._requireDb();\n\tlet row;\n\ttry {\n\t\trow = db.prepare(\"SELECT fingerprint, version, created_at, cwd FROM live_sessions WHERE id = ?\").get(session.header.id);\n\t} catch {\n\t\treturn void 0;\n\t}\n\tif (row === void 0) return void 0;\n\tif (row.created_at !== session.header.createdAt || row.version !== session.header.version) return void 0;\n\tif ((row.cwd ?? void 0) !== (session.header.cwd ?? void 0)) return void 0;\n\tconst storedMax = db.prepare(\"SELECT MAX(seq) AS m FROM live_docs WHERE session_id = ?\").get(session.header.id)?.m;\n\tif (storedMax === null || storedMax === void 0) return void 0;\n\tconst cachedSeq = Number(storedMax) + 1;\n\tif (!Number.isSafeInteger(cachedSeq) || cachedSeq <= 0 || cachedSeq > seq) return void 0;\n\tconst observed = {\n\t\theader: structuredClone(session.header),\n\t\tinheritedEventCount: session.inheritedEventCount,\n\t\tdocuments: [],\n\t\tfingerprint: String(row.fingerprint),\n\t\t__count: cachedSeq,\n\t\t__appendOnly: true\n\t};\n\ttry {\n\t\tdb.prepare(\"UPDATE live_sessions SET active = 1 WHERE id = ?\").run(session.header.id);\n\t\tconst extended = extendObservation(session, {\n\t\t\tseq: cachedSeq,\n\t\t\tobserved\n\t\t}, seq);\n\t\tglobalThis.__coldTrace?.(`search observe seed ${session.header.id} ${cachedSeq}->${seq}`);\n\t\treturn extended;\n\t} catch {\n\t\treturn void 0;\n\t}\n}\nfunction observeLive(engine, session) {\n\t// Searching re-observes every live Session. The log is append-only, so its\n",
    find: /\}\nfunction observeLive\(session\) \{\n	\/\/ Searching re-observes every live Session\. The log is append-only, so its\n/,
    replace: () => "}\n/**\n* Rebuild a live observation from the durable live index left by a previous\n* process: the rows below the stored max seq are already in live_docs, so the\n* observation starts with no in-memory documents and only the appended events\n* are turned into documents. Without this every restart re-decoded the whole\n* log on the first search (~25 s) and rewrote every row (~11 s).\n*/\nfunction seedLiveObservation(engine, session, seq) {\n\tconst db = engine._requireDb();\n\tlet row;\n\ttry {\n\t\trow = db.prepare(\"SELECT fingerprint, version, created_at, cwd FROM live_sessions WHERE id = ?\").get(session.header.id);\n\t} catch {\n\t\treturn void 0;\n\t}\n\tif (row === void 0) return void 0;\n\tif (row.created_at !== session.header.createdAt || row.version !== session.header.version) return void 0;\n\tif ((row.cwd ?? void 0) !== (session.header.cwd ?? void 0)) return void 0;\n\tconst storedMax = db.prepare(\"SELECT MAX(seq) AS m FROM live_docs WHERE session_id = ?\").get(session.header.id)?.m;\n\tif (storedMax === null || storedMax === void 0) return void 0;\n\tconst cachedSeq = Number(storedMax) + 1;\n\tif (!Number.isSafeInteger(cachedSeq) || cachedSeq <= 0 || cachedSeq > seq) return void 0;\n\tconst observed = {\n\t\theader: structuredClone(session.header),\n\t\tinheritedEventCount: session.inheritedEventCount,\n\t\tdocuments: [],\n\t\tfingerprint: String(row.fingerprint),\n\t\t__count: cachedSeq,\n\t\t__appendOnly: true\n\t};\n\ttry {\n\t\tdb.prepare(\"UPDATE live_sessions SET active = 1 WHERE id = ?\").run(session.header.id);\n\t\tconst extended = extendObservation(session, {\n\t\t\tseq: cachedSeq,\n\t\t\tobserved\n\t\t}, seq);\n\t\tglobalThis.__coldTrace?.(`search observe seed ${session.header.id} ${cachedSeq}->${seq}`);\n\t\treturn extended;\n\t} catch {\n\t\treturn void 0;\n\t}\n}\nfunction observeLive(engine, session) {\n\t// Searching re-observes every live Session. The log is append-only, so its\n",
  },
  {
    label: "persistent live index: /* an unreadable delta falls back to a full observation */",
    mark: "\t\t\t/* an unreadable delta falls back to a full observation */\n\t\t}\n\t}\n\tconst seeded = seedLiveObservation(engine, session, seq);\n\tif (seeded !== void 0) {\n\t\tliveObservations.set(session, {\n\t\t\tseq,\n\t\t\tobserved: seeded\n\t\t});\n\t\treturn seeded;\n\t}\n\tconst observed = observeSession(session.header, session.inheritedEventCount, session.snapshotEvents());\n",
    find: /			\/\* an unreadable delta falls back to a full observation \*\/\n		\}\n	\}\n	const observed = observeSession\(session\.header, session\.inheritedEventCount, session\.snapshotEvents\(\)\);\n/,
    replace: () => "\t\t\t/* an unreadable delta falls back to a full observation */\n\t\t}\n\t}\n\tconst seeded = seedLiveObservation(engine, session, seq);\n\tif (seeded !== void 0) {\n\t\tliveObservations.set(session, {\n\t\t\tseq,\n\t\t\tobserved: seeded\n\t\t});\n\t\treturn seeded;\n\t}\n\tconst observed = observeSession(session.header, session.inheritedEventCount, session.snapshotEvents());\n",
  },
]);

// ---- 16) session search: do not index the search tools' own echoes -------
// Every search appends a tool/call (the query) and a tool/result (the hits);
// indexing them makes each search match its previous output and add another
// block for the next one. The log keeps them; the full-text index skips them.
edit('dsh-session-query/lib/index.js', [
  {
    label: 'skip session-search tool echoes',
    mark: 'SEARCH_TOOL_ECHOES',
    find: /function buildSessionEventSearchDocuments\(sessionId, events\) \{[\s\S]*?\n\}/,
    replace: () =>
      `const SEARCH_TOOL_ECHOES = new Set(["session_event_search", "session_search"]);
function buildSessionEventSearchDocuments(sessionId, events) {
	const surfaceBySeq = classifySurface(events);
	const documents = [];
	// A call to the session-search tools and its result are echoes of earlier
	// events: indexing them makes every search match its own previous output,
	// and each search then adds another block that the next search will match.
	const searchCalls = /* @__PURE__ */ new Set();
	for (const event of events) {
		if (event.type === "tool/call" && SEARCH_TOOL_ECHOES.has(event.data.name)) {
			searchCalls.add(String(event.data.callId));
			continue;
		}
		if (event.type === "tool/result" && searchCalls.has(String(event.data.message?.toolCallId ?? event.data.toolCallId))) continue;
		const text = extractSessionEventText(event);
		if (text.length === 0) continue;
		documents.push({
			sessionId,
			seq: event.seq,
			type: event.type,
			time: event.time,
			surface: surfaceBySeq.get(event.seq) ?? "log-only",
			text
		});
	}
	return documents;
}`,
  },
]);

// ---- 17) provider timing: request start -> first chunk (diagnostics) ------
// Distinguishes local queueing from provider time-to-first-token on the first
// message after a restart or a compaction. Writes to cold-open.log.
edit('dsh-llm-deepseek/lib/index.js', [
  {
    label: 'timestamp the provider stream start',
    mark: 'const llmStarted = Date.now();',
    find: /async \*generate\(options, connection\) \{\n\t\tconst env_1 = \{/,
    replace: () => 'async *generate(options, connection) {\n\t\tconst llmStarted = Date.now();\n\t\tlet llmFirst = true;\n\t\tconst env_1 = {',
  },
  {
    label: 'time the first provider chunk',
    mark: 'llm first chunk +',
    find: /while \(true\) \{\n\t{5}const next = await watchdog\.next\(iterator\);\n\t{5}if \(next\.done\) return;\n\t{5}yield next\.value;\n\t{4}\}/,
    replace: () =>
      'while (true) {\n' +
      '\t\t\t\t\tconst next = await watchdog.next(iterator);\n' +
      '\t\t\t\t\tif (next.done) {\n' +
      '\t\t\t\t\t\tglobalThis.__coldTrace?.(`llm done +${Date.now() - llmStarted}ms`);\n' +
      '\t\t\t\t\t\treturn;\n' +
      '\t\t\t\t\t}\n' +
      '\t\t\t\t\tif (llmFirst) {\n' +
      '\t\t\t\t\t\tllmFirst = false;\n' +
      '\t\t\t\t\t\tglobalThis.__coldTrace?.(`llm first chunk +${Date.now() - llmStarted}ms`);\n' +
      '\t\t\t\t\t}\n' +
      '\t\t\t\t\tyield next.value;\n' +
      '\t\t\t\t}',
  },
  {
    label: 'time the failed provider stream',
    mark: 'llm stream failed +',
    find: /\} catch \(error\) \{\n\t\t\t\tif \(timeoutOf\(watchdog\.signal, "MESSAGES_IDLE"\) !== void 0\)/,
    replace: () =>
      '} catch (error) {\n' +
      '\t\t\t\tglobalThis.__coldTrace?.(`llm stream failed +${Date.now() - llmStarted}ms: ${String(error?.code ?? error?.message ?? error)}`);\n' +
      '\t\t\t\tif (timeoutOf(watchdog.signal, "MESSAGES_IDLE") !== void 0)',
  },
]);

// ---- 9) volatile system-prompt sections ------------------------------------
// 0.2.3 delivers a changed section as an increment while every head
// (replace/rebuild) keeps a full copy of the same section, so a large volatile
// section (the memory index, ~31K chars) is always present twice. Sections
// registered with `volatile: true` are excluded from every head and delivered as
// their own increment; a stale head (from before this patch) is rebuilt once.
const systemPromptLib = path.join(BASE, 'dsh-system-prompt/lib/index.js');
if (fs.existsSync(systemPromptLib) && fs.readFileSync(systemPromptLib, 'utf8').includes('assembleSystemAdmission(state, sections)')) {
  edit('dsh-system-prompt/lib/index.js', [
    {
      label: 'volatile flag on active sections',
      mark: 'volatile: section.volatile === true,\n\t\t\t\ttext: text.trim(),',
      find: /\t\t\t\torder: section\.order,\n\t\t\t\ttext: text\.trim\(\),/,
      replace: () => '\t\t\t\torder: section.order,\n\t\t\t\tvolatile: section.volatile === true,\n\t\t\t\ttext: text.trim(),',
    },
    {
      label: 'volatile flag on retired sections',
      mark: 'volatile: section.volatile === true,\n\t\t\t\tnotice: text.trim(),',
      find: /\t\t\t\torder: section\.order,\n\t\t\t\tnotice: text\.trim\(\),/,
      replace: () => '\t\t\t\torder: section.order,\n\t\t\t\tvolatile: section.volatile === true,\n\t\t\t\tnotice: text.trim(),',
    },
    {
      label: 'head replacement skips volatile sections',
      mark: 'if (section.volatile === true) continue;\n\t\tif (complete || section.text.length > 0) appendSection',
      find: /\t\tif \(complete \|\| section\.text\.length > 0\) appendSection\(result, section\);/,
      replace: () => '\t\tif (section.volatile === true) continue;\n\t\tif (complete || section.text.length > 0) appendSection(result, section);',
    },
    {
      label: 'rebuild skips volatile sections',
      mark: 'if (section.volatile === true) continue;\n\t\tif (complete || section.text.length > 0 || previous.has(section.name))',
      find: /\t\tif \(section\.kind === "retired"\) continue;\n\t\tif \(complete \|\| section\.text\.length > 0 \|\| previous\.has\(section\.name\)\) appendSection\(result, section\);/,
      replace: () => '\t\tif (section.kind === "retired") continue;\n\t\tif (section.volatile === true) continue;\n\t\tif (complete || section.text.length > 0 || previous.has(section.name)) appendSection(result, section);',
    },
    {
      label: 'carry the volatile flag through the presentation',
      mark: 'assembled.volatile = section.volatile;',
      find: /\t\t\tif \(section\.complete !== void 0\) assembled\.complete = section\.complete;/,
      replace: () => '\t\t\tif (section.complete !== void 0) assembled.complete = section.complete;\n\t\t\tif (section.volatile !== void 0) assembled.volatile = section.volatile;',
    },
    {
      label: 'volatile increments after a reset replacement',
      mark: 'withVolatile([replaceSystemPrompt(state, sections, eligibleSections)]',
      find: /\t\tmessages: \[replaceSystemPrompt\(state, sections, eligibleSections\)\]/,
      replace: () => '\t\tmessages: withVolatile([replaceSystemPrompt(state, sections, eligibleSections)], sections, previous)',
    },
    {
      label: 'volatile increments after a complete replacement',
      mark: 'withVolatile([replaceSystemPrompt(state, sections, updates)]',
      find: /\t\tmessages: \[replaceSystemPrompt\(state, sections, updates\)\]/,
      replace: () => '\t\tmessages: withVolatile([replaceSystemPrompt(state, sections, updates)], sections, previous)',
    },
    {
      label: 'split volatile increments out of the delta message',
      mark: 'volatilePart(updates.filter',
      find: /\tconst result = parts\(\);\n\tfor \(const section of updates\) \{\n\t\tif \(section\.kind === "retired"\) \{\n\t\t\tappendRetirement\(result, section\);\n\t\t\tcontinue;\n\t\t\}\n\t\tconst committed = previous\.get\(section\.name\);\n\t\tif \(committed === void 0 \|\| committed\.text === section\.text\) \{\n\t\t\tappendSection\(result, section\);\n\t\t\tcontinue;\n\t\t\}\n\t\tlet notice = section\.replacement;\n\t\tif \(notice === void 0\) notice = section\.text\.length === 0 \? `The earlier instructions from \$\{section\.name\} no longer apply\.` : `The following replaces the earlier instructions from \$\{section\.name\}\.`;\n\t\tappendSection\(result, section, notice\);\n\t\}\n\treturn \{\n\t\tkind: "append",\n\t\tmessages: \[createMessage\(\{\n\t\t\trole: "system",\n\t\t\tcontent: result\.content,\n\t\t\tsource: \{\n\t\t\t\tkind: "system-prompt",\n\t\t\t\tsections: result\.sections\n\t\t\t\}\n\t\t\}\)\]\n\t\};/,
      replace: () =>
        '\tconst messages = [];\n' +
        '\tconst plainUpdates = updates.filter((section) => !(section.kind === "active" && section.volatile === true));\n' +
        '\tif (plainUpdates.length > 0) {\n' +
        '\t\tconst result = parts();\n' +
        '\t\tfor (const section of plainUpdates) {\n' +
        '\t\t\tif (section.kind === "retired") {\n' +
        '\t\t\t\tappendRetirement(result, section);\n' +
        '\t\t\t\tcontinue;\n' +
        '\t\t\t}\n' +
        '\t\t\tconst committed = previous.get(section.name);\n' +
        '\t\t\tif (committed === void 0 || committed.text === section.text) {\n' +
        '\t\t\t\tappendSection(result, section);\n' +
        '\t\t\t\tcontinue;\n' +
        '\t\t\t}\n' +
        '\t\t\tlet notice = section.replacement;\n' +
        '\t\t\tif (notice === void 0) notice = section.text.length === 0 ? `The earlier instructions from ${section.name} no longer apply.` : `The following replaces the earlier instructions from ${section.name}.`;\n' +
        '\t\t\tappendSection(result, section, notice);\n' +
        '\t\t}\n' +
        '\t\tmessages.push(createMessage({\n' +
        '\t\t\trole: "system",\n' +
        '\t\t\tcontent: result.content,\n' +
        '\t\t\tsource: {\n' +
        '\t\t\t\tkind: "system-prompt",\n' +
        '\t\t\t\tsections: result.sections\n' +
        '\t\t\t}\n' +
        '\t\t}));\n' +
        '\t}\n' +
        '\tconst volatileMessage = volatilePart(updates.filter((section) => section.kind === "active" && section.volatile === true), previous);\n' +
        '\tif (volatileMessage !== void 0) messages.push(volatileMessage);\n' +
        '\treturn { kind: "append", messages };',
    },
    {
      label: 'rebuild once when the head still carries a volatile section',
      mark: 'headHasVolatile(session, sections)',
      find: /\t\tconst admission = assembleSystemAdmission\(state, sections\);\n/,
      replace: () =>
        '\t\tconst admission = assembleSystemAdmission(state, sections);\n' +
        '\t\tif (admission.kind === "append" && session !== void 0 && headHasVolatile(session, sections)) {\n' +
        '\t\t\tconst previous = new Map(state.sections.map((section) => [section.name, section]));\n' +
        '\t\t\tconst messages = [rebuildSystemPrompt(previous, sections, sections.some((section) => section.complete))];\n' +
        '\t\t\tconst extra = volatilePart(sections, previous);\n' +
        '\t\t\tif (extra !== void 0) messages.push(extra);\n' +
        '\t\t\treturn rebuildUpdates(session, messages);\n' +
        '\t\t}\n',
    },
    {
      label: 'rebuild updates carry volatile increments',
      mark: 'const messages = [admission.message];',
      find: /\t\tconst \[head, \.\.\.additions\] = session\.surface\.systemNodes;[\s\S]*?\t\treturn updates;\n\t\}/,
      replace: () =>
        '\t\tconst messages = [admission.message];\n' +
        '\t\tconst volatileMessage = volatilePart(sections, new Map(state.sections.map((section) => [section.name, section])));\n' +
        '\t\tif (volatileMessage !== void 0) messages.push(volatileMessage);\n' +
        '\t\treturn rebuildUpdates(session, messages);\n' +
        '\t}',
    },
    {
      label: 'volatile helpers',
      mark: 'function volatilePart(sections, previous)',
      find: /\n\}\n\/\/#endregion\n\/\/#region lib\/types\/projection\.js/,
      replace: () =>
        '\n}\n' +
        '/** One system message carrying the volatile sections that changed. */\n' +
        'function volatilePart(sections, previous) {\n' +
        '\tconst result = parts();\n' +
        '\tlet count = 0;\n' +
        '\tfor (const section of sections) {\n' +
        '\t\tif (section.kind === "retired") continue;\n' +
        '\t\tif (section.volatile !== true || section.text.length === 0) continue;\n' +
        '\t\tconst committed = previous.get(section.name);\n' +
        '\t\tlet notice;\n' +
        '\t\tif (committed !== void 0 && committed.text !== section.text) notice = section.replacement ?? `The following replaces the earlier instructions from ${section.name}.`;\n' +
        '\t\tappendSection(result, section, notice);\n' +
        '\t\tcount++;\n' +
        '\t}\n' +
        '\tif (count === 0) return void 0;\n' +
        '\treturn createMessage({ role: "system", content: result.content, source: { kind: "system-prompt", sections: result.sections } });\n' +
        '}\n' +
        'function withVolatile(messages, sections, previous) {\n' +
        '\tconst extra = volatilePart(sections, previous);\n' +
        '\treturn extra === void 0 ? messages : [...messages, extra];\n' +
        '}\n' +
        '/** Whether the current head still carries a section that is volatile now. */\n' +
        'function headHasVolatile(session, sections) {\n' +
        '\tconst head = session.surface.systemNodes[0];\n' +
        '\tif (head === void 0) return false;\n' +
        '\tconst message = session.deriveEventMessage(session.eventAt(head.seq));\n' +
        '\tconst names = new Set((message?.source?.sections ?? []).map((section) => section.name));\n' +
        '\treturn sections.some((section) => section.kind === "active" && section.volatile === true && names.has(section.name));\n' +
        '}\n' +
        '/** Empty the increments and install [head, ...volatile] on the surface. */\n' +
        'function rebuildUpdates(session, messages) {\n' +
        '\tconst [head, ...additions] = session.surface.systemNodes;\n' +
        '\tconst updates = [];\n' +
        '\tfor (const { seq, isEmpty } of additions) {\n' +
        '\t\tif (isEmpty) continue;\n' +
        '\t\tconst message = createMessage({ role: "system", content: [], source: { kind: "system-prompt", sections: [] } });\n' +
        '\t\tupdates.push({ message, intent: { surfaceOp: { op: "replace", startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] } });\n' +
        '\t}\n' +
        '\tconst [first, ...extra] = messages;\n' +
        '\tupdates.push({ message: first, intent: head === void 0 ? { surfaceOp: "append" } : { surfaceOp: { op: "replace", startSeq: head.seq, endSeq: head.seq }, sourceEventSeqs: [head.seq] } });\n' +
        '\tfor (const message of extra) updates.push({ message, intent: { surfaceOp: "append" } });\n' +
        '\treturn updates;\n' +
        '}\n' +
        '//#endregion\n//#region lib/types/projection.js',
    },
  ]);
} else {
  log('dsh-system-prompt/lib/index.js: no admission model in this version, skipped');
}

log('done');
