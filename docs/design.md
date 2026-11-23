# DSH 长会话「冷开」方案 · 详细文档

> 版本：2026-11-14 · 实测环境：Windows 11 / DSH 0.2.2-rc.3（Electron 44.7.0 + 内置 Node 24.21）
> 适用人群：不想换会话、又受不了 DSH 大会话越开越慢/越吃内存的用户。
> 性质：非官方补丁方案。核心依赖 DSH 内部结构，升级后需要重新对锚点。

---

## 目录

1. 问题现象与误判
2. 原理：为什么「分页」不够，必须要 checkpoint
3. 方案总览
4. 实施步骤
5. 踩坑清单（按症状 → 根因 → 修法）
6. 验证方法
7. 性能数据
8. 风险、边界与回滚
9. 文件清单
10. FAQ

---

## 1. 问题现象与误判

一条长期使用的 DSH 会话（示例：43.5 万条事件、566 MB zstd）会出现：

- 打开会话要 **134 秒**，宿主进程 RSS 涨到 **6.1 GB**；
- 之后每轮对话还会周期性卡 7–15 秒；
- 报告里有一个 **833 秒** 的 `time to first request`。

三个数里有两个是误判：

| 数字 | 真相 |
|---|---|
| 833 秒 | 「会话 adopt → 用户首个请求」的墙钟跨度，**包含大量用户空闲时间**，不是恢复耗时 |
| 7.5–15 秒/轮 | `dsh-fast` 每 60 秒 `readSurface()` 把整条会话 `structuredClone` 一遍，已用 `sampling.snapshotIntervalMs: 3600000` 消除 |
| 6.1 GB | **真的**：43.5 万条事件对象全量驻留堆内（约 14 KB/条） |

关键观察：这条会话里 **99.95% 的事件早已被 compaction 的 `surfaceOp: {op:"replace"}` 从 surface 遮蔽**。它们对 fold 已经「死了」，只剩一个用途——按 seq 回取原文（span、门牌、历史检索）。但 DSH 仍然把它们全部物化在内存里。

---

## 2. 原理：为什么「分页」不够，必须要 checkpoint

### 2.1 fold 是前缀相关的左折叠

DSH 的 surface 不是从日志里「读一页」得到的，而是从 seq 0 一路 `apply` 累加出来的：

```text
state = fold(events[0..n])
```

`SurfaceManager` 的状态（`nodes`、`projectedMessages`、replace/content generation）就是累加器。你可以在任意 seq 切一刀，但**后半段必须拿着前半段的累加器状态**才能继续。就像数据库的 WAL：不能只拿一段 WAL 重放出状态，必须先有一个 checkpoint record（redo start LSN）。

所以：

- **分页只解决「存」**：把事件从堆里挪到磁盘；
- **checkpoint 才解决「算」**：让 fold 从中间某个点开始，而不是从 0。

### 2.2 compaction 是天然的 checkpoint 边界

`dsh-compaction-basic` 每次压缩收尾都会 append 一条 `user/message`，带：

```js
surfaceOp: { op: "replace", startSeq, endSeq },
sourceEventSeqs: [compaction/start, compaction/summary, ...被遮蔽的 seq]
```

这条事件把旧 surface 节点整段替换成摘要。它自带完整的被遮蔽 seq 列表，而校验逻辑（`assertSourceEventReferences`）只做**集合成员检查**，不读前缀正文——边界是自证的。

于是可以：**在最后一个 `surfaceOp: replace` 处保存 `SurfaceManager._state`，之后只折尾部事件**。示例会话里这条边界之后只剩 197–208 条。

### 2.3 哪些东西必须活着

- 当前 surface 节点（`session.surface.nodes`，示例 91–130 个）；
- checkpoint 之后的新事件（尾部）；
- 少量被随机回读的旧事件（如 `data.headerSeq` 指向的 `request/header`、node 0 的 system message）。

其余全部可以冷存。**「哪些事件必须活着」不是靠判断，而是由 surface 自己给出的。**

---

## 3. 方案总览

三层，互相独立：

