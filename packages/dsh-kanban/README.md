# dsh-kanban

项目看板插件：在 DSH Web GUI 里以「设计 → 人工确认 → 执行」的接力方式管理项目。
双半身插件，不改 DSH 源码：

- **Host 半身**（`src/index.ts`，跑在 dsh host 进程）：项目账本、状态机、
  递归任务拆解与依赖调度、会话拉起与轮询结算（Session Controller）、stale 定时器、
  已完成归档的扫描相位（软归档）、webserver 路由（`/kanban/*`）与 system-prompt 通告。
- **Browser 半身**（`src/client/`，经 `/plugins/@gonglinglei/dsh-kanban/client.js` 由 web GUI
  伺服）：侧边栏「看板」入口 + 中心列 DOM 挂载的看板视图（7 列状态、项目卡
  与任务叶卡、确认/驳回、clarify 问答、项目/任务详情视图、归档视图与恢复入口）。外部插件不能声明
  slot，两个表面都用自愈式 DOM 注入（dsh-web-ui 已验证的模式）。

## 安装

### A. `dsh web` / 普通 profile（`web`）

```sh
pnpm install && pnpm build
dsh plugin --profile web add link:$(pwd)
```

重启 `dsh web` 后侧边栏出现「看板」入口；点击后中心列显示看板。

卸载：`dsh plugin --profile web remove @gonglinglei/dsh-kanban`，重启 `dsh web`。

### B. DeepSeek Harness 桌面版（保留 profile `desktop`）

桌面版跑的是 **`desktop` profile**，而不是 `web`：它由 Electron App 独占，App
自带的 CLI 才认。**不要用 npx/全局 `dsh` 装**，否则只会装进 `web` profile，
桌面 GUI 里看不到入口（`GET /kanban/health` 返回 404）。

```sh
# 桌面版自带 CLI（本质是 ELECTRON_RUN_AS_NODE 跑 dsh-desktop-host 的 cli.js）
DSH_DESKTOP_CLI='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

pnpm install && pnpm build
"$DSH_DESKTOP_CLI" plugin --profile desktop add link:$(pwd)
```

安装后**不需要重启 App**：插件管理器在 pnpm 之后执行 `reconcile`，把声明了
`dsh.bundle` 的新依赖追加进 `~/.dsh/profiles/desktop/package.json` 的
`dsh.profile.bundles`，驻留的 host 进程随即**热组合**该 Loader 条目。
browser 半身在 `Cmd+R` 重载窗口后才挂载。

验收：

```sh
scripts/desktop-verify.sh          # manifest + 产物 + host 探针，只读
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:19387/kanban/health   # 期望 200
```

`/kanban/*` 是 loopback 自校验的公开路由，200 即 host 半身在线；`/index.html`
与 `/plugins/<pkg>/client.js` 走 Host 的 auth cookie（只有 Shell 持有），
未带 cookie 时返回 401/404，**不能**用来判断插件是否加载。

卸载：`"$DSH_DESKTOP_CLI" plugin --profile desktop remove @gonglinglei/dsh-kanban`，
然后重载窗口（`remove` 同样经 `reconcile` 把条目移出 `dsh.profile.bundles`）。

已知约束：

- `dsh --profile desktop --dump-config` 会被拒（*profile "desktop" is managed
  exclusively by the Electron application*），所以「冷启动是否成功」只能靠完整
  退出并重开 App 验证；App 未初始化过 profile 时会先报
  *Open DeepSeek Harness Desktop once to initialize its profile*。
- 桌面版运行时是自带的那套（实测 `0.2.0-rc.2`），与 npm 上的 `web` profile
  版本不必一致。兼容性闸门只看 `peerDependencies` 里 `@deepseek-ai/dsh` /
  `@deepseek-ai/dsh-*` 的范围，本插件只声明 `@deepseek-ai/cordis` 与 `react`，
  因此不会被拒。
