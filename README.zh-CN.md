# DSH Long Session（长会话）

> 原名 `dsh-cold-open`。冷开的机制没有变，只是名字改成它解决的问题。

[English](README.md) | **简体中文**

[DeepSeek Harness](https://github.com/deepseek-ai) 的长会话会无界增长：每一条事件都常驻内存，所以一条 43.5 万事件的会话要占 **6.1 GB 常驻内存**、打开要 **134 秒**。

这个项目让桌面宿主从「**检查点 + 惰性 zstd 帧窗口**」打开这样的会话，而不是把整条日志解码、物化成对象：

| | 改造前 | 改造后 |
|---|---|---|
| 常驻内存 | 6.1 GB | **~1 GB** |
| 打开会话 | 134 秒 | **几秒** |
| 第一条消息本地准备（播种后） | ~40 秒 | **1–2 秒** |
| 第二条消息起 | — | 正常 |

它**不切会话、不 fork、不改写日志**。会话 id 和历史仍原封不动地留在原处。

> **本仓库还包含：**[`heap/`](heap/README.md) —— Windows 下把桌面 host 的 V8 堆上限从 ~4 GB 抬到 16 GB 的补丁（对 `app.asar` 里的 `/lib/main.js` 做等长原地修改）。带大搜索索引的长会话需要它；请在 DSH 完全退出后、用外部工具执行。

> **⚠️ 先决条件：操刀的必须来自 DSH 之外。** 别让跑在 DSH 里面的 AI 执行这些补丁——改造期间会话一旦重启，它连不上，也发不出一句「这里不对」。搜索到这个仓库、读文档、事后验收，在 DSH 里都没问题。

> **DSH 每次更新都会让这套失效。** 升级或重装桌面端会替换 `app.asar` 和解出来的 runtime，所以 heap 补丁（`heap/`）与 runtime 补丁（`patch/`）都要重新打。脚本是幂等的，锚点漂移会整体 abort，不会半打。

> **非官方。** 与 DeepSeek 无隶属关系、未获其背书。runtime 补丁依赖 DSH 内部结构且**与版本绑定**。修改客户端可能违反产品服务条款——自担风险，改前先备份 `~/.dsh`。

---

## 工作原理

三层，相互独立：

1. **写端插件**（`plugins/dsh-surface-checkpoint`）——在 `turn/end`、`compaction/end`、`session/created`、`session/disposed` 时快照 `SurfaceManager._state` 加派生值（title、请求上下文、工具历史、token meter 状态），原子写 `~/.dsh/surface-checkpoints/<id>.json`（约 240 KB）。
2. **runtime 补丁**（`patch/apply-cold-open.cjs` + `patch/cold-open.js`）——解码在 header 帧之后停止，返回一个覆盖日志 zstd 帧的惰性窗口。Session 构造用检查点加私有尾部视图水合；校验只覆盖 cut 之后的事件。首次远距离随机读时构建稠密帧索引并落盘为 `<id>.idx`（2.7 MB）。
3. **状态面板**（`plugins/dsh-coldopen-status`）——会话内输入 `/coldopen`；**设置 → 冷开状态** 列出每个会话的检查点/索引/日志及大小与时间。

任何一项校验失败都会回退到原来的全量恢复；冷读不到事件必须抛错，而不是返回 `undefined`。完整架构和 35 条踩坑清单见 [docs/design.md](docs/design.md)。

---

## 环境要求

- Windows（在 Windows 11 实测），DSH 桌面版 **0.2.2-rc.3 – 0.2.3-alpha.2**（Electron 宿主 + 内置 Node 24）。补丁套件已在 **0.2.2-rc.5** 和 **0.2.3-alpha.2** 上实测；跨版本锚点可能漂移，脚本遇到不匹配会直接 ABORT，不会瞎改。
- 会话至少已经被压缩过一次（必须存在一个 `surfaceOp: "replace"` 边界）。
- DSH runtime 已解到 `resources/dsh-runtime`（常见的桌面补丁布局）。
- 跑补丁脚本需要 Node（用内置的 node 即可）。

## 安装

### 1. 插件

把 `plugins/dsh-surface-checkpoint` 和 `plugins/dsh-coldopen-status` 复制到 `%USERPROFILE%\.dsh\plugins\`，再用 junction（Windows 目录联接）链进桌面 profile 的 `node_modules`：

```bat
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-surface-checkpoint" "%USERPROFILE%\.dsh\plugins\dsh-surface-checkpoint"
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-coldopen-status" "%USERPROFILE%\.dsh\plugins\dsh-coldopen-status"
```

把它们加进 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`：

```yaml
- insert:
    - id: surface-checkpoint
      name: 'dsh-surface-checkpoint'
    - id: coldopen-status
      name: 'dsh-coldopen-status'
```

### 2. runtime 补丁

```bat
node patch\apply-cold-open.cjs "D:\DeepSeek Harness\resources\dsh-runtime"
```

脚本会把 `cold-open.js` 复制进 `@deepseek-ai/dsh-session/lib/`，按锚点修改 13 个 runtime 文件，对每个结果跑 `node --check`，任何锚点漂移就**整体中止**。可重复执行（幂等）。

### 3. 打开开关并播种

```bat
echo 1 > "%USERPROFILE%\.dsh\cold-open.on"
```

重启 DSH。**第一次打开是“播种”运行**：第一条消息仍会慢一次（token meter 要重放日志），但 `turn/end` 时会把 `derived` 写进检查点、帧索引也会落盘。再重启一次——之后第一条消息就快了。

### 4. 验证

- 会话内输入：`/coldopen`
- 设置 → **冷开状态**：每个会话的检查点 / 索引 / 日志及时间
- `%USERPROFILE%\.dsh\cold-open.log`：`attach ok`、`hydrate ok`、`index loaded`

## 回滚

删掉 `%USERPROFILE%\.dsh\cold-open.on` 再重启。补丁仍在但不生效，桌面端回到原来的全量恢复。

要完全移除：从 `cordis.patch.yml` 去掉那两条 `insert`，删除 `node_modules` 里的 junction，并从你的 reapply 套件里删掉 `patch/apply-cold-open.cjs`。

## 已知限制

- **与版本绑定。** 锚点针对 0.2.2-rc.3。DSH 新版本会让补丁 abort——需要按新文件重新对锚点。
- `toolHistory` 检查点**不保存 `headers` 表**（示例会话里 67 MB）；尾部若有 `developer/message` 引用了检查点之前的 header，可能少解析出一些工具增补。
- 持久化失败后写入的检查点可能**超前**日志。`attachCheckpoint` 会拒绝并回退全量恢复；下一次 `turn/end` 会重新播种。
- 就地改写日志会让检查点失效：检查点键包含首帧 header 指纹和边界事件指纹，被改写的日志会被拒绝，而不是静默读错。
- 检查点的 surface 节点若有重复，会在水合时被拒绝（回退全量），写端也拒绝落盘。根因是 `_state.nodes` 引用了检查点数组：fold 改掉了它，同一进程第二次水合又折了一遍尾部（411 = 232 + 179）。改为复制数组（`[...checkpoint.nodes]`）后修复。
- 强杀 App 可能写坏日志尾部（半截行或 seq 断裂）。修复方法：截断到最后一个完整帧，并把检查点重切到不超过新日志末尾的 cut（见 `docs/design.md` §8）。
- 帧索引 sidecar 是构建时的日志快照。日志增长后，第一次远读会从最后一个已索引帧**向前延伸**（一次 4 MB 扫描，约 150 ms），而不是回退到 2000 帧的 walk-back；缺少延伸会把一次投影恢复变成上亿次解压（表现为 100% CPU 卡在“载入历史”）。
- `session/created` 抓检查点时会**保留**之前加载的检查点（含其 `derived` 值），而不是在新 cut 下重写它。没有这一点，每次重启都会丢掉 token meter 状态、第一条消息重放整条日志——也就是旧版的“要开两次”。
- 持久化投影缓存记录（每个投影单元一行）过去会冻结在最后一次非冷写入的 seq，于是每次打开都要让每个单元回放数千条事件。现在活着的冷会话会推进这条记录（5 秒 / 200 条节流），只读观察视图仍然不写。
- 会话搜索（`dsh-session-query-sqlite`）每次搜索都会观察所有 live 会话：过去逐条克隆所有事件（示例会话约 6 GB）、对所有事件做 JSON 序列化再哈希、并重写全部 18.7 万行 FTS——每次搜索约 45 秒。现在观察只为新增事件扩展（搜索本身会让日志增长），压缩（replace）只重标被遮蔽的行，索引只追加新行。live 索引是持久的（`live_sessions`/`live_docs` 带 `active` 标记），所以重启后第一次搜索会从已存行播种，而不是重新解码日志。结果会合并完全重复与近似重复的 snippet（4-char shingle，Jaccard ≥ 0.8），已删除会话的缓存行会在下次搜索时清理，搜索工具自己的 call/result 事件不再进索引，因此搜索不会再命中上一次搜索的输出。

## 许可证

本仓库 MIT。补丁脚本包含 DeepSeek 以 MIT 许可的 `@deepseek-ai/*` 包的修改片段；见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