```text
┌─────────────────────────────────────────────────────────────┐
│ 写端插件 dsh-surface-checkpoint                              │
│   监听 turn/end · compaction/end · created · disposed        │
│   抓 SurfaceManager._state + 派生值（title/context/tool/token）│
│   原子写 ~/.dsh/surface-checkpoints/<id>.json（~240 KB）      │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│ runtime 补丁 apply-cold-open.cjs（9 文件 + cold-open.js）     │
│   解码：只解 header 帧 → 惰性窗口（zstd 帧）                  │
│   索引：首次远读后落盘 <id>.idx（2.7 MB）                     │
│   水合：checkpoint + 私有尾部视图 → Session                   │
│   校验：只验 cut 之后；失效一律回退全量恢复                   │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│ 状态面板 dsh-coldopen-status                                 │
│   会话内 /coldopen · 设置 → 冷开状态（只读）                  │
└─────────────────────────────────────────────────────────────┘
```

**安全设计**：冷路径任何一项校验失败（格式/身份/boundary hash/投影指纹/cut 越界）都返回 `undefined`，调用方走原来的全量恢复；冷读不到事件必须抛 `ColdWindowMiss`，**绝不返回 undefined**。

---

## 4. 实施步骤

### 4.0 前置

- 确认 DSH 版本与补丁套件匹配；先把 `~/.dsh` 和会话日志备份一份。
- 大会话必须已经发生过 compaction（有 `surfaceOp: replace`）。没压缩过的会话直接冷开收益有限。

### 4.1 安装写端插件

```text
~/.dsh/plugins/dsh-surface-checkpoint/
  package.json
  lib/index.js
```

在 profile 里以 `link:` 接入（junction），并在 `cordis.patch.yml` 添加：

```yaml
- insert:
    - id: surface-checkpoint
      name: 'dsh-surface-checkpoint'
```

### 4.2 打 runtime 补丁

```text
~/.dsh/dshgo-bridge/reapply/
  apply-cold-open.cjs     ← 14 个文件的补丁（64 个补丁段，其中 2 段按版本 optional）
  cold-open.js            ← 惰性窗口 + 校验 + 水合
```

执行：

```bat
node apply-cold-open.cjs "<DSH_INSTALL>\resources\dsh-runtime"
```

脚本会：复制 `cold-open.js`、按锚点改 14 个文件、每步 `node --check`、失败整体中止。重复执行是幂等的（检测 `mark`）。

锚点是按版本写死的：0.2.3-alpha.2 相对 0.2.2 有五处漂移（`dsh-tools/lib/types/index.js` 被移除、jsonl 与 sqlite 的导入列表变动、`readColdSessionLog` 返回对象新增 `persistedEventCount`、`Session.create` 冷路径被 `sessions.prepare` 取代），脚本已按新锚点更新；个别段标了 `optional`，新版没有该代码路径就跳过。下一代版本若再变，`edit()` 会在写任何文件前 ABORT，并打印具体文件名与补丁名。

### 4.3 打开开关并播种

```text
# 开关文件存在即启用
echo 1 > %USERPROFILE%\.dsh\cold-open.on
```

重启 DSH。**第一次打开是「播种」**：

- 首条消息仍会慢一次（token meter 等还要重放一遍）；
- 这一轮 `turn/end` 时插件把 `derived`（title / requestContext / toolHistory / tokenMeter）写进检查点；
- 帧索引在首次远读时构建并落盘。

再重启一次，之后首条消息的本地准备就只剩 1–2 秒。

### 4.4 安装状态面板（可选）

```text
~/.dsh/plugins/dsh-coldopen-status/
```

- 会话内输入 `/coldopen`：当前会话的 seq / surface / 检查点 / 索引 / 窗口统计；
- 设置 → 「冷开状态」：所有会话的检查点、索引、日志大小与时间。

---

## 5. 踩坑清单（症状 → 根因 → 修法）

这一节是本文档的核心。每一条都是实测踩出来的。