- 自助安装脚本：`scripts/desktop-install.sh`（`launchctl` 托管，可跨 App 退出）
  与 `scripts/submit-desktop-install.sh`；报告写在
  `~/Library/Logs/dsh-kanban-desktop/`。

## 开发循环

```sh
pnpm build       # tsc 类型检查 + tsdown 打包（lib/index.js + lib/client.js）
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm watch       # tsdown --watch（迭代 browser 半身）
```

改 browser 半身 → `pnpm bundle`（tsdown 只出 client.js）。profile 里是
`link:` 安装，产物即改即生效（重启 dsh web 后）。

## 测试

vitest，用例在 `tests/`：host 侧 unit（state-machine / storage / host-service /
host-routes / spawner / session-runner / decomposition）+ browser 侧 jsdom
组件用例（board 渲染/详情/切换、store、host-api）。归档功能另有
`tests/archive.spec.ts`（28 例：窗口边界、I1–I4 跳过、一次扫描一次落盘、幂等、
启动补跑、写入回滚、四个动作的拒绝文案/幂等/恢复、无会话与文件副作用）、
`tests/spawner-archive.spec.ts`（归档项目新落盘的请求在真实 poll tick 后重新可见）、
`tests/host-routes-archive.spec.ts`（11 例：`GET /kanban/archive` 的 loopback 栏栅、
`?projectId=` 簇读、只读性）与 `tests/board-archive.spec.tsx`（34 例：列里没有
已归档项、归档视图渲染与恢复动作、capability 缺失时不渲染入口）。

**开机级端到端自验**（两条真实时间线，均为 2026-09-14）：除了上面的用例，还存在
「真 bundle + 真 HTTP + 真账本副本」的自验脚本——它按 host 的方式 `apply()`
**shipped 的 `lib/index.js`**，让真实的 host-service + spawner 跑真实 5s 轮询，
再用真实 `node:http` 服务把 `/kanban/state`、`/kanban/action`、`/kanban/archive`
走一遍（`DSH_HOME` 指向临时 home，生产账本只读）。

- **离场后新增请求**（42/42 通过）：覆盖「存量孤儿收敛」与「结算之后补写请求」。
  脚本与报告见 `.kanban/projects/0c724876-93e4-4faf-919f-2fdc0a81e535/artifacts/e2e/`。
- **已完成定期归档**（79/79 通过）：在同一份真实栈上播种到期/未到期项目、长期容器与
  带请求的项目，断言 `projects.json` 里 `archivedAt` 有值而 `status` 仍是 `done`、
  记录未被删除、`format` 仍为 1，`/kanban/state` 不含它而 `/kanban/archive` 含它，
  `unarchive-project` 后回到「已完成」列，并用**第二个真实进程**重启同一账本验证
  不重复归档、账本不被重写；另比对归档前后产物目录的文件集合（含 `.failed.json` /
  `.discarded.json` 审计文件原样保留）。脚本与报告见
  `.kanban/projects/08108461-ad89-400d-8909-07a1385808fa/artifacts/e2e/`
  （项目产物目录，随项目保留）。

注意：改了 `src/` 之后必须 `pnpm build`，**并且重启 `dsh web`**——host 半身在进程
启动时装配 capability，客户端入口按 capability `late-task-additions` /
`additions-discard` / `task-archive` 门控，不重启则新入口不出现。

## 架构要点

