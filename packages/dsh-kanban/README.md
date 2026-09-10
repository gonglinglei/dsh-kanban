# dsh-kanban

项目看板插件：在 DSH Web GUI 里以「设计 → 人工确认 → 执行」的接力方式管理项目。
双半身插件，不改 DSH 源码：

- **Host 半身**（`src/index.ts`，跑在 dsh host 进程）：项目账本、状态机、
  递归任务拆解与依赖调度、会话拉起与轮询结算（Session Controller）、stale 定时器、
  webserver 路由（`/kanban/*`）与 system-prompt 通告。
- **Browser 半身**（`src/client/`，经 `/plugins/@gonglinglei/dsh-kanban/client.js` 由 web GUI
  伺服）：侧边栏「看板」入口 + 中心列 DOM 挂载的看板视图（7 列状态、项目卡
  与任务叶卡、确认/驳回、clarify 问答、项目/任务详情视图）。外部插件不能声明
  slot，两个表面都用自愈式 DOM 注入（dsh-web-ui 已验证的模式）。

## 安装

```sh
pnpm install && pnpm build
dsh plugin --profile web add link:$(pwd)
```

重启 `dsh web` 后侧边栏出现「看板」入口；点击后中心列显示看板。

卸载：`dsh plugin --profile web remove @gonglinglei/dsh-kanban`，重启 `dsh web`。

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
组件用例（board 渲染/详情/切换、store、host-api）。

## 架构要点

| 层 | 机制 | 参考先例（dsh-web-ui, Apache-2.0） |
|---|---|---|
| Host 服务 | `ctx.webServer.register(route)`、`ctx.systemPrompt.section` | `dsh-task-board/src/index.ts` |
| 桥 | 同源 HTTP：`GET /kanban/state`、`POST /kanban/action`、`GET /kanban/file`、`GET /kanban/health` + SSE `GET /kanban/events`（15s 心跳，全量快照推送；visibilitychange 重拉兜底） | `host-routes.ts` / `host-api.ts` |
| 会话执行 | Session Controller 拉起会话（create + rename + queue prompt），5s 轮询 turn/end 结算；失败/取消/缺产物 → blocked；host 重启后 refire 阶段钩子并续跑已挂会话 | `core/execution.ts` |
| 任务拆解 | 设计 agent 可选写 `tasks.json`（clarify/research/design/execute，任意嵌套 + dependsOn）；人确认后物化为叶任务，依赖就绪才拉起，全部叶完成则项目完成 | — |
| 任务终止/删除 | 任务级人工动作 `terminate-task`（尽力取消会话 + 置 blocked 留痕）与 `delete-task`（取消会话 + 移除叶子 + 解除依赖引用 + 清产物 + 重算项目完成度）；删除项目级联取消其全部会话（防泄漏）。capability `task-terminate-delete` 握手，老 host 不暴露按钮 | — |
| 依赖关系图 | 项目详情页「子任务」区的依赖关系图视图（自绘分层布局 + SVG 连线，零新增依赖）：节点为任务叶（标题 + 类型 + 状态徽标），有向边从依赖方指向被依赖方，已完成依赖的连线弱化；「列表 / 依赖图」可切换，点击节点跳转任务详情 | `dep-graph-layout.ts` / `dep-graph.tsx` |
| UI 挂载 | 侧边栏 DOM 注入 + 中心列 DOM 接管（`data-*` 切换） | `sidebar-entry-core.ts` / `board-mount.tsx` |

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

## 数据与产物

- **账本**：`<DSH_HOME>/kanban/projects.json`（`DSH_HOME` 默认 `~/.dsh`，可用
  配置项 `projectsFile` 覆盖）。单写者（host service）+ 原子写穿（临时文件 +
  rename）；损坏文件改名隔离后重新起步。
- **项目产物目录**：`<workspaceDir>/.kanban/projects/<projectId>/`，内含
  `plan.md`（设计方案）、`tasks.json`（可选拆解清单）、`artifacts/<taskId>.md`
  （research/design 叶产物）。同一 workspaceDir 下多项目互不覆盖；新一轮设计
  清空本项目目录；删除项目连带删除目录。
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
| `projectsFile` | `<DSH_HOME>/kanban/projects.json` | 账本文件覆盖 |

## Known Limitations and Deferred Work

- **执行完成无验收门禁**：executing → done 由 agent/system 自报推进，没有人工
  验收环节（设计产物有 awaiting-review 门禁，执行结果没有）；后续考虑加
  AwaitingAcceptance。
- **驳回循环无退出条件**：人是循环本身；后续考虑驳回次数上限。
- **无 WIP/成本上限**：「新建即自动跑」= 自动消耗 API 额度。
- **嵌套树视图未做**：递归拆解已实现，但 UI 以扁平任务叶 + 标题路径
  （`父 > 子`）呈现，不按树形嵌套渲染。
- CSS Modules 管线（lightningcss 内联 `<style data-plugin>`）暂未引入，
  当前用内联样式 + 手注入样式表；引入时对齐 dsh-web-ui 的
  `shared/tsdown.client.ts`。