### 5.1 恢复路径

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 6 GB 在 `Session.fromRestore` 之前就分配了 | `decodeStoredLog → readZstdPrefix` 先把整条日志解成事件数组并 freeze | 在**解码处**短路：只解 header 帧，返回惰性窗口 |
| 2 | `seed must be contiguous from 0` | 构造函数 `for (const [i,e] of seed.entries())` 逐条 push，且校验 `seq === index` | 不走构造函数；`prepare`/`create` 里用 checkpoint 水合 Session |
| 3 | `cut` 落在磁盘外一条 | `fromRestore` 会在内存里追加合成的 `session/end-seed` | 抓检查点时回退尾部 `session/end-seed`；`firstLiveSeq` 等于磁盘事件数，不是 `log.length` |
| 4 | 恢复后 `firstLiveSeq` 差一 | 构造函数是在追加合成 marker **之前**记 `firstLiveSeq` 的 | 水合时用 `view.length`（含 closers）而不是 `window.totalEvents` |
| 5 | 历史加载 `events.entries is not a function` | `readZstdPrefix` 返回的是 window 本体，只带 `__coldWindow`，校验判的是 `__cold` | 给 window 也打 `__cold` |
| 6 | `events.slice is not a function` 等一堆 | 惰性 range 只实现了部分数组方法 | 补齐 `slice/entries/findLast/find/some/every/forEach/concat/reduce/indexOf/includes/toSorted` + 数字下标 Proxy（`foldSurface` 需要 `entries` + `events[seq]`） |
| 7 | 历史 follow 卡死 | `observation.events.slice(...)` 拿到的 range 没有 `slice` | 同上 |

### 5.2 共享状态

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 8 | 发消息报 `append seq mismatch ... expected N got N+1`，日志出现 seq gap | `coldLogMemo` 让读写句柄共享同一个 window；历史读把 closers `push` 进共享窗口，写句柄看到长度变长、以为回合已关闭，于是不写 closers；内存 seq 跳过、磁盘缺条 | **窗口不可变**：`makeView(tail)` 私有视图；closers 通过 `coldClosers` 显式传给 `prepare`/`create`/`hydrate` |
| 9 | 修了 #8 还差一条 | `makeView(tail)` 直接引用调用方的 `closers` 数组；水合 push marker 污染了它 → `storedCount` 多算一条 → marker 被跳过 | `const tail = [...initial]` 复制数组 |
| 10 | 检查点 cut 跑到日志末尾之外 | 持久化失败后，插件仍按**内存 seq** 写检查点 | `attachCheckpoint` 校验 cut 必须落在日志内；越界拒绝并回退全量；启动后重切检查点 |

### 5.3 全量扫描

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 11 | 打开固定慢 11 秒 | `validateStoredEvents` 对冷窗口流式扫全量 | 只校验 `seq > cut` 的尾部（前缀由同一 harness 写入，boundaryHash 已锚定 cut） |
| 12 | 第一条消息慢 13 秒 | `hasPromptRequest` 从 seq 0 扫全量重建 prompt 收据 | 初始 offset 改为 `session.firstLiveSeq` |
| 13 | 第一条消息慢 14 秒，无 stream trace | `dsh-token-meter._sync` 从 `consumedEvents=0` 逐条 `eventAt` 重放 43.5 万条，每次解一帧 zstd | 把 token meter 状态存进 `derived.tokenMeter`，从 checkpoint 续 |
| 14 | 每轮消息都慢 11 秒 | `SessionTitleService.get` 每条 `user/message` 都 `foldSessionTitle(snapshotEvents())`，且一次调用查两遍 | 按会话 memo（WeakMap），只在 `session/title` 事件出现时失效 |
| 15 | 打开后列表/写路径卡几分钟 | `SessionProjectionCache.write` / `sessionProjections.snapshot` 给 31 个投影单元**各折一遍全量** | 冷会话跳过 projcache 写；`prepare` 时用 4.5 MB 记录 `seedCells`（只推进尾部） |
| 16 | 反向扫描 O(n²) | `eventsNewestFirst` 从 `seq-1` 逐条 `eventAt`；冷窗口每次随机读都从 EOF 走帧 | 只反向遍历 `surface.nodes`（消费方最终只保留 surface 事件） |
| 17 | 远距离随机读一次几秒 | `eventAt(seq)` 对远 seq 是 O(文件) | 惰性稠密帧索引：远读 2000 帧找不到就建索引（一次 11 秒 / 2.7 MB sidecar），之后 O(1) |
| 18 | `requestHeader` 首轮 11 秒 | 正向折叠整条日志取最后一个 header | 从尾部反向扫（最后一个 header 通常就在尾部几条） |

