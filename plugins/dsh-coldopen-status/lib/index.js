/**
 * dsh-coldopen-status —— 在 DSH 里查看长会话的冷开状态（2026-11-14）
 *
 * 用法：在会话里输入 /coldopen
 *
 * 显示：开关、本次打开方式（冷开/全量恢复）、会话 seq / surface 节点、
 * 检查点（cut、写入原因、大小、时间、派生字段）、检查点之后的尾部长度、
 * 帧索引 sidecar、日志大小、窗口统计（建索引次数/解帧次数/读取字节/miss）。
 *
 * 只读：不写任何文件，不改会话。数据都在 $DSH_HOME 下：
 *   surface-checkpoints/<id>.json  检查点
 *   surface-checkpoints/<id>.idx   帧索引
 *   cold-open.on                   开关
 */
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "dsh-coldopen-status";
export const inject = ["commands"];

const home = () => {
  const env = process.env.DSH_HOME;
  return typeof env === "string" && env.trim() !== "" ? env.trim() : join(homedir(), ".dsh");
};
const cpDir = () => join(home(), "surface-checkpoints");
const markerPath = () => join(home(), "cold-open.on");

const fmt = (n) => Number(n).toLocaleString("en-US");
const mb = (n) => (n / 1048576).toFixed(1);

function ago(time) {
  const seconds = Math.max(0, (Date.now() - time.getTime()) / 1000);
  if (seconds < 90) return `${Math.round(seconds)} 秒前`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86400)} 天前`;
}

function statOf(file) {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function findLog(id) {
  const root = join(home(), "sessions");
  let workspaces;
  try {
    workspaces = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  for (const workspace of workspaces) {
    const dir = join(root, workspace, id);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const log = files.find((file) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(file));
    if (log !== undefined) return join(dir, log);
  }
  return undefined;
}

function report(invocation) {
  const session = invocation.agent?.session;
  if (session === undefined) {
    return { kind: "error", text: "冷开状态只能在会话里查看（当前命令没有活动会话）。" };
  }
  const id = String(session.id);
  const lines = [];
  const enabled = fs.existsSync(markerPath());
  const cold = session.log?.__cold === true;
  const stats = session.log?.stats;
  const logLength = typeof session.log?.length === "number" ? session.log.length : undefined;

  lines.push(`冷开状态 · ${id}`);
  lines.push(`开关: ${enabled ? "ON" : "OFF（${markerPath()} 不存在）"} · 本次打开: ${cold ? "冷开（惰性窗口）" : "全量恢复（普通数组）"}`);
  lines.push(
    `会话: seq ${fmt(session.seq)} · firstLive ${fmt(session.firstLiveSeq)}` +
      ` · surface ${session.surface?.nodes?.length ?? "?"} 节点` +
      (logLength === undefined ? "" : ` · log ${fmt(logLength)} 条`),
  );

  const checkpointPath = join(cpDir(), `${id}.json`);
  const checkpointStat = statOf(checkpointPath);
  const checkpoint = readJson(checkpointPath);
  if (checkpoint === undefined || checkpointStat === undefined) {
    lines.push("检查点: 无（下一轮 turn/end 会写入）");
  } else {
    const derived = checkpoint.derived === undefined ? "无" : Object.keys(checkpoint.derived).join(", ");
    lines.push(
      `检查点: cut ${fmt(checkpoint.cut)} · ${checkpoint.reason ?? "?"} · ` +
        `${(checkpointStat.size / 1024).toFixed(0)} KB · ${ago(checkpointStat.mtime)} · 派生: ${derived}`,
    );
    const tail = Number(session.seq) - 1 - Number(checkpoint.cut);
    if (tail > 1) lines.push(`  尾部: 检查点之后还有 ${fmt(tail)} 条，本次打开会折叠这部分`);
    if (tail < 0) lines.push(`  ⚠ 检查点超前日志 ${fmt(-tail)} 条：下次打开会拒绝并回退全量恢复`);
  }

  const indexStat = statOf(join(cpDir(), `${id}.idx`));
  lines.push(indexStat === undefined ? "帧索引: 无（首次远读时构建并落盘）" : `帧索引: ${mb(indexStat.size)} MB · ${ago(indexStat.mtime)}`);

  const logPath = findLog(id);
  const logStat = logPath === undefined ? undefined : statOf(logPath);
  lines.push(logStat === undefined ? "日志: 未找到" : `日志: ${mb(logStat.size)} MB · ${ago(logStat.mtime)}`);

  if (stats !== undefined) {
    lines.push(
      `窗口: 建索引 ${fmt(stats.indexBuilds ?? 0)} 次 · 解帧 ${fmt(stats.decompress ?? 0)} 次` +
        ` · 读取 ${mb(stats.bytes ?? 0)} MB · miss ${fmt(stats.misses ?? 0)}`,
    );
  }
  return { kind: "success", text: lines.join("\n") };
}

function collectStatus() {
  const dir = cpDir();
  const enabled = fs.existsSync(markerPath());
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    files = [];
  }
  const sessions = [];
  for (const file of files) {
    const id = file.slice(0, -5);
    const checkpointPath = join(dir, file);
    const checkpointStat = statOf(checkpointPath);
    const checkpoint = readJson(checkpointPath);
    const indexStat = statOf(join(dir, `${id}.idx`));
    const logPath = findLog(id);
    const logStat = logPath === undefined ? undefined : statOf(logPath);
    sessions.push({
      id,
      cut: checkpoint?.cut ?? null,
      reason: checkpoint?.reason ?? null,
      derived: checkpoint?.derived === undefined ? [] : Object.keys(checkpoint.derived),
      checkpointBytes: checkpointStat?.size ?? 0,
      checkpointMtime: checkpointStat?.mtimeMs ?? 0,
      indexBytes: indexStat?.size ?? 0,
      indexMtime: indexStat?.mtimeMs ?? 0,
      logBytes: logStat?.size ?? 0,
      logMtime: logStat?.mtimeMs ?? 0,
    });
  }
  sessions.sort((a, b) => b.logMtime - a.logMtime);
  return { enabled, marker: markerPath(), dir, sessions };
}

export function apply(ctx) {
  ctx.inject(["connection"], (child) => {
    child.connection.fetch.register({
      path: "/api/cold-open",
      methods: ["POST"],
      requestBody: "buffered",
      fetch: async () => {
        try {
          return new Response(JSON.stringify({ ok: true, value: collectStatus() }), {
            headers: { "content-type": "application/json" },
          });
        } catch (error) {
          return new Response(JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error) }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
      },
    });
  });

  ctx.commands.register({
    name: "coldopen",
    description: "查看长会话冷开状态：检查点、帧索引、窗口统计",
    handler: (invocation) => {
      try {
        return report(invocation);
      } catch (error) {
        return { kind: "error", text: `冷开状态读取失败: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });
}