| 层 | 机制 | 参考先例（dsh-web-ui, Apache-2.0） |
|---|---|---|
| Host 服务 | `ctx.webServer.register(route)`、`ctx.systemPrompt.section` | `dsh-task-board/src/index.ts` |
| 桥 | 同源 HTTP：`GET /kanban/state`、`POST /kanban/action`、`GET /kanban/file`、`GET /kanban/health`、`GET /kanban/archive`（按需读归档明细，**不进**热快照）+ SSE `GET /kanban/events`（15s 心跳，全量快照推送；visibilitychange 重拉兜底） | `host-routes.ts` / `host-api.ts` |
| 会话执行 | Session Controller 拉起会话（create + rename + queue prompt），5s 轮询 turn/end 结算；失败/取消/缺产物 → blocked；host 重启后 refire 阶段钩子并续跑已挂会话 | `core/execution.ts` |
| 任务拆解 | 设计 agent 可选写 `tasks.json`（clarify/research/design/execute，任意嵌套 + dependsOn）；人确认后物化为叶任务，依赖就绪才拉起，全部叶完成则项目完成 | — |
| 任务终止/删除 | 任务级人工动作 `terminate-task`（尽力取消会话 + 置 blocked 留痕）与 `delete-task`（取消会话 + 移除叶子 + 解除依赖引用 + 清产物 + 重算项目完成度）；删除项目级联取消其全部会话（防泄漏）。capability `task-terminate-delete` 握手，老 host 不暴露按钮 | — |
| 依赖关系图 | 项目详情页「子任务」区的依赖关系图视图（自绘分层布局 + SVG 连线，零新增依赖）：节点为任务叶（标题 + 类型 + 状态徽标），有向边从依赖方指向被依赖方，已完成依赖的连线弱化；「列表 / 依赖图」可切换，点击节点跳转任务详情 | `dep-graph-layout.ts` / `dep-graph.tsx` |
| 待处理的新增任务请求 | 执行 agent 随时可写 `tasks-additions.json`（提示词鼓励），但宿主只在「execute turn 结算那一刻」消费它——结算后叶子/项目已离开观察集合，之后写入的请求曾永久孤儿化。现在：每 tick 的扫描相位**只读探测 + 冻结**（把可被覆盖写的单槽位 rename 成不可变批次文件），把待处理请求装配进快照（`pendingAdditions`，**不落账本**），看板显示「⏳ 待处理的新增任务请求（N 项）」并给出「物化到看板」一键入口；人工点击才物化（走 human any→any 边重开 done/blocked 项目），格式错误的请求则在卡上显式报错。capability `late-task-additions` 握手，老 host 不暴露入口 | `host-service.ts` / `protocol.ts` / `board.tsx` |
| 不可物化请求的隔离与废弃 | 请求会失败，而失败必须**有终态、有出口**：一个能解析但规划被拒的批次（未知 dependsOn / 依赖环）在人工点击时被隔离为 `…<mtime>.failed.json`（不自动重试、不删除、写 `异常：` 历史），同一次点击的其余批次照常物化；一个 JSON 坏掉的批次留在原地（文件即证据）且不再遮蔽同项目的健康批次（`count`/`items` 只聚合可解析批次，坏文件单列 `PendingAddition.malformed`）。看板另有「废弃该请求」一键出口，把全部待处理批次改名为 `…<mtime>.discarded.json` 并写 `human` 审计历史（不动叶子/会话/项目状态）。capability `additions-discard` 握手，老 host 退回「无法物化」说明 | `host-service.ts` / `session-runner.ts` / `protocol.ts` / `board.tsx` |
| 已完成归档（软归档） | 与 stale 定时器同构的**归档扫描相位**：`archiveAfterDays`（默认 7 天，0 关闭）× `archiveSweepMinutes`（默认 60 分钟，最小 15）+ host 启动后补跑一次；无候选则**不落盘不广播**，一次扫描命中多条也只 `mutate()` 一次（`applyBatch`）。归档只写账本三个可选标量（`archivedAt`/`archivedBy`/`archiveNote`）并改变**视图**：不新增状态机状态、不动 `status`、不拉起/取消会话、不删任何文件。内部资格判定一律读**原始账本**（`getProject` / `getTask` / `projectTasks` / `readProjectFile` 都不过滤，归档记录仍可按 id 寻址、仍能发布请求），只有 `snapshot()` 与按需读接口认「已归档」——视图策略不得变成业务策略。capability `task-archive` 握手，老 host 不暴露入口 | `host-service.ts` / `protocol.ts` / `board.tsx` |
| UI 挂载 | 侧边栏 DOM 注入 + 中心列 DOM 接管（`data-*` 切换） | `sidebar-entry-core.ts` / `board-mount.tsx` |

