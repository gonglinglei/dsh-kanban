# dsh-kanban

项目看板插件：在 DSH Web GUI 里以「设计 → 人工确认 → 执行」的接力方式管理项目。
双半身插件，不改 DSH 源码：

- **Host 半身**（`src/index.ts`，跑在 dsh host 进程）：webserver 路由（当前：
  `GET /kanban/health` 桥接自检）+ system-prompt 通告。后续承载项目账本、
  状态机、会话拉起（apiProxy）与事件订阅。
- **Browser 半身**（`src/client/`，经 `/plugins/ui-kanban/client.js` 由 web GUI
  伺服）：侧边栏「看板」入口 + 中心列 DOM 挂载的看板视图。外部插件不能声明
  slot，两个表面都用自愈式 DOM 注入（dsh-web-ui 已验证的模式）。

## 安装

```sh
pnpm install && pnpm build
dsh plugin --profile web add link:$(pwd)
```

重启 `dsh web` 后侧边栏出现「看板」入口；点击后中心列显示看板，顶部显示
host 桥接自检结果。

卸载：`dsh plugin --profile web remove dsh-kanban`，重启 `dsh web`。

## 开发循环

```sh
pnpm build       # tsc 类型检查 + tsdown 打包（lib/index.js + lib/client.js）
```

改 browser 半身 → `pnpm --filter dsh-kanban bundle`（tsdown 只出 client.js）。
profile 里是 `link:` 安装，产物即改即生效（重启 dsh web 后）。

## 架构要点

| 层 | 机制 | 参考先例（dsh-web-ui, Apache-2.0） |
|---|---|---|
| Host 服务 | `ctx.webServer.register(route)`、`ctx.systemPrompt.section` | `dsh-task-board/src/index.ts` |
| 桥 | 同源 HTTP（`/kanban/*`）+（后续）SSE `/events` | `host-routes.ts` / `host-api.ts` |
| 会话执行 | （后续）apiProxy 拉起会话，watch turn 结束 | `core/execution.ts` |
| UI 挂载 | 侧边栏 DOM 注入 + 中心列 DOM 接管（`data-*` 切换） | `sidebar-entry-core.ts` / `board-mount.tsx` |

## 状态机（规划）

```
Backlog ──创建即自动(spawn 设计会话)──> Designing ──turn 结束──> AwaitingReview
AwaitingReview ──人确认──> Executing ──turn 结束──> Done
AwaitingReview ──人驳回+反馈──> Designing（继续同一会话）
任意 ──maxStaleMinutes 超时──> Blocked；人 override 任意→任意
```

## Known Limitations and Deferred Work

- **执行完成无验收门禁**：agent 自评 Done 不可信，v2 加 AwaitingAcceptance。
- **驳回循环无退出条件**：人是循环本身；v2 考虑驳回次数上限。
- **无 WIP/成本上限**：「新建即自动跑」= 自动消耗 API 额度。
- **树视图**（项目=目标拆解）是 v2。
- CSS Modules 管线（lightningcss 内联 `<style data-plugin>`）暂未引入，
  当前用内联样式 + 手注入样式表；引入时对齐 dsh-web-ui 的
  `shared/tsdown.client.ts`。