### 5.4 日志损坏与检查点失效

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 19 | `complete frame contains a torn JSONL record` | 强杀时最后一帧写了半行 JSONL，或 seq 断裂 | 备份日志；扫描最后一个完好帧边界；截断；完整连续性校验 |
| 20 | 截断后 attach 拒绝 | 检查点 cut 超出截断后的日志 | 用**截断点之前的检查点状态**重切 cut + 重算 boundaryHash（尾部事件若 surface 中性，stateDigest 不变） |
| 21 | 插件升级后悄悄读出错 surface | 快照没带投影版本 | 检查点键 = `formatVersion + projection(stateVersion/codeHash) + inheritedEventCount`；不匹配整份重建 |
| 22 | 就地改写日志后检查点仍是「对的」 | 只校验 `asOfSeq`，不校验内容 | 键里加 `headerHash`（首帧 header）与 `boundaryHash`（cut 事件）；不一致拒绝 |
| 23 | projcache 记录被拒 | identity 含 `cwd`；迁移时改过路径 | 日志/检查点身份与 cwd 解耦，或迁移后重建记录 |
| 24 | compaction 报 `token-meter surface does not match the current session surface` | **引用共享**：`hydrateCold` 把 `checkpoint.nodes` 按引用装进 `_state.nodes`，fold 的 push/splice 改掉了检查点对象；同一进程第二次水合读到被改过的 nodes，再折一遍尾部 → 411 = 232 + 179（首次是 304 vs 296） | 装进 `_state` 时复制：`nodes: [...checkpoint.nodes]`；`hydrateCold` 另加重复 nodes 拒绝、写端不写重复。双水合验证：两次 232/unique，检查点保持 53 |