### capability 握手

宿主在每次快照里按运行中的构建重新装配 `HOST_CAPABILITIES`（**不落账本**），客户端
只用 `includes()` 门控自己的入口：老 host 下新入口整块不渲染，新 host + 老 client
则多余字段被忽略。**新 token 只能追加在末尾**，不重排既有顺序（`includes()` 与位置
无关，但顺序本身就是既有测试的字面量断言）。当前顺序与门控的入口：

| # | capability | 门控的入口 |
|---|---|---|
| 1 | `long-running-projects` | 新建项目时的 `lifecycle: 'long-running'` |
| 2 | `parent-workspace-inheritance` | 关联长期项目时免选工作目录（host 继承父目录） |
| 3 | `task-terminate-delete` | 任务叶的「终止」/「删除」 |
| 4 | `task-recovery` | 任务叶的「恢复」/「重新排队」 |
| 5 | `late-task-additions` | 「⏳ 待处理的新增任务请求」徽标与「物化到看板」 |
| 6 | `additions-discard` | 「废弃该请求」 |
| 7 | `task-archive` | header「归档 (N)」、归档视图、归档/恢复按钮 |

## 状态机

项目与任务叶共用同一台状态机（7 个状态）：

```
backlog ──创建即自动(system)──> designing ──agent/system 报设计完成──> awaiting-review
awaiting-review ──人确认──> executing ──agent/system 报执行完成──> done
awaiting-review ──人驳回+反馈──> designing（继续同一设计会话）
clarify 叶：awaiting-clarification ──创建人作答──> awaiting-review ──创建人确认──> done
research 叶：awaiting-review ──system 验证产物──> done（调研结论无需人工门禁）
任意活跃态 ──maxStaleMinutes 超时(system)──> blocked；人 override 任意→任意
```

Actor 策略：`human` 任意→任意（人始终是最终裁决者）；`agent` 只能上报自己
阶段的结果（designing→awaiting-review、executing→done）；`system`（host）
驱动创建入设计、阶段结算、调研验证与超时 Blocked。

依赖调度：任务叶的会话只在其 dependsOn 全部 done 后拉起；execute 叶额外等待
项目的全部 clarify 叶完成（澄清问答注入执行 prompt）。

任务级人工控制（capability `task-terminate-delete` 门控，老 host 不显示按钮）：
「终止」= 软停止（尽力取消会话后任意非 blocked 态 → blocked，历史留痕「人工终止」，
被终止的叶子不会再被自动拉起，项目也不会因此自动完成）；「删除」= 硬移除
（任意状态可删：取消会话、从账本移除、解除兄弟叶子的依赖引用并留痕、清理
`artifacts/<taskId>.md`、删除最后一个未完成叶子后项目自动推导为 done）。

归档**不是第 8 个状态**：它由独立字段表达的视图状态承载，状态机与全部既有边不变
（见下节）。

## 已完成归档（软归档）

「已完成」列原本只增不减：`done` 的项目与叶子永久留在账本、热快照与看板列里。
现在已完成的节点会在保留窗口到期后**自动归档**，也可以人工即时归档；归档只是
从看板移出——记录仍在 `projects.json`，产物文件一个不少，随时可一键恢复。

**归档对象**（三形态，澄清 1 确认「1 和 2 都要」）：

| 形态 | 对象 | 入口 |
|---|---|---|
| A | `done` 的一次性项目整体（其叶子随项目一起隐藏，不单独打标） | 定期相位 / 项目卡「归档」 |
| B | 长期容器项目名下 `done` 的子项目（`parentId` 指向容器） | 定期相位 / 项目卡「归档」 |
| C | 仍可见项目下 `done` 的任务叶子（长期容器的「已完成」列不会无限增长） | 定期相位 / 项目详情「子任务」行的「归档」 |

