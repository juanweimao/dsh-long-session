# DSH 桌面版 host 堆上限补丁（4 GB → 16 GB）

> **强烈建议打上这个补丁**：不打的话，大会话/大索引仍会在 ~4 GB 处 OOM。
>
> **但请交给外部工具（另一个 AI 或命令行）在 DSH 完全退出后执行，不要让 DSH 自己改自己的 `app.asar`。**
> 运行中的进程会占用文件；即使写进去，对当前进程也不生效；中途出错还可能留下坏档。改前脚本会自动备份。

> **非官方补丁。** 仅 Windows。与 DSH 版本相关：`/lib/main.js` 的锚点变了会**拒绝执行**，不会半改。
> 修改客户端可能违反产品服务条款，自担风险；脚本会先备份 `app.asar`。

## 症状

大会话、大索引或长时间运行时，宿主进程（任务管理器里命令行带 `dsh-desktop-host` 的那个 `node.exe`）在 **~4 GB** 附近被 V8 拒绝分配（`JavaScript heap out of memory`）或被系统杀掉。

DSH 的 host 是 Electron 主进程从 `app.asar` 的 `/lib/main.js` 里启动的独立 node 进程，启动参数只有 `--expose-internals`，没有 `--max-old-space-size`，于是 V8 按系统内存推导 old-space 上限，落在 4 GB 量级。

## 补丁做什么

不重新打包 asar。按 asar 头定位 `/lib/main.js` 的 `offset/size`，做**等长原地修改**（文件字节数完全不变，后面所有成员的偏移仍然有效），并把头部里的 sha256（`hash` + `blocks[0]`）替换成新值。

三处编辑（DSH 0.2.2 的 `main.js`）：

| # | 原片段 | 改成 | 作用 |
|---|---|---|---|
| 1 | `node: process.execPath,` | `node: join(process.resourcesPath, "runtime", "primary-runtime", "dependencies", "node", "bin", "node.exe"),` | 用自带的 node，而不是 Electron 的 |
| 2 | `"--expose-internals",` | `"--max-old-space-size=16384",` + 原行 | 抬高 V8 堆上限 |
| 3 | `join(app.getAppPath(), "dsh")` | `join(process.resourcesPath, "dsh-runtime")` | host 从解出来的目录加载运行时 |

插入多出来的字节，从一段**纯 ASCII 的 JSDoc 注释**里等量截掉（注释是惰性的），保证长度不变。脚本会：

- 断言每个锚点**恰好出现一次**，否则 abort（布局变了就停下，不猜）；
- 对改后的 `main.js` 跑 `node --check`；
- 断言改后与原始**字节数相同**；
- 备份 `app.asar.bak-<时间戳>`，写入后回读校验 sha256。

## 为什么还要解 dsh-runtime

补丁第 1 条让 host 用自带的 `node.exe`，它**不能读 asar 虚拟文件系统**，所以 asar 里的 `/dsh` 子树必须解成真实目录。`extract-dsh-runtime.cjs` 做这件事，并按 asar 头里的 integrity 校验每个文件。

## 用法

以下命令都在本目录（`heap/`）内执行。需要管理员权限（要写安装目录）。

```bat
node apply-host-heap.cjs --dry-run
node apply-host-heap.cjs
node extract-dsh-runtime.cjs
```

解出来的目录默认是 `<resources>\dsh-runtime`；补丁第 3 条写的也是 `dsh-runtime`。如果你解到别的名字，两边要一致：

```bat
node apply-host-heap.cjs --runtime-name dsh-node
node extract-dsh-runtime.cjs --out "D:\DeepSeek Harness\resources\dsh-node"
```

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--asar PATH` | `D:/DeepSeek Harness/resources/app.asar` | 安装目录不同就显式给 |
| `--heap-mb N` | `16384` | 堆上限（MB），改这个会改变插入的字节数，脚本会自动重新配平 |
| `--runtime-name NAME` | `dsh-runtime` | 第 3 条编辑写入的目录名 |
| `--dry-run` | — | 只打印要写入的 offset / 新旧 hash，不写盘 |
| `--force`（extractor） | — | 覆盖已存在的输出目录 |
| `--out PATH`（extractor） | `<resources>\dsh-runtime` | 解出位置 |

## 验证

1. 完全退出 DSH，再启动。
2. 确认 host 命令行里有堆参数：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dsh-desktop-host*' } |
  Select-Object ProcessId, CommandLine
```

应看到 `--max-old-space-size=16384`。

3. 宿主 RSS 可以超过 4 GB（此前会在 4 GB 附近 OOM）。

## 回滚

1. 完全退出 DSH；
2. 把 `app.asar.bak-<时间戳>` 覆盖回 `app.asar`；
3. 如果 `resources\dsh-runtime` 是这次解出来的，删掉它；
4. 启动 DSH。

## 边界与风险

- **仅 Windows**，路径按默认安装目录写死，可用 `--asar` 覆盖。
- **与版本相关**：DSH 更新会替换 `app.asar` 和 runtime，需要重跑；锚点漂移会 abort，不会留下半打状态。
- 堆上限不是无限：16 GB 只是抬高天花板，真实可用受物理内存和系统提交限制；设得过大可能把 OOM 变成整机卡顿。
- 只影响 host node 进程，不影响 Electron 主进程 / renderer / GPU 的堆。
- 如果 DSH 本身启用了 asar 完整性校验，本脚本同时替换了头部 hash，通常仍然可用；若未来校验机制变化，需要重新适配。

## 给 AI 的说明（整段复制给 AI 即可）

> 这是 DSH 桌面版的 host 堆上限补丁（asar 内 `/lib/main.js` 等长修改）。
> **执行前先让用户完全退出 DSH（包括托盘和后台 node 进程），由你（外部 AI）来改，不要让 DSH 自己改自己的 asar。**
> 请按 README 执行：
> 1. `node apply-host-heap.cjs --dry-run`，确认输出里没有 anchor 错误；
> 2. 备份后执行 `node apply-host-heap.cjs`；
> 3. 如果 `<resources>\dsh-runtime` 不存在，执行 `node extract-dsh-runtime.cjs`；
> 4. 重启 DSH，用 README 里的 PowerShell 命令确认 host 命令行含 `--max-old-space-size=16384`。
> 任何一步出现 `ABORT` 都不要继续，把输出原样贴回来。

## 文件

```
heap/apply-host-heap.cjs        asar 等长补丁（三处编辑 + 头部 hash 替换 + 备份校验）
heap/extract-dsh-runtime.cjs    把 asar 的 /dsh 解成真实目录（带 integrity 校验）
```

## License

MIT（见[仓库根目录的 LICENSE](../LICENSE)）。补丁修改的 `main.js` 属于 DeepSeek 的 MIT 许可包，见[仓库根目录的 THIRD-PARTY-NOTICES](../THIRD-PARTY-NOTICES.md)。