### 5.5 索引与派生值的新鲜度

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 25 | 会话用了几天后再打开，一直卡在「载入历史」，宿主 100% CPU、内存缓慢上涨 | 帧索引 sidecar 是**上次构建时**的日志快照（覆盖 seq 0..435,764），日志已长到 439,154。索引查不到 → 每次远读走 `walkBack`（最多回溯 2000 帧）。投影恢复要读 31 个单元 × 3,400 条 ≈ 10 万次读取 → 上亿次解压 | `findFrame` 在 `walkBack` **之前**先调用 `extendIndex(target)`：从已索引的最后一帧向前扫描 CHUNK（4 MB）并整块解码，补进索引后落盘；`idx.end` 记录最后一帧的结束偏移（不是文件尾，避免撕裂尾帧污染下次加载）。实测首次补齐 1,690 帧 151 ms，之后 1 ms |
| 26 | 每次重启后第一条消息又慢十几秒（俗称「要开两次」） | `session/created` 也写检查点，但该路径**不写 `derived`**，把上一次的 token meter / title / toolHistory 整块覆盖掉（583 KB → 11 KB）。水合拿不到 `derived.tokenMeter`，只能从 0 重放 | `captureCheckpoint` 在读旧检查点时判断：`reason === "created"` 且旧文件 sessionId/headerHash 一致、旧 `derived` 存在、旧 cut ≤ 当前尾 → **原样保留旧检查点**（derived 只在它那个 cut 上有效，不能搬到新 cut）。另给 token meter 加 `session.__coldTokenMeter` 兜底 |
| 27 | 打开会话后额外烧 12 秒 CPU | `dsh-message-feedback` 的 `list/put/delete` 都调用 `currentItems()`，从 seq 0 流式扫全量日志（43.9 万条 → 11.8 秒），而这条会话一条 feedback 事件都没有 | 写端把 `feedback/message-put/delete` 折成 `derived.feedback`（`[id,item]` 对）+ `feedbackCut`，每次只在上一份折的基础上推进尾部；读端 `currentItems` 检测冷窗口，从 `feedbackCut + 1` 折起。启动前可离线播种（示例：`feedback: []`） |
| 28 | 每次打开都要 3.5–11 秒「准备」 | **projcache 记录冻结**：`dsh-session-projection-cache` 对冷会话直接跳过写（怕 31 个单元各折一遍全量），于是 4.5 MB 的投影行永远停在最后一次非冷写入的 seq（示例 435,730）。每次 `prepare` 的 `seedCells` 都要从那一行回放到 439,xxx（31 × 3,400 ≈ 10 万次读取） | 冷会话分成两种：**观察视图**（`Session.create`，不播种、不写）与**活着的冷会话**（`prepare` 播种过 cells）。后者允许写：`seedCells` 成功后打 `session.__coldProjectionSeeded`，`write` 只在该标志存在且 `ctx.sessions.get(id) === session` 时走正常路径——此时每个单元都有 cell，`advanceCell` 只折尾部；5 秒/200 条节流把记录保持在尾巴附近，下次打开只需回放 ≤200 条 |
| 29 | 用一次会话搜索，宿主瞬间涨到数 GB；之后每次搜索仍要 40–60 秒 | `dsh-session-query-sqlite` 每次 `searchSessions/searchEvents` 都 `_observeStable → observeLive()`：对每个 live 会话 `events.map(structuredClone)`（43.9 万条 ≈ 6 GB）+ 全事件 `JSON.stringify` 再 sha256 + `foldSurface` 判 surface；随后 `_replaceLiveSession` 把 18.7 万行 FTS 文档整表删除重插（实测 20.4 秒）。搜索本身会追加 tool/call、tool/result，所以两次搜索之间 seq 必变，任何「按 seq 缓存」都必然失效 | 三处一起改：① `observeLive` 增量——日志只追加，delta 里没有 replace 事件时只为新增事件建文档并追加（实测 **1 ms / 40 条**），出现 replace（压缩）才整份重建；② 指纹用 `header + inheritedEventCount + count + lastSeq + lastEventHash` 元组，不再 stringify 全部事件；③ `_replaceLiveSession` 在 `entry.__appendOnly` 时只插入 `seq > MAX(seq)` 的新行并 UPDATE 会话行，不再整表删除重插。全量 vs 增量离线等价：187,296 条文档逐项相同。④ 索引从 `:memory:` 换成文件 `$DSH_HOME/storages/session-search.sqlite`：FTS 页不进宿主堆（搜索后 RSS 约 1.8 GB → 1.3 GB），且已索引的持久会话跨重启复用；live 会话的 temp 表本来就是每连接一份，重启后第一次搜索仍要重建它 |
| 30 | 搜索/会话列表刷新时仍冒出 12 秒的 `stream from=0` | `readTitleSnapshots` 直接调 `foldSessionTitle(source.events)`，绕过 title 服务的 memo/`__coldTitle`，而 `findLast` 在冷窗口上是从 seq 0 正向扫 43.9 万条 | ① `foldSessionTitle` 识别冷窗口：用 `ref.cut` 对齐校验后只扫 cut 之后的尾巴找 `session/title`，没有就返回 `derived.title`；② 根因补丁：`hydrateCold` 建的**私有 tail view 没继承 `__checkpointRef`**（引用只挂在共享窗口上），所以 `events.__coldWindowRef.__checkpointRef.derived` 取不到 → 一直走回退。加一行 `view.__checkpointRef = checkpoint` 后，标题和 message-feedback 的 `currentItems` 都能读到检查点派生值（离线验证：tail 扫描 0 ms，返回检查点里的标题） |
| 31 | 高频词的结果是一堆同一句话 | 工具 `collectPages` 每页 20 条、上限 100；高频词（示例高频词）翻 5 页、每页重跑完整排序 3.9 秒；结果里同一段 snippet 重复几十次 | ① 配置 `defaultLimit: 100`：一页取满，不再翻 5 页（工具总耗时 ~20 s → ~4 s）；② 工具层按**规范化 snippet**（去空白、去高亮标记 U+FDD0/U+FDD1、小写）分组，保留排名最高的 seq，其余以 `also at seq …` 列出——索引再快也解决不了“返回同一句话”，结果形状才解决。不改引擎、不改排序语义 |
| 32 | 压缩后第一次搜索又变成 40–45 秒 | replace 事件会重新标记旧文档的 surface（current → shadowed），增量路径无法表达“回溯改标签”，于是走整份重建：重新解日志建文档（≈25 s）+ 整表删重插（≈20 s） | 用 `event.sourceEventSeqs`（= 被这次替换遮蔽的内容）做增量：① 旧文档中 `seq < cached.seq` 且在当前 surface 里的行，按 rowid 原地把 `surface` 改成 `shadowed`（一次 rowid 扫描 ~0.3 s + 点更新）；② delta 新事件照常建文档，surface 分类用 `nodes` + 本次 shadowed 集。真实压缩验证（seq 439756，shadowed 286 / appended 113）：与全量重建 187,543 条文档**逐项相同** |
| 33 | 每次重启后的第一次搜索还是 37 秒 | live 会话的索引行在 **TEMP 表**里，per-connection，重启即失；第一次搜索只能重新解日志建文档（≈25 s）+ 整表写入（≈11 s） | `live_sessions`/`live_docs` 改为**主库持久表**，加 `active` 列：① 每次打开把 `active` 清零（旧缓存行不进任何查询）；② 第一次观察时若持久行存在且 header 匹配、`MAX(seq) < seq`，用 `MAX(seq)+1` 播种观察（内存文档为空、`__appendOnly=true`），只处理新增事件，并把该行激活；③ 追加/整份写入都保持 `active = 1`；④ 会话关闭只置 `active = 0` 保留缓存。实测：重启后首次搜索 0.75 秒（旧版 37–40 秒） |
| 34 | 高频词的结果仍是“换了几个字的同一句话”；删掉的会话索引行永远留着 | 精确去重只合并完全相同的 snippet；近义段落（同句少几个字、加个标点）仍占多条。缓存行只在会话“关闭”时置 inactive，会话被删除后行还在 | ① 工具层把去重改为 **4-char shingle + Jaccard ≥ 0.8**（先规范化：去高亮标记、折叠空白、小写）；实测同句差一字 0.938、截断 0.933、无关 0.0，100 条结果内两两比较 <50 ms。② 引擎每次 reconcile 比对 `persistence.list()` 与当前 live 集合，把两者都不包含的 `live_sessions` 行连同 `live_docs` 一起删除（`search cache pruned N deleted session(s)`），只在 persistence 可用时执行、失败不影响搜索 |
| 35 | 搜索会搜到上一次搜索的结果，结果被自己的回声淹没 | 每次搜索都会往日志里写 `tool/call`（查询词）和 `tool/result`（命中列表），两者都进全文索引——于是下次搜索命中上一次的输出，且每次搜索再给下一次加一块 | 索引层排除搜索工具自己的回声：`buildSessionEventSearchDocuments` 与增量路径 `extendObservation` 都跳过 `data.name ∈ {session_event_search, session_search}` 的 `tool/call` 及其 `toolCallId` 对应的 `tool/result`。日志本身不动（账还在），只是不进索引。补丁前已索引的旧回声行可用 `purge-search-echoes.mjs`（DSH 关闭时跑）一次性删除 |
| 36 | 升级大版本后第一次打开会话，又卡在「载入历史」，宿主 CPU 100% 持续几分钟到二十分钟 | 新版给若干投影升了 `stateVersion`（0.2.3：`contextBreakdown` 6→7、`plan` 4→5、`harnessDevLegacyPrompt` 1→2），缓存行版本不匹配 ⇒ 每个单元都从 seq 0 重放全量事件。冷窗口是懒数组，**读一条事件 = 定位并解压一个 zstd 帧**（约 2 条/帧），3 个单元 × 48 万条 ≈ 72 万次解压 | ① `cold-open.js` 的视图新增 `materialize(from,to)`：按 8 MB 块读文件，**一次 `zstdDecompressSync` 解压整块里所有拼接帧**（Node 的 sync 接口支持多帧），返回普通数组；② `dsh-session-projection` 的 `restore()` 检测到「有单元版本不匹配且 `events` 是冷窗口」时，先 materialize 再重放。实测同一会话（48 万事件、3 个单元）从 5 分半降到十几秒；重建完成后 projcache 写入新版本行，之后打开恢复 5–7 ms |
| 37 | 升级 0.2.3 后，GUI「系统提示词」每写一次记忆就多一份，3 份叠加到 28.6K token | 0.2.3 把系统提示改成「按来源增量」：非 complete 段变化时 `systemUpdates()` 返回只含变化段的 system 消息，`dsh-agent-loop` 以 `surfaceOp: "append"` 写入；旧增量不回收，只有压缩后的 rebuild 才清空。大体积易变段（35K 字符记忆索引，头部带条数/体积统计）每写一次就整份重发 ≈ +9K token | 补丁让「上一份增量」被原地顶掉：记住上次写入的 seq 与 section 名集合，下一次写入时若新消息的 section **覆盖**上一份（admission 返回的是 delta，用 delta 替换会丢掉其他段的最新文本）、且不在受保护的 node 0，就用 `surfaceOp replace` 替换而不是追加；rebuild 分支清空记录。实测存活 `system/message` 稳定在 2（head + 最新增量）；0.2.2 没有 `systemUpdates()`，该段 `optional` 自动跳过 |