**永不归档（不变量 I1–I4）**：非 `done` 节点；`lifecycle === 'long-running'` 的
长期项目本身（它是容器，不是工作项）；仍有非 `done` 叶子的项目（矛盾态要被报告，
不能被隐藏）；存在**可物化** `tasks-additions*` 请求的项目（请求必须永远可见、
可处置）。自动相位与人工按钮共用同一处判定，因此按钮不会归档扫描拒绝的东西，
反之亦然；被拒时返回带原因的 400（如「项目仍有未完成的子任务，不能归档」）。

**定期节奏**（澄清 2）：判定基准是 `updatedAt`（最后一次账本提交；归档/恢复本身
也会推进它，因此恢复即重新获得一个完整窗口，不会被下一轮立刻又归档）；
`archiveAfterDays = 0` 表示关闭**自动**归档（人工入口照常可用，窗口只约束相位，
不约束按钮）。扫描周期 `archiveSweepMinutes`，并在 host 装载账本后**补跑一次**，
保证停机期间到期的归档不漏。空闲扫描零副作用：无候选就不写盘、不广播；一次扫描
命中多条也只落盘一次（`revision` 只 +1）。升级后第一次启动的补跑是一次**批量
归档**（窗口内所有到期记录一起移出「已完成」列），这是预期行为，可用
`archiveAfterDays = 0` 或逐条「恢复」撤回。

**软归档的边界**（澄清 3，I5）：不动 `status`、不启动也不取消任何 agent 会话、
不删除任何文件（`plan.md` / `artifacts/` / `.failed.json` / `.discarded.json`
原样保留，文件 GC 不在本期范围）；对已归档节点再次归档是**幂等 no-op**（无
history、无 version、无 revision）。归档 = 账本 metadata commit
（`from === to === 'done'`），只追加一条 history（自动文案形如
「自动归档：已完成 10 天（阈值 7 天）」，人工为「手动归档｜…」），不新增状态机边、
不触发依赖调度。

**恢复是精确逆操作**：清掉三个字段并追加一条「恢复归档｜…」留痕，状态、其余
history 与会话引用一律不动。项目级恢复**只清项目自己的标记**：若某个叶子此前被
单独归档过，它保留自己的标记（在归档视图里另有条目与恢复入口），因此恢复后的
可见集合与归档前**逐元素相同**；其余叶子随项目一起回来，恢复仍是单点动作。

**协议面**：capability `task-archive`（追加在 `HOST_CAPABILITIES` 末尾，不重排
既有顺序）、四个动作 `archive-project` / `unarchive-project` / `archive-task` /
`unarchive-task`、按需读 `GET /kanban/archive`（loopback 栏栅、只读不写盘；
`?projectId=` 返回该项目的**簇读**：它自己名下的归档叶子 + 以它为父的归档子项目
及其叶子，供项目详情页补齐已归档节点，不含项目自身）。

**快照只带计数**：`snapshot()` 过滤已归档记录并给出 `archivedCounts`
（`{ projects, tasks }` 两个数，O(1)，**不含**明细）；归档明细只在按需读接口
出现，热路径（每次 mutation + SSE 全量推送）不再随之增长。口径：
`archivedCounts.projects + archivedCounts.tasks` = `GET /kanban/archive` 的条目数
= header「归档 (N)」的 N；随项目一起隐藏的叶子不再单独计数（它没有独立标记，
也无法单独恢复）。

**请求压过归档**：归档**之后**落盘的新 `tasks-additions*` 请求不会被静默吞掉——
spawner 的发布相位读原始账本，快照让「有活请求」压过「已归档」，于是该项目连同
其叶子重新出现在看板上并带「⏳ 待处理的新增任务请求」徽标（账本标记不动，请求
处置完自动回到归档视图）。「物化到看板」把项目 commit 回 `executing`，归档标记由
「不再是 `done` 就清标记」的咽喉点自动清除（无需额外的反归档调用）。

