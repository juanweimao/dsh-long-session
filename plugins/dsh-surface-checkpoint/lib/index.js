/**
 * dsh-surface-checkpoint —— surface 折叠检查点的写端（2026-11-14）
 *
 * 目的：让冷开只需要 {检查点, 尾部事件, 少量冷读}，而不是把整条日志物化成
 * 事件对象。实测（435,660 条的事件日志）：检查点 10 KB + 尾部 208 条 →
 * 与全量折叠逐项相等；冷开 15.5 ms / 55 MB / 569 KB 读取。
 *
 * 抓到的东西 = `SurfaceManager._state` 的可序列化面：
 *   nodes / replaceGeneration / contentGeneration / projectedMessages / 用过的投影类型
 * 再加身份与失效字段：
 *   formatVersion（header.version）、createdAt / cwd / isSeeded / inheritedEventCount、
 *   headerHash（首帧 header 的 JSON 指纹）、boundaryHash（cut 处事件的 JSON 指纹）
 * 这两个指纹是为了抓「日志被就地改写」——`asOfSeq` 骗不过它。
 *
 * 写入时机：session/created、turn/end、compaction/end。任何一次都是合法 cut
 * （折叠是前缀相关的，任意 seq 都能当检查点），但压缩后状态最小。
 *
 * 失败一律吞掉：检查点写不出来顶多是下次开得慢，绝不能让会话本身出错。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "dsh-surface-checkpoint";

/** 只要事件总线；sessions 用于保证加载顺序。 */
export const inject = ["sessions"];

const hash = (value) => createHash("sha256").update(value).digest("hex");

export function defaultDir() {
  const home =
    typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim() !== ""
      ? process.env.DSH_HOME.trim()
      : join(homedir(), ".dsh");
  return join(home, "surface-checkpoints");
}

/**
 * 从活着的 Session 抓一份检查点并原子落盘。
 * @param session - 宿主 Session（必须带 surfaceManager）。
 * @param reason - "created" | "turn/end" | "compaction/end"
 * @param outDir - 输出目录（默认 $DSH_HOME/surface-checkpoints）
 * @returns {{ path, doc, digest } | undefined} 会话没有可折叠状态时返回 undefined。
 */