---

## 6. 验证方法

### 6.1 离线等价性（最重要）

在启用前先证明「checkpoint + 尾部」与「全量折叠」逐项相等：

1. 用真实日志构造一个完整 Session（全量折叠）；
2. 折到 cut，序列化 `_state`（nodes / generations / projectedMessages）；
3. `JSON.parse` 后装进全新 SurfaceManager，只折尾部；
4. 比对 `nodes`、`replaceGeneration`、`contentGeneration`、`projectedMessages`（deep equal）。

脚本 [`tools/checkpoint-equiv.mjs`](../tools/checkpoint-equiv.mjs)，用法 `node --max-old-space-size=12288 tools/checkpoint-equiv.mjs <log> [cutSeq]`。

**本机实测（2026-11-14，本条会话）**，完整输出见 [`docs/equivalence-20261114.log`](equivalence-20261114.log)：

```
events 440,889 | frames 227,189
A 全量折叠            : 70 nodes | replGen 1099 | contentGen 1100 | projMsgs 16
checkpoint @ cut 438,500: 11,499 bytes | 204 nodes | 16 projMsgs
B 冷折尾部 2,388 条    : 0.002 s → 70 nodes | replGen 1099 | contentGen 1100 | projMsgs 16
cross-cut reads       : 1（seq 437,978 system/message，node 0 保护需要回读）
VERDICT               : EQUIVALENT
digest                : 689f0183d633464654d77efa05208b09e92ade0e600caab98625f04131a694ce
```