**降级**：老 host（无 `task-archive`）下客户端完全不渲染归档入口与归档视图；
新 host + 老 client 是「列变短」，不崩；含 `archivedAt` 的账本 `format` 仍为 1，
老 host 读取会把归档项重新显示（可见但无害），不触发损坏隔离。

## 数据与产物

- **账本**：`<DSH_HOME>/kanban/projects.json`（`DSH_HOME` 默认 `~/.dsh`，可用
  配置项 `projectsFile` 覆盖）。单写者（host service）+ 原子写穿（临时文件 +
  rename）；损坏文件改名隔离后重新起步。
- **归档标记**：`Project` 与 `TaskNode` 上的三个可选标量 `archivedAt` /
  `archivedBy` / `archiveNote`（`archiveNote` 上界 200 字符）。`loadState` 对它们
  做 fail-open 归一化（`archivedAt` 非法则三个字段一起丢，其余字段各自丢；只在
  内存里纠正，不写盘）。`format` 恒为 `1`：旧账本零迁移，老 host 读新账本也不
  会触发损坏隔离。**归档不缩小账本文件**：记录与 history 从未离开
  `projects.json`，收益全在热路径（见 Known Limitations）。
- **项目产物目录**：`<workspaceDir>/.kanban/projects/<projectId>/`，内含
  `plan.md`（设计方案）、`tasks.json`（可选拆解清单）、`tasks-additions*.json`
  （执行 agent 的新增任务请求与其消费审计）、`artifacts/<taskId>.md`
  （research/design 叶产物）。同一 workspaceDir 下多项目互不覆盖；新一轮设计
  **只**清 `plan.md` + `tasks.json`（待处理请求与 `artifacts/` 一律保留，并在
  项目历史留一条「保留 N 个待处理请求」的说明）；删除项目连带删除目录。
- **任务请求文件的生命周期**：`tasks-additions.json`（agent 可覆盖写的唯一槽位）
  → 扫描相位在文件稳定后冻结为 `tasks-additions.<mtime>.pending.json`
  → 被消费时先认领为 `…<mtime>.consuming.json` → 成功物化后落到
  `…<mtime>.consumed.json`（同毫秒冲突时加序号，绝不覆盖既有审计）。冻结的意义：
  同一会话写第二次时产生**新文件**而不是覆盖第一次的请求。三个**终态**都不会再
  被消费：`consumed`（已物化）、`failed`（已隔离：能解析但规划被拒，见下）、
  `discarded`（已被人工废弃）。终态判定用「可动作阶段白名单」而非
  「非 consumed」，因此新增终态永远不会把审计文件重新变成活请求。
- **不可物化请求的两个出口**（capability `additions-discard` 握手，老 host 只显示
  「无法物化」的说明）：
  - **隔离**：点「物化到看板」时，一个**能解析但规划被拒**的批次（未知 dependsOn、
    依赖环）不再让整次点击失败——它被改名隔离为 `…<mtime>.failed.json`（内容原样
    保留）并写一条 `异常：` 项目历史，其余批次照常物化。隔离是终态、不自动重试，
    因此不会每 tick 重试风暴；修好原因后把它改回 `tasks-additions.json` 即可重试。
    若**全部**批次都无法物化，项目**不会**被重开，调用方收到带原因的 400。
  - **废弃**：看板上「废弃该请求」把该项目**所有**待处理批次（含无法解析的
    `tasks-additions.json`）改名为 `…<mtime>.discarded.json` 并写一条 `human`
    审计历史。它**不动**任何叶子、会话与项目状态——`done` 项目废弃请求后仍是
    `done`，文件不删除、可人工恢复。
  - **无法解析的请求不隔离**：JSON 坏掉的批次留在原地（文件本身就是证据），
    由看板报错 + 人工修复或废弃两条路处置。它也不再**遮蔽**同项目的健康批次：
    快照的 `count`/`items` 只聚合可解析批次，坏文件单列在 `malformed`。
