# mausbridge：把 OpenMausBot 的 Bot 绑定到已有的 Codex / DeepSeek 会话

这是 fork `fayehardin74-beep/OpenMausBot` 上的一层小补丁，基于上游 OpenMausBot 发布版本（当前 v0.1.148），不基于 `main`。
目标：一个 Bot 固定对应一个已有的 Codex 线程或 DeepSeek 会话；Bot 之间派活、完成通知都由程序完成，不新建会话、不改用 API。

## 改了什么

上游核心文件只改了 4 行，每处都有 `mausbridge hook N/4` 注释：

| 位置 | 作用 |
|---|---|
| `server/index.ts` hook 1/4 | 创建绑定服务，挂上 `/api/mausbridge/bindings` 接口（只接受本机请求） |
| `server/index.ts` hook 2/4 | 每轮发给引擎之前，把已绑定对话钉在绑定的会话上：不重置、不用"历史回放"新开；会话被 Codex/DeepSeek 客户端占着时先等待，释放后自动发出 |
| `server/drivers/acp/core.ts` hook 3/4 | ACP 引擎（DeepSeek）续接已绑定会话失败时，让这一轮报错，而不是悄悄 `session/new` |
| `server/index.ts` hook 4/4 | `coordinate_bots` 派给已绑定 Bot 的活，进它绑定的那个对话，而不是新开 "@X · work" 对话 |

另外加了两个目录：

- `server/mausbridge/`：绑定逻辑（`session-bindings.ts`）、接口（`routes.ts`）和测试。绑定数据存在 `~/.openmausbot/mausbridge/bindings.json`。
- `scripts/mausbridge/`：启动脚本、DeepSeek 包装脚本 `dsh-acp`、每个项目一个引擎实例的工具、一键检查和冒烟测试。

## 为什么这样设计

- **Codex**：用 Codex 自己的 `thread/resume` 续接线程。Codex 同一时间只允许一个写入者，桌面端打开着这个线程时，OpenMausBot 这一轮会安全地失败，不会损坏线程。
- **DeepSeek**：用官方 `dsh --profile acp` 和 ACP 协议的 `session/resume`，不读写 DeepSeek 的日志文件和 `session.lock`。有两点要注意：
  - **工作目录**：dsh 只在会话原来的工作目录里续接，而 ACP 驱动用的是引擎实例的 `workspace`，不看 Bot 的 cwd。所以要**每个项目一个实例**，用 `add-project-instance.mjs` 创建。
  - **工具预设**：桌面端建的会话会记下它的工具预设（`ptc` 或 `standard`）。dsh 会把会话原来没有的工具全部设为延迟加载，而 DeepSeek 接口拒绝"全部延迟"的请求。`dsh-acp` 用官方 `--patch` 补上对应预设：
    - `dsh-acp` 和 `dsh-acp-ptc` 对应 ptc。
    - `dsh-acp-standard` 对应 standard。
    - 要查某个会话用的是哪个预设，看它日志里最后一条 `agent-preset/selected`。
- **不额外花 token**：派活结果由运行时自动唤醒派活方，不经过额外的模型。绑定的 Bot 关掉了 `memoryUpkeep`（自动记忆整理会另外调用模型），也关掉了 MausBot 的 Chief of Staff（它会自动重试并调用模型）。

## 客户端占着会话时：自动等待

Codex 和 DeepSeek 同一时间只允许一个程序写同一个会话。发消息前，`server/mausbridge/session-holder.ts` 会只读地检查锁文件被谁打开（用 `lsof` 查，从不自己去加锁）：

- Codex：`~/.codex/thread-writer-locks/<线程>.lock`
- DeepSeek：`~/.dsh/sessions/<工作目录>/<会话>/session.lock`

如果锁在别的程序手里（OpenMausBot 自己启动的引擎不算），这一轮会先等着：
- 对话里显示"客户端正占用这个会话，这条消息先等着"，之后每 5 秒检查一次。
- 锁一释放就自动发出，并提示"已释放会话，消息已发出"。
- 等待期间点"停止"可以取消；最多等 6 小时，超时就报错，不发出。

整个过程不调用模型。

## 日常使用

- 启动：双击桌面上的 **OpenMausBot** 图标。它会自动拉起服务（端口 8799）和网页（端口 5199），已经在运行的就跳过，然后打开桌面客户端。日志在 `~/.openmausbot/mausbridge/logs/`。
  - 图标由 `scripts/mausbridge/make-launcher.sh` 生成，仓库换了位置要重新运行它。
  - 桌面客户端需要 Electron 本体，第一次使用前要运行一次 `node node_modules/electron/install.js` 下载。
  - 关掉客户端窗口后，服务仍在后台运行，再双击图标会直接打开窗口。