export function captureCheckpoint(session, reason, outDir = defaultDir(), services = undefined) {
  const sm = session?.surfaceManager;
  if (sm === undefined) return undefined;

  // 强制把日志折到末尾；检查点必须对应 _lastProcessedSeq
  void sm.replaceGeneration;
  const state = sm._state;
  if (state === undefined || state.nodes.length === 0) return undefined;

  const cut = Number(sm._lastProcessedSeq ?? -1);
  if (!Number.isSafeInteger(cut) || cut < 0) return undefined;

  // Session.fromRestore appends a synthetic session/end-seed that may never reach
  // disk; log-only events are surface-neutral, so cut at the last real event.
  let boundarySeq = cut;
  while (boundarySeq >= 0 && session.log?.[boundarySeq]?.type === "session/end-seed") boundarySeq--;
  if (boundarySeq < 0) return undefined;

  const header = session.header ?? {};
  const safe = String(session.id).replace(/[^A-Za-z0-9._-]/g, "_");
  const path = join(outDir, `${safe}.json`);
  let previous;
  try {
    previous = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    previous = undefined;
  }
  // session/created fires right after hydration: the checkpoint on disk IS the
  // one that was just loaded, derived values included. Rewriting it at a new cut
  // without them is what forced the "open twice" dance (the next open had to
  // replay the token meter over the whole log). Keep the loaded cut instead.
  if (
    reason === "created" &&
    previous?.checkpointVersion === 1 &&
    String(previous.sessionId) === String(session.id) &&
    previous.headerHash === hash(JSON.stringify(header)) &&
    previous.derived !== undefined &&
    Number.isSafeInteger(previous.cut) &&
    previous.cut <= boundarySeq
  ) {
    return { path, doc: previous, digest: previous.stateDigest };
  }
  const boundary = session.log?.[boundarySeq];
  const nodes = [...state.nodes];
  // A duplicated surface means the fold re-applied a range; never persist it.
  if (new Set(nodes).size !== nodes.length) {
    globalThis.__coldTrace?.(`capture skip: duplicate nodes ${nodes.length} (unique ${new Set(nodes).size}) at cut ${String(sm._lastProcessedSeq)}`);
    return undefined;
  }
  const projectedMessages = [...state.projectedMessages.entries()].sort((a, b) => a[0] - b[0]);
  const projections = [...state.projections].map((projection) => ({
    type: projection.type,
    code: hash(String(projection.project)),
  }));

  const doc = {
    checkpointVersion: 1,
    sessionId: String(session.id),
    cut: boundarySeq,
    reason,
    formatVersion: header.version,
    identity: {
      createdAt: header.createdAt,
      cwd: header.cwd,
      isSeeded: header.isSeeded === true,
      inheritedEventCount: Number(session.inheritedEventCount ?? 0),
    },
    headerHash: hash(JSON.stringify(header)),
    boundaryHash: boundary === undefined ? null : hash(JSON.stringify(boundary)),
    replaceGeneration: state.replaceGeneration,
    contentGeneration: state.contentGeneration,
    nodes,
    projectedMessages,
    projections,
  };

  if (reason !== "created") {
    const derived = {};
    try {
      const context = session.requestContext?.();
      if (context !== undefined) derived.requestContext = context;
    } catch {
      /* optional: a cold fold would repeat work the turn already did */
    }
    try {
      session.toolHistory?.();
      const projection = session.toolHistoryProjection;
      if (projection !== undefined) {
        derived.toolHistory = {
          declared: [...projection.declared.entries()],
          active: projection.active,
          available: [...projection.available],
          ...(projection.baselineSeq === undefined ? {} : { baselineSeq: projection.baselineSeq }),
          history: projection.history,
        };
      }
    } catch {
      /* optional: the first read falls back to folding */
    }
    try {
      const title = services?.titleFor?.(session);
      if (title !== undefined) derived.title = title;
    } catch {
      /* optional: the title service keeps its own fold+memo */
    }
    try {
      const meter = services?.tokenMeter?.();
      // A cold hydration lands the restored meter here; it is at this cut and
      // must survive a capture that runs before the meter has a live state.
      const state = meter?.states?.get?.(session) ?? session.__coldTokenMeter;
      if (state !== undefined) {
        derived.tokenMeter = {
          consumedEvents: Number(state.consumedEvents ?? 0),
          surface: state.surface,
          header: state.header,
          anchorHeader: state.anchorHeader,
          anchorNodes: state.anchorNodes,
        };
      }
    } catch {
      /* optional: the meter falls back to replaying the log */
    }
    // Message feedback (thumbs) is a fold over two log-only event types.
    // dsh-message-feedback streams the canonical log from seq 0 to derive it —
    // on a cold Session that decodes every frame (~12 s per open). Keep the fold
    // in the checkpoint and advance it by the tail only.
    try {
      const items = new Map();
      let from = 0;
      const seed = previous?.derived;
      if (
        String(previous?.sessionId) === String(session.id) &&
        Array.isArray(seed?.feedback) &&
        Number.isSafeInteger(seed?.feedbackCut) &&
        seed.feedbackCut >= -1 &&
        seed.feedbackCut <= boundarySeq
      ) {
        for (const entry of seed.feedback) items.set(entry[0], entry[1]);
        from = seed.feedbackCut + 1;
      } else {
        // The reader caches its fold on the cold window; reuse it instead of
        // decoding the whole log again on the turn/end that follows a list().
        const warm = session.log?.__coldFeedback;
        if (Array.isArray(warm?.items) && Number.isSafeInteger(warm.cut) && warm.cut >= -1 && warm.cut <= boundarySeq) {
          for (const entry of warm.items) items.set(entry[0], entry[1]);
          from = warm.cut + 1;
        }
      }
      for (let seq = from; seq <= boundarySeq; seq++) {
        const event = session.log?.[seq];
        if (event === undefined || event.seq !== seq) throw new Error(`feedback fold gap at seq ${seq}`);
        if (event.type === "feedback/message-put" && event.data?.sessionId === String(session.id)) {
          items.set(event.data.item.messageId, event.data.item);
        } else if (event.type === "feedback/message-delete" && event.data?.sessionId === String(session.id)) {
          items.delete(event.data.messageId);
        }
      }
      derived.feedback = [...items.entries()];
      derived.feedbackCut = boundarySeq;
    } catch (error) {
      globalThis.__coldTrace?.(`capture feedback skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (Object.keys(derived).length > 0) doc.derived = derived;
  }

  const digest = hash(JSON.stringify({
    nodes,
    rg: state.replaceGeneration,
    cg: state.contentGeneration,
    pm: projectedMessages,
  }));
  doc.stateDigest = digest;

  mkdirSync(outDir, { recursive: true });
  const tmp = join(outDir, `.${safe}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(doc));
  renameSync(tmp, path);
  return { path, doc, digest };
}

export function apply(ctx) {
  const outDir = defaultDir();

  const services = {
    tokenMeter: () => {
      try { return ctx.get("tokenMeter"); } catch { return undefined; }
    },
    titleFor: (session) => {
      try {
        return ctx.get("sessionTitle")?.get?.(session);
      } catch {
        return undefined;
      }
    },
  };
  const capture = (session, reason) => {
    try {
      if (session?.surfaceManager === undefined) return;
      // no pre-fold dedup: _lastProcessedSeq is lazy and may lag the appended
      // event, which would skip a write the log actually advanced past
      captureCheckpoint(session, reason, outDir, services);
    } catch (error) {
      try {
        globalThis.__coldTrace?.(`capture error: ${error instanceof Error ? error.message : String(error)}`);
        ctx.logger?.warn?.(`surface-checkpoint: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        /* logging must never take the session down */
      }
    }
  };

  ctx.on("session/created", (session) => capture(session, "created"));
  ctx.on("session/event", (session, event) => {
    if (event?.type === "turn/end" || event?.type === "compaction/end") {
      capture(session, event.type);
    }
  });
  ctx.on("session/disposed", (session) => capture(session, "disposed"));
}
