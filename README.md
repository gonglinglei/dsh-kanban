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

卸载：`dsh plugin --profile web remove @gonglinglei/dsh-kanban`，然后重启 `dsh web`。

### 桌面版（保留 profile `desktop`）

DeepSeek Harness 桌面版跑的是 `desktop` profile，且由 App 独占，必须用 App 自带的
CLI 安装（用 npx/全局 `dsh` 只会装进 `web` profile）：

```sh
DSH_DESKTOP_CLI='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
"$DSH_DESKTOP_CLI" plugin --profile desktop add link:$(pwd)/packages/dsh-kanban
scripts/desktop-verify.sh     # 只读校验：manifest + 产物 + /kanban/health
```

host 半身在安装后**热挂载**（无需重启 App），browser 半身 `Cmd+R` 重载窗口后出现。
细节与约束见 `packages/dsh-kanban/README.md` 的「安装 → B. 桌面版」。

## 当前状态

- [x] 基建闭环：外部插件安装通道、双半身加载、桥接自检（`/kanban/health`）
- [x] 状态机（7 状态：backlog / designing / awaiting-clarification /
      awaiting-review / executing / blocked / done，含超时 Blocked 与人工
      override）
- [x] 项目账本：`<DSH_HOME>/kanban/projects.json`（默认 `~/.dsh/…`），原子
      写穿 + 损坏隔离；项目产物按项目隔离在
      `<workspaceDir>/.kanban/projects/<projectId>/`（plan.md / tasks.json /
      artifacts/）
- [x] 设计/执行 agent 会话拉起（Session Controller）与轮询结算：新建项目自动拉起设计
      会话，人工确认后拉起执行会话；失败/取消/缺产物自动 Blocked；host 重启
      后自动恢复在跑的会话
- [x] 确认/驳回 UI 与反馈注入（驳回带反馈，回到同一设计会话继续改）
- [x] 递归任务拆解（tasks.json：clarify / research / design / execute，任意
      嵌套）与 dependsOn 依赖排序调度
- [x] clarify 问答（看板上直接向创建人提问，答案注入后续执行叶）
- [x] 项目详情视图（plan.md Markdown 预览）与任务详情视图（历史时间线、
      依赖等待、跳转 live 会话）
- [x] 项目详情页子任务依赖关系图视图（分层 DAG：节点为任务叶、有向边为
      依赖关系，「列表 / 依赖图」可切换，点击节点跳转任务详情）
- [x] 关联长期项目的一次性项目免选工作目录：host 强制继承父项目目录
      （capability `parent-workspace-inheritance` 握手，老 host 自动退回
      预填可编辑行为）
- [x] 离场后新增任务请求的可观测与人工物化：结算之后再写入的
      `tasks-additions.json` 不再永久孤儿化——扫描相位只读探测并把请求装配进
      快照，看板显示「⏳ 待处理的新增任务请求（N 项）」+「物化到看板」一键入口
      （capability `late-task-additions` 握手），格式错误的请求同样在卡上可见
- [x] 不可物化请求的隔离与人工废弃出口：规划被拒的批次在点击物化时隔离为
      `*.failed.json`（终态、不自动重试、写异常历史；其余批次照常物化，全失败则
      不重开项目）；JSON 坏掉的请求不再遮蔽同项目的健康批次；看板另有
      「废弃该请求」一键出口（改名为 `*.discarded.json` + human 审计历史，不动
      项目状态）。capability `additions-discard` 握手
- [x] 已完成任务的定期软归档：「已完成」列不再无限增长——已完成的节点在其
      `updatedAt`（最后一次账本提交）超过 `archiveAfterDays`（默认 7 天）后由 host
      的归档扫描相位自动归档（`archiveAfterDays = 0` 可关闭），另有人工即时入口。
      归档只是从看板移出：记录仍在账本（`format` 仍为 1）、`status` 不变、产物文件
      原样保留、不拉起也不取消任何会话，header「归档 (N)」进入归档视图可查、可
      一键恢复。长期容器项目本身永不归档，其下已完成的叶子逐个归档（可用
      `archiveDoneTaskLeaves` 关闭）；仍有未完成叶子、或存在可物化
      `tasks-additions*` 请求的项目不归档（请求必须永远可见、可处置）。capability
      `task-archive` 握手，老 host 不暴露入口

详见 `packages/dsh-kanban/README.md`。