- MausBot（默认 Bot，负责分派）用 Claude：引擎实例 `claude` 的 `cli` 指向 `scripts/mausbridge/claude`，它每次都取 Claude 桌面 App 自带的最新版 Claude Code。需要先运行一次 `scripts/mausbridge/claude auth login`，登录 Claude 账号。MausBot 设为 `ask`，并关掉 chiefOfStaff 和 memoryUpkeep，以免自动重试、自动整理额外花 token。
- 使用前，**DeepSeek 桌面端要退出**；Codex 桌面端可以开着，但不能打开正在绑定的线程。
- 绑定的 Codex Bot 用 `approvalMode: "ask"`。如果用 `full`，续接时会把线程权限放宽到完全访问。
- 绑定、查看、解绑（只能在本机调用）：
  ```sh
  curl -s -X POST -H 'content-type: application/json' -d '{"botId":"<bot>","cursor":"<会话或线程 ID>"}' http://127.0.0.1:8799/api/mausbridge/bindings
  curl -s http://127.0.0.1:8799/api/mausbridge/bindings
  curl -s -X DELETE http://127.0.0.1:8799/api/mausbridge/bindings/<bot>
  ```
- 新项目的 DeepSeek 实例（要先停掉服务器）：
  ```sh
  node scripts/mausbridge/add-project-instance.mjs ds-<名字> deepseekAgent <工作目录> "<显示名>" "$PWD/scripts/mausbridge/dsh-acp-<预设>"
  ```

## 升级到新的上游版本

上游更新很快，按发布标签合并，不要合并 `main`：

```sh
git fetch upstream --tags
git switch -c mausbridge-upgrade-vX mausbot-bridge   # 先在新分支上试
git merge vX                                          # 例如 v0.1.148
pnpm install --frozen-lockfile
scripts/mausbridge/check.sh
```

`check.sh` 依次做四件事：
1. 确认 4 处 hook 都还在。
2. 类型检查。
3. 跑 mausbridge 和 ACP 驱动的测试。
4. 跑冒烟测试 `smoke.ts`：在一个临时、隔离的服务器上，用假 ACP 引擎走一遍"绑定 → 发送 → 等完成"，全程不碰真实数据。

全部通过后，再把 `mausbot-bridge` 快进到这个分支，并重启服务器。

**文件大小上限**：上游的 `scripts/testing/file-size-ratchet.test.ts` 不许几个大文件变长，git push 前会检查。这里把 `server/index.ts` 和 `server/drivers/acp/core.ts` 的上限调到了"上游行数 + hook 行数"。合并后如果这两项冲突或检查报错，就用合并后的实际行数（`wc -l`）更新这两个数字。

**冲突怎么处理**：只可能出现在上面 4 行附近，或者上面那两个上限数字上。保留上游的新代码，再把对应的那一行 hook 放回原来的位置：
- hook 1：放在 `ROUTES.push(...botApi.routes)` 之后。
- hook 2：放在 `handoffs.dispatching(...)` 之前。
- hook 3：放在 ACP 续接循环里 `sessionAllows.delete(threadId)` 之前。
- hook 4：放在 `coordinate_bots` 处理里的 `const continued = ...` 一行。

如果上游重命名了这些位置，`check.sh` 的第一步或单元测试会报错，不会悄悄失效。

**DeepSeek 升级之后**：用一个测试会话，在 DeepSeek 桌面端退出的状态下发一条消息，确认 `dsh-presets/*.patch.yml` 里的行 id 还存在：
```sh
dsh --profile acp --patch scripts/mausbridge/dsh-presets/ptc.patch.yml --dump-config
```

**已验证**：2026-11-07，从 v0.1.146 合并 v0.1.148（上游 19 个提交），无冲突，`check.sh` 全部通过。

## 已知限制

- 把已绑定的 Bot 拉进"房间"一起讨论时，房间对话仍可能新建会话。hook 4 只处理 Bot 之间的直接派活。
- OpenMausBot 会把它自己的角色说明和时间、文件位置等上下文作为消息写进绑定的会话，在桌面端看得到。
- `smoke.ts` 用的是假引擎，证明的是 OpenMausBot 这一侧的绑定流程。Codex、DeepSeek 本身升级后，仍需要用真实的测试会话手动确认一次。

## 是否向上游提 PR（评估，未提交）

结论：**暂不提交，建议先开 issue 讨论**。理由：

- 上游的 `CONTRIBUTING.md` 要求"大改动先开 issue 商量方案"，还要求小而聚焦的 PR、带测试、带界面截图。
- 适合给上游的只有通用部分：绑定接口 + hook 2、3、4。这些需要先做以下调整：
  - 改成英文提示。
  - 在 Bot 设置里加一个"绑定已有会话"的界面，现在只有本机接口。
  - 把 Codex 线程校验改成通过驱动去查。
  - 按上游的验证规范补全测试。
- 不适合给上游的：`dsh-acp` 预设补丁、`env.sh` 里的本机路径、`add-project-instance.mjs`。这些是这台电脑和 DeepSeek 当前版本特有的。
- hook 3 改变了上游"续接失败就新开会话"的默认行为，需要做成可选项（只对已绑定会话生效）。上游可能另有看法。

如果要推进，第一步是写一个 issue，讲清楚使用场景和上面的方案。是否提交由你决定。