- **关联项目的工作目录继承**：新建一次性项目时选中「关联长期项目」即免选工作
  目录——host 强制以父项目当前的 `workspaceDir` 作为子项目目录（调用方另传的
  值一律忽略，host 是该不变量的唯一事实源），创建历史以
  `created (workspace inherited from parent)` 留痕。协议面由 capability
  `parent-workspace-inheritance` 握手：无该能力的老 host 下，客户端退回「自动
  预填父项目目录、保持可编辑」的旧协议行为，两边组合均不报错。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件总开关（通告 + 路由） |
| `announceToAgent` | `true` | 向每个 agent 的 system prompt 通告看板能力 |
| `maxStaleMinutes` | `0` | 活跃态无活动超过该分钟数则 Blocked；0 关闭定时器 |
| `archiveAfterDays` | `7` | 已完成的节点在其 `updatedAt`（最后一次账本提交）超过该天数后自动归档；0 关闭自动归档（最小 0） |
| `archiveSweepMinutes` | `60` | 自动归档扫描周期（分钟，最小 15）；host 启动装载账本后另补跑一次 |
| `archiveDoneTaskLeaves` | `true` | 自动相位是否也归档仍可见项目下 `done` 的任务叶子（长期容器的已完成叶子是唯一会长期滞留的形态）；人工「归档」按钮不受此开关影响 |
| `projectsFile` | `<DSH_HOME>/kanban/projects.json` | 账本文件覆盖 |

## Known Limitations and Deferred Work

- **执行完成无验收门禁**：executing → done 由 agent/system 自报推进，没有人工
  验收环节（设计产物有 awaiting-review 门禁，执行结果没有）；后续考虑加
  AwaitingAcceptance。
- **驳回循环无退出条件**：人是循环本身；后续考虑驳回次数上限。
- **无 WIP/成本上限**：「新建即自动跑」= 自动消耗 API 额度。
- **离场后新增任务需人工确认**：叶子/项目结算为 done/blocked 之后写入的
  `tasks-additions.json` 不再被自动消费（系统在结算之外不擅自改账本、不擅自拉起
  会话），只以「⏳ 待处理的新增任务请求（N 项）」呈现，点「物化到看板」才物化；
  物化会**立即**为其中每个 execute 叶子拉起会话（真实消耗额度、真实改动仓库），
  并让 done/blocked 项目重新进入 executing。
- **请求槽位仍是单文件**：`tasks-additions.json` 可被 agent 覆盖写。扫描相位每
  tick 冻结一次，因此「宿主停机期间的多次写入」与「同一 5s tick 内的两次写入」
  仍会丢失先写的那份（被覆盖的请求不可恢复）；请求里也不记录写者身份，审计只
  能归因到「请求文件 + 写入时间」。
- **格式错误的请求不会被自动隔离**：`tasks-additions.json` 的 JSON 坏掉时宿主不
  会自动改名（文件即证据），看板显式报错（`malformed`），并提供「废弃该请求」一键
  出口；修好文件（或人工改回 `tasks-additions.json`）后下一个轮询周期自动重新检测。
  宿主不做 GUI 内编辑 JSON。**能解析但规划被拒**的批次则会自动隔离为 `.failed.json`
  （见「不可物化请求的两个出口」），不再每 tick/每次点击重复失败。
- **隔离/废弃的文件不自动清理，归档也不例外**：`.failed.json` / `.discarded.json` /
  `.consumed.json` 是审计文件，会一直留在项目目录里（`clearStaleArtifacts` 与
  deleteProject 之外的路径都不会删它们）；**归档只处理账本与视图，不做任何文件
  GC**（`plan.md` / `artifacts/` / 审计 JSON 原样保留），长期项目目录仍会缓慢
  累积，需要人工清理。记录搬迁（硬归档）与产物保留策略都不在本期范围。
