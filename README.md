# DSH Cold Open

Long-lived [DeepSeek Harness](https://github.com/deepseek-ai) sessions grow without bound: every event stays in memory, so a 435k-event session costs **6.1 GB RSS** and takes **134 s** to open.

This project lets the desktop host open such a session from a **checkpoint + a lazy zstd frame window** instead of decoding and materializing the whole log:

| | before | after |
|---|---|---|
| resident memory | 6.1 GB | **~1 GB** |
| open a session | 134 s | **a few seconds** |
| first message local prep (after seeding) | ~40 s | **1–2 s** |
| second message onward | — | normal |

It does **not** switch sessions, fork them, or rewrite the log. The session id and its history stay exactly where they are.

> **Also in this repository:** [`heap/`](heap/README.md) — the Windows patch that raises the desktop host's V8 heap ceiling from ~4 GB to 16 GB (an in-place, byte-for-byte edit of `/lib/main.js` inside `app.asar`). Long sessions with a large search index need it; apply it with DSH fully closed, from an external tool.

> **Every DSH update wipes this setup.** Updating or reinstalling the desktop app replaces `app.asar` and the extracted runtime, so both the heap patch (`heap/`) and the runtime patches (`patch/`) must be re-applied afterwards. The scripts are idempotent and abort on anchor drift instead of half-patching.

> **Unofficial.** Not affiliated with or endorsed by DeepSeek. The runtime patches depend on DSH internals and are **version-specific**. Modifying the client may violate the product's terms of service — use at your own risk, and back up `~/.dsh` first.

---

## How it works

Three independent layers:

1. **Writer plugin** (`plugins/dsh-surface-checkpoint`) — on `turn/end`, `compaction/end`, `session/created` and `session/disposed` it snapshots `SurfaceManager._state` plus derived values (title, request context, tool history, token meter state) and atomically writes `~/.dsh/surface-checkpoints/<id>.json` (~240 KB).
2. **Runtime patch** (`patch/apply-cold-open.cjs` + `patch/cold-open.js`) — the decode step stops after the header frame and returns a lazy window over the log's zstd frames. Session construction is hydrated from the checkpoint with a private tail view; validation only covers events after the checkpoint cut. A dense frame index is built on first far random read and persisted as `<id>.idx` (2.7 MB).
3. **Status panel** (`plugins/dsh-coldopen-status`) — `/coldopen` in a session, and **Settings → Cold Open** lists every checkpoint/index/log with sizes and ages.

Every validation failure falls back to the original full restore; a cold read that cannot be served throws instead of returning `undefined`. See [docs/design.md](docs/design.md) for the full architecture and the 24-item pitfall list.

---

## Requirements

- Windows (tested on Windows 11), DSH desktop **0.2.2-rc.3** (Electron host + bundled Node 24).
- A session that has already been compacted at least once (there must be a `surfaceOp: "replace"` boundary).
- The DSH runtime tree extracted at `resources/dsh-runtime` (the usual desktop patch setup).
- Node available for the patch script (the bundled node works).

## Install

### 1. Plugins

Copy `plugins/dsh-surface-checkpoint` and `plugins/dsh-coldopen-status` into `%USERPROFILE%\.dsh\plugins\`, then link them into the desktop profile's `node_modules` (junctions on Windows):

```bat
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-surface-checkpoint" "%USERPROFILE%\.dsh\plugins\dsh-surface-checkpoint"
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-coldopen-status" "%USERPROFILE%\.dsh\plugins\dsh-coldopen-status"
```

Add them to `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`:

```yaml
- insert:
    - id: surface-checkpoint
      name: 'dsh-surface-checkpoint'
    - id: coldopen-status
      name: 'dsh-coldopen-status'
```

### 2. Runtime patch

```bat
node patch\apply-cold-open.cjs "D:\DeepSeek Harness\resources\dsh-runtime"
```

The script copies `cold-open.js` into `@deepseek-ai/dsh-session/lib/`, patches 9 runtime files by anchors, runs `node --check` on each result, and **aborts as a whole** if an anchor drifted. It is idempotent.

### 3. Enable and seed

```bat
echo 1 > "%USERPROFILE%\.dsh\cold-open.on"
```

Restart DSH. The **first open is a seeding run**: the first message is still slow once (the token meter replays the log), but `turn/end` writes `derived` into the checkpoint and the frame index lands on disk. Restart once more — from then on the first message is fast.

### 4. Verify

- In a session: `/coldopen`
- Settings → **Cold Open**: every session's checkpoint / index / log with ages
- `%USERPROFILE%\.dsh\cold-open.log`: `attach ok`, `hydrate ok`, `index loaded`

## Rollback

Delete `%USERPROFILE%\.dsh\cold-open.on` and restart. The patches stay installed but inert; the desktop returns to the original full restore.

To remove completely: drop the two `insert` entries from `cordis.patch.yml`, remove the `node_modules` junctions, and delete `patch/apply-cold-open.cjs` from your reapply suite.

## Known limits

- **Version-specific.** Anchors target 0.2.2-rc.3. A new DSH version will make the patch abort — re-anchor against the new files.
- `toolHistory` is checkpointed without its `headers` table (67 MB in the example session); a `developer/message` in the tail that references a pre-checkpoint header may resolve fewer tool additions.
- A checkpoint written after a persistence failure can sit **ahead** of the log. `attachCheckpoint` rejects it and falls back to a full restore; the next `turn/end` re-seeds.
- In-place log rewrites invalidate checkpoints: the checkpoint key includes a header hash and a boundary-event hash, so a rewritten log is rejected rather than silently mis-read.
- A checkpoint whose surface nodes contain duplicates is rejected at hydration (full-restore fallback), and the writer refuses to persist such a state. The root cause was `_state.nodes` aliasing the checkpoint array: the fold mutated the checkpoint, so a second hydration in the same process re-applied the tail (411 = 232 + 179). Fixed by copying the array (`[...checkpoint.nodes]`).
- If the app is force-killed mid-write, the log tail can be torn or contain a sequence gap. Repair by truncating at the last complete frame and re-cutting the checkpoint to a cut at or before the new log end (see `docs/design.md` §8).
- The frame index sidecar is a snapshot of the log at build time. When the log grows, the first far read **extends it forward** from its last indexed frame (one 4 MB scan, ~150 ms) instead of falling back to a 2000-frame walk-back; a missing extension turns a projection restore into hundreds of millions of decompressions (observed as a 100% CPU "loading history" stall).
- `session/created` captures keep the previously loaded checkpoint (with its `derived` values) instead of rewriting it at a new cut. Without this, every restart dropped the token-meter state and the first message replayed the whole log — the old "open it twice" workaround.
- The persisted projection-cache record (one row per projection unit) used to freeze at the seq of its last non-cold write, so every open replayed thousands of events through every unit. The live cold Session now advances that record (5 s / 200-event throttle) while read-only observation views still never write.
- Session search (`dsh-session-query-sqlite`) observes every live session per search: it used to clone every event (~6 GB on the example session), hash a JSON string of all events, and rewrite all 187k FTS rows — ~45 s per search. Observations now extend by the appended events only (searching itself grows the log), a replacement (compaction) relabels only the shadowed rows, and the index appends only new rows. The live index is persistent (`live_sessions`/`live_docs` with an `active` flag), so the first search after a restart seeds from the stored rows instead of re-decoding the log. Results collapse duplicate and near-duplicate snippets (4-char shingles, Jaccard ≥ 0.8), cache rows for deleted sessions are pruned on the next search, and the search tools' own call/result events are kept out of the index so a search no longer matches its previous output.

## License

MIT for this repository. The patch script contains modified portions of DeepSeek's MIT-licensed `@deepseek-ai/*` packages; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
