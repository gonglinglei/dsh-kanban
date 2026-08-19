# dsh-kanban

项目看板插件（DeepSeek Harness / DSH Web GUI）：以「设计 → 人工确认 → 执行」的
接力方式管理项目。安装走官方 profile 插件通道（`dsh plugin add link:...`），
**不改 DSH 源码**。

架构参考 [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) 的外部插件模式
（Apache-2.0）：host 半身注册 webserver 路由 + 会话执行；browser 半身经
`/plugins/<id>/client.js` 伺服，DOM 级挂载进侧边栏和中心列。

## 仓库结构

```
packages/dsh-kanban/   单个插件包（host 半身 + browser 半身）
```

## 开发循环

```sh
pnpm install
pnpm build              # tsc 类型 + tsdown 双半身打包（lib/index.js + lib/client.js）
dsh plugin --profile web add link:$(pwd)/packages/dsh-kanban   # 装进 web profile
# 重启 dsh web 后，侧边栏出现「看板」入口
```

卸载：`dsh plugin --profile web remove dsh-kanban`，然后重启 `dsh web`。

## 当前状态

- [x] 基建闭环：外部插件安装通道、双半身加载、桥接自检（/kanban/health）
- [ ] 状态机（Backlog → Designing → AwaitingReview → Executing → Done）
- [ ] 项目存储（~/.dsh/kanban/projects.json）
- [ ] 设计/执行 agent 会话拉起（apiProxy）与事件驱动状态推进
- [ ] 确认/驳回 UI 与反馈注入

详见 `packages/dsh-kanban/README.md`。
