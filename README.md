# dsh-kanban

项目看板插件（DeepSeek Harness / DSH Web GUI）：以「设计 → 人工确认 → 执行」的
接力方式管理项目。安装走官方 profile 插件通道（`dsh plugin add link:...`），
**不改 DSH 源码**。

架构参考 [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) 的外部插件模式
（Apache-2.0）：host 半身注册 webserver 路由 + 会话执行；browser 半身经
`/plugins/<id>/client.js` 伺服，DOM 级挂载进侧边栏和中心列。

## 仓库结构

```
packages/dsh-kanban/   单个插件包（host 半身 + browser 半身 + tests/）
```

## 开发循环

```sh
pnpm install
pnpm build              # tsc 类型 + tsdown 双半身打包（lib/index.js + lib/client.js）
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest run（tests/ 下 unit + jsdom 组件用例）
dsh plugin --profile web add link:$(pwd)/packages/dsh-kanban   # 装进 web profile
# 重启 dsh web 后，侧边栏出现「看板」入口
```

迭代 browser 半身可用 `pnpm watch`（tsdown --watch）；profile 里是 `link:`
安装，重启 `dsh web` 后产物即生效。

卸载：`dsh plugin --profile web remove dsh-kanban`，然后重启 `dsh web`。

## 当前状态

- [x] 基建闭环：外部插件安装通道、双半身加载、桥接自检（`/kanban/health`）
- [x] 状态机（7 状态：backlog / designing / awaiting-clarification /
      awaiting-review / executing / blocked / done，含超时 Blocked 与人工
      override）
- [x] 项目账本：`<DSH_HOME>/kanban/projects.json`（默认 `~/.dsh/…`），原子
      写穿 + 损坏隔离；项目产物按项目隔离在
      `<workspaceDir>/.kanban/projects/<projectId>/`（plan.md / tasks.json /
      artifacts/）
- [x] 设计/执行 agent 会话拉起（apiProxy）与轮询结算：新建项目自动拉起设计
      会话，人工确认后拉起执行会话；失败/取消/缺产物自动 Blocked；host 重启
      后自动恢复在跑的会话
- [x] 确认/驳回 UI 与反馈注入（驳回带反馈，回到同一设计会话继续改）
- [x] 递归任务拆解（tasks.json：clarify / research / design / execute，任意
      嵌套）与 dependsOn 依赖排序调度
- [x] clarify 问答（看板上直接向创建人提问，答案注入后续执行叶）
- [x] 项目详情视图（plan.md Markdown 预览）与任务详情视图（历史时间线、
      依赖等待、跳转 live 会话）

详见 `packages/dsh-kanban/README.md`。