说明：离线脚本的投影集只挂了 `image/offload`（app 里有 31 个注册单元），它验证的是「状态序列化 → 反序列化 → 只折尾部」这条机制与全量折叠逐项相等；搜索侧的等价性是另一条独立验证（增量 vs 全量 187,543 条文档逐项相同，见 #29）。

### 6.2 冷开基准

- 全量折叠 0.15 秒；冷开 attach 6–8 ms、水合 <1 ms、帧索引加载 0 ms；
- 实测 cold open 15.5 ms / 55 MB（对照 134 秒 / 6.1 GB）。

### 6.3 日常检查

- `~/.dsh/cold-open.log`：`attach ok` / `hydrate ok` / `index loaded` / `stream from=0` 栈；
- `/coldopen`：当前会话的检查点、尾部长度、窗口统计；
- 设置 → 冷开状态：所有会话的检查点/索引/日志时间。

---

## 7. 性能数据（示例会话 43.5 万条）

| 项 | 改造前 | 改造后 |
|---|---|---|
| 常驻内存 | 6.1 GB | ~1 GB |
| 打开会话 | 134 秒 | 几秒（attach 6–8 ms） |
| 第一条消息本地准备 | ~40 秒 | 1–2 秒（播种后） |
| 第二条起 | — | 正常 |
| 远端首 token | — | ~13 秒（模型侧） |

---

## 8. 风险、边界与回滚

**风险**