- **软归档不缩小账本**：归档不裁剪 `history`、不搬迁记录，`projects.json` 仍只增
  不减（history 约占账本字节的一半）。本期的收益全在**热路径**：`/kanban/state`
  与 `/kanban/action` 响应、SSE 帧、spawner 轮询的输入都不再随历史线性增长。
  需要真正压缩账本时，应另立「硬归档 / 记录搬迁」需求（它要重做恢复、幂等重放与
  损坏隔离），不要指望调小窗口。
- **看板视图必须留在正常流里，不能绝对定位**：宿主 `centerCol` 是**静态**的
  grid/flex item（桌面版 0.2.0 里是 `_6Qf49G_centerCol`，没有 `data-pane`），
  而 `.frame` 才是 `position: relative`——`position: absolute; inset: 0` 会以
  frame 为包含块，直接盖住整个左侧边栏（已修的缺陷）。现在用
  `height: 100% + flex: 1 1 0` 撑满列；`tests/board-mount-shell.spec.tsx` 同时
  钉住「挂载点仍在 centerCol 内」和「规则不得绝对定位」两条契约。
- **注入的 `<style>` 会跨 fiber 存活**：热重载后的 bundle 必须**覆写**已存在的
  `style[data-plugin-css]` 文本（早期实现是「存在就跳过」，会把上一版的 CSS 一直
  留在页面里）。
- **会话跳转接口随外壳版本漂移**：0.1.x / 0.2.0 的 `sessions.open` 在
  **0.2.1** 被移除（导航职责从 session-controller 移到 UI 消费方），改用
  `ctx.uiWorkspace.openSession(id)`；桌面版自动升级后会直接抛
  `sessions.open is not a function`。`src/client/open-session.ts` 在**点击时**
  按 `uiWorkspace.openSession → sessions.open` 的顺序特性探测，两者都没有时报
  可操作错误；`tests/open-session.spec.ts` 钉住两条路径 + 归档/跨工作区提示。
- **会话列表快照的成员字段也变了**：0.2.1 起权威成员是 `sessions.list` 快照的
  `ids`（内置 UI 用它判断「是否可跳转」），`byId` 只再用于标题；老的
  `data-pane`/`byId` 假设都要保留兜底。
- **归档项目不再提供方案预览与流转历史视图**：归档视图是**投影**（不含
  `history`，也不给方案预览入口），因此归档项目的详情页只有标题、归档时间、
  归档人、原因与子任务数。记录与产物文件都没有丢，点「恢复」即可回到完整详情。
- **升级后首启会批量归档**：`archiveAfterDays` 默认 7 天，升级后第一次启动的补跑
  会把所有 `done` 且已超窗的记录一次性移出「已完成」列（因此「重启一次看板少了
  一半」是预期行为，不是数据丢失）。想先观察或完全关闭自动归档，把
  `archiveAfterDays` 置 `0`；已归档项可逐条恢复（停掉 host 后清三个字段亦可，
  记录从未离开账本）。
- **归档项目的请求发布成本随归档记录数线性增长**：为了让归档**之后**新落盘的
  `tasks-additions*` 仍然可见（I4），spawner 每个 poll tick 会对每个已归档项目做
  一次只读目录扫描（无请求文件时不读文件），相当于既有扫描成本 ≤2×。当前量级
  （几十个项目 / 5s）可忽略；归档记录达到数千级时应把「归档项目的请求发布」降为
  每 N tick 一次或按目录 mtime 触发（本期未做，阈值化兜底）。
- **嵌套树视图未做**：递归拆解已实现，但 UI 以扁平任务叶 + 标题路径
  （`父 > 子`）呈现，不按树形嵌套渲染。
- CSS Modules 管线（lightningcss 内联 `<style data-plugin>`）暂未引入，
  当前用内联样式 + 手注入样式表；引入时对齐 dsh-web-ui 的
  `shared/tsdown.client.ts`。