- **DSH 每次更新/重装都会替换 `app.asar` 和 `resources` 下的 runtime，两份补丁（`heap/` 的 asar 补丁 + `patch/` 的 runtime 补丁）都会失效，必须重打。** 更新后 host 堆上限回到 ~4 GB，冷开也会退化为全量恢复（慢、吃内存）。重打顺序：`heap/apply-host-heap.cjs` → `heap/extract-dsh-runtime.cjs`（若 runtime 被替换）→ `patch/apply-cold-open.cjs`；锚点漂移会整体 abort，不会半打。
- 非官方补丁，依赖 `SurfaceManager._state`、`prepare`、`decodeStoredLog` 等内部结构；DSH 升级后需要重新对锚点。
- 写端插件读的是私有字段，升级后可能失效；失效时只是不写检查点，不影响会话。
- 冷窗口下 `toolHistory` 不保存 `headers`（67 MB），极端情况下「老的 developer/message 引用旧 header」会少解析一次工具增补。

**安全边界**

- 任何校验失败 → 回退全量恢复（慢但不读错）。
- 冷读 miss 必须抛错，不能返回 undefined（否则会静默跳过校验）。
- 日志被就地改写 → boundaryHash 拒绝。
- 检查点 surface 节点重复 → 水合拒绝（回退全量），写端也拒绝落盘；根因是 `_state.nodes` 引用了检查点数组，已改为复制。

**回滚**

- 立刻回退：删 `~/.dsh/cold-open.on`，重启 → 全量恢复，补丁仍在但不生效。
- 完全移除：从 profile 的 `cordis.patch.yml` 删掉插件挂载；从 reapply 套件删掉 `apply-cold-open.cjs`。

**日志修复（强杀后）**

1. 完全退出 DSH；
2. 备份日志；
3. 从后往前扫描帧，找到最后一个「以换行结尾且能解析」的帧边界；
4. 截断到该边界；
5. 跑一遍完整连续性校验（事件数、seq 0..N-1 无断裂）；
6. 重切检查点到 `<= 末尾 seq` 的合法 cut（用该 cut 的状态 + 重算 boundaryHash）。

---

## 9. 文件清单

```text
~/.dsh/plugins/dsh-surface-checkpoint/          写端插件（sidecar + derived）
~/.dsh/plugins/dsh-coldopen-status/             状态面板（/coldopen + 设置节）
~/.dsh/dshgo-bridge/reapply/apply-cold-open.cjs runtime 补丁（9 文件）
~/.dsh/dshgo-bridge/reapply/cold-open.js        惰性窗口 + 校验 + 水合
~/.dsh/cold-open.on                             开关
~/.dsh/surface-checkpoints/<id>.json            检查点（cut/state/derived）
~/.dsh/surface-checkpoints/<id>.idx             帧索引（2.7 MB）
~/.dsh/cold-open.log                            诊断日志
```

分享给别人时，至少需要：两个插件目录 + `apply-cold-open.cjs` + `cold-open.js`。注意补丁是**版本相关**的，对方 DSH 版本不同时要重新对锚点（脚本会明确 abort 并指出哪个锚点漂移）。

---

## 10. FAQ

**Q：为什么不直接换会话 / fork？**
A：很多人需要会话 id 和上下文连续（自动化任务、长期项目、手机远程）。本方案保持原会话不变。

**Q：为什么不用 buffer pool（LRU 热页）？**
A：fold 是前缀相关的，热页缓存解决不了「从 0 重放」的问题；必须先有 checkpoint。冷前缀也不需要 LRU——它几乎只在回取原文时被访问。

**Q：为什么不把日志压缩/重写得更小？**
A：就地改写会破坏 seq 连续性与所有引用；重写要全量重编号，风险远大于收益。冷存 + checkpoint 不动日志。

**Q：能不能只改插件、不改 runtime？**
A：写端和状态面板可以；读端必须改。`Session.fromRestore`/`decodeStoredLog` 是硬编码调用，没有插件缝。最小侵入是「钩子 + 新模块 + 失败回退」。

**Q：检查点会越来越大吗？**
A：不会。cut 在压缩边界或 turn 边界，`_state` 只包含当前 surface（百来个节点）；示例 10 KB（纯状态）/ 240 KB（含派生）。每轮原子覆盖写。

**Q：会影响 token 计费/上下文吗？**
A：不会。消息集合、tool 定义、request header 都从同一个 state/派生值恢复；首 token 延迟仍在模型侧。
