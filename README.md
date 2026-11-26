# Action Workbench · Node.js 业务后端 + 可选 AI

开发者定义一次业务，普通客户端用 HTTP，助手则依权限介绍或代办。运行时生成 OpenAPI 3.1.1 文档；不开模型也能办理全部普通业务。不包含页面、表单或聊天 UI。

**0.5.0-rc.2 是发包候选，不是稳定版。** 现在可以从[源码仓](https://github.com/Nn514-self/action-workbench)或仓内锁定的 `.tgz` 试用；只有 npm 上实际出现该版本后才能按包名安装。普通 HTTP 不需要 Codex 或模型账号。框架和随附模板采用 [MIT](https://github.com/Nn514-self/action-workbench/blob/main/LICENSE)。

## 用框架创建自己的后端

使用带 npm 的官方 Node.js **22.x（至少 22.18.0）、24.x 或 26.x**，生产选该系列最新安全补丁。不承诺支持奇数版或未来大版本。克隆源码后可直接运行：

```sh
npm ci && npm run build                     # 源码目录中编译一次；安装包内已有 JS 和类型声明
node bin/create-action-backend.mjs ../my-product
cd ../my-product
npm install
export WORKBENCH_TOKEN="$(node -p 'crypto.randomUUID()+crypto.randomUUID()')"
npm start                                   # 或 npm run start:ai
```

目标必须是新目录或空目录。生成的项目自带**当前框架的 npm 安装包**，不依赖全局安装、源码软链或尚未发布的 npm 版本。产品里的 `server.ts` 组装模块；`orders.ts`、`expenses.ts` 是可替换的业务，不在框架内核里。也可以直接在框架根目录设置同一环境变量并 `npm start` 体验。服务默认仅监听 `127.0.0.1:4881`，根路径不是网页。

不用编译也能从仓库中已打好的包建项目。在仓库根目录执行：

```sh
npm exec --yes --package=./example/meeting-rooms/action-workbench-0.5.0-rc.2.tgz -- create-action-backend ../my-product
```

等维护者正式批准该版本上架后，可把 `--package=...` 换成 `--package=action-workbench@0.5.0-rc.2`。安装已有服务的依赖则使用 `npm install --save-exact action-workbench@0.5.0-rc.2`。这是 ESM 包；公开入口为 `action-workbench`、`/http`、`/assistant` 和 `/codex`，均带 TypeScript 声明。

Windows PowerShell 用 `$env:WORKBENCH_TOKEN = node -p "crypto.randomUUID()+crypto.randomUUID()"`；若执行策略阻止 `npm.ps1`，使用 `npm.cmd`，不用放宽策略。数据目录应有当前账号专用的 ACL。可选模型需真实 `codex.exe`（绝对路径 `CODEX_BIN` 或放入 PATH），不执行 `.cmd` / `.ps1` 包装。**Windows Server 2025 x64 的普通后端有 [rc.1 原生记录](https://github.com/Nn514-self/action-workbench-windows-checks/actions/runs/45656936948)，不是 rc.2 的全平台认证。** 官方 Codex 0.147.0 不支持所需隔离参数，0.172.0 在 Windows 上仅证实能启动，完整参数及已登录账号对话未验证；没有模型时仍可用普通 API。

## 开发一个动作

```ts
import { z } from 'zod';
import { defineModule, query } from 'action-workbench';

export const shipping = defineModule('shipping', {
  quote: query({
    description: '按整公斤查询普通快递运费，结果单位为分。',
    http: { method: 'GET', path: '/shipping/quote' },
    permission: 'shipping:read', ai: true,
    input: z.strictObject({ kg: z.coerce.number().int().min(1).max(20) }),
    output: z.strictObject({ cents: z.int() }),
    modelOutput: z.object({ cents: z.int() }), // 只将该字段给模型，不跟随 HTTP 输出自动增加
    run: (_ctx, { kg }) => ({ cents: 800 + (kg - 1) * 200 }),
  }),
});
```

把 `shipping` 放入 `createBackend({ database, modules: [...] })`，给相应身份授予 `shipping:read`。此时 `GET /shipping/quote?kg=3` 和助手的 `shipping.quote` 共用业务函数。不改路由总表、模型代码或提示词。输入必须是严格对象；路径、查询串和 JSON 对象按字段合并，重复字段报 `400`，不会互相覆盖。路由中的 `:id` 必须在输入 schema 中声明。命令不能使用 GET；重复模块、冲突路由和 `/_aw` 保留路径启动时拒绝。

写操作有两种：只修改框架所在 SQLite 数据库，用 `sqliteCommand(db, {...})`；调用外部服务、其他数据库或异步任务，用 `command({...})`。两者的权限、HTTP、AI、确认参数相同。`run({ actor, invocationId }, input)` 的身份来自认证回调，不来自业务输入。动作权限不代替数据归属检查：订单更新 SQL 同时限定租户、用户、订单编号与当前状态。`query` 必须只读；框架无法识别业务函数是否偷偷写库或发起网络请求。

**助手能介绍什么，不等于它能做什么。** 每个动作的 `ai` 只有一处配置。省略或 `false`：对模型完全隐藏；`'describe'`：只给有权限的用户介绍，不能调用；`true`：可介绍、可发起。仓库员工能从助手了解 `orders.ship`，但发货只能走普通接口；没有 `orders:ship` 的员工在介绍目录和接口文档里都看不到它。模型不会收到仅介绍动作的路由或参数。`description` 应当写给获准知情的用户，不要写内部运维细节。

**能办业务也不等于能把整条记录发给模型。** `output` 是授权用户的 HTTP 结果；`modelOutput` 是在该结果上再次解析的模型视图。比如 HTTP 可看 `{orderId, status, billingNote}`，而模型只应看 `z.object({orderId:z.string(), status:z.string()})`。嵌套对象也要逐层挑字段；不要用 `z.any()`、透传对象或整份账单代替白名单。可调用查询没有视图，模块拒绝注册。命令默认只告诉模型状态；显式定义视图才分享成功结果。校验失败、旧版本回执或业务错误不会回退到原始数据。用户消息、动作描述、可调用动作的参数结构、模型提交的提议参数仍可能发给模型服务；不要在这些位置放凭据或未获准外发的数据。

## 两个入口怎样接手同一笔业务

所有端点都需要 `Authorization: Bearer $WORKBENCH_TOKEN`。在同一环境中发请求，例如：

```sh
curl -sS -H "Authorization: Bearer $WORKBENCH_TOKEN" http://127.0.0.1:4881/_aw/actions
curl -sS -H "Authorization: Bearer $WORKBENCH_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: first-expense' -d '{"title":"差旅","amount":"46.50"}' \
  http://127.0.0.1:4881/expenses
```

业务路由返回 `{id,action,status,result?}`；`id` 是**调用编号**，不是 `result.id` 里的单据编号。费用模块提供创建、查询、提交、撤回；订单模块提供下单、查询、取消和 HTTP 专用的标记发货。示例不收费、不发出外部审批或物流通知。

| 接口 | 行为 |
| --- | --- |
| `GET /_aw/actions` | 发现当前身份可用的业务动作。模型另取 `ai: true` 且有权限的子集。 |
| `GET /_aw/capabilities` | 当前身份可由助手介绍的功能；`mode: manual` 需手动办理，`assistant` 可代办。 |
| `GET /_aw/openapi.json` | 此身份实际有权调用的 HTTP 路径、参数、输入、结果与确认回执。GET 非路径字段放查询串，其他方法的非路径字段按 JSON 对象发送。不要公开缓存这份文档。 |
| `POST /_aw/assistant/messages` | JSON `{message,conversationId?}`；返回聊天回复或 `202` 和实际待确认调用。未启用模型为 `503 AI_DISABLED`。 |
| `GET /_aw/invocations/pending` | 找回当前用户仍可确认的 HTTP 和 AI 请求，不需要对话编号，也不调用模型。支持 `limit` 和 `cursor`。 |
| `POST /_aw/invocations/:id/confirm` | 仅提交空请求，针对原用户、原租户、原动作版本和原始参数重新鉴权及执行。模型没有这个工具。 |
| `POST /_aw/invocations/:id/cancel` | 只取消未执行提议；不能回滚已办业务。返回实际状态，已取消状态对应 HTTP 409。 |
| `GET /_aw/invocations/:id` | 读自己的**命令**回执。即时查询不存日志；他人及其他租户不能读取或确认。 |

命令默认 `confirmation: 'required'`；低风险业务可给普通 API 声明 `'none'`。**AI 发起的所有命令仍必须确认。** 例如：HTTP 提交费用单并确认 → 在 AI 模式说“撤回编号 1 的费用单” → 核对 `invocation.input` → 用该调用编号确认 → `GET /expenses` 看到同笔单据变回草稿。若确认订单取消前订单已发货，最终回执是业务拒绝而非成功。

待确认时仍可在同一个 `conversationId` 下提问。普通答复为 `200 {type:'reply', text, pending?}`；`pending` 是后端当前真实提议。若明确要求改参数，助手可返回新的 `202` 提议。旧 ID 与新 ID 在同一事务里交替生效；旧 ID 确认返回 `409 cancelled`。相同参数不换 ID、不延长有效期；输入不合法不撤旧提议；不能换动作或路径绑定的业务对象。若旧提议已被别人确认，本轮返回 `409 PROPOSAL_CHANGED`，不另建一笔。聊天文本“确认”不是授权。

**对话断了怎么办？** 重新登录，以 `GET /_aw/invocations/pending?limit=20` 取回 `{items, nextCursor}`。每项包括 `id`、动作、来源 `source`、原始 `input`、创建和过期时间（毫秒）。核对参数后用 `id` 确认或取消。`nextCursor` 非空时原样传给下一页，最多每页 100 条。列表按创建时间倒序；过期、无权限、旧动作版本、已关闭 AI 暴露的 AI 提议都不显示。分页期间新提议从第一页查看。这不是管理员审计接口，也不允许模型自行确认。

## 存储、幂等与故障边界

- 使用 `node:sqlite`；模板将业务记录、模块迁移和命令回执写到 `.data/product.sqlite`（可用 `ACTION_DATA_DIR` 改目录）。`migrate(db, moduleName, sqlSteps)` 按顺序在事务内迁移，禁止悄悄修改已执行的步骤。业务函数也可以使用自己的数据库或外部 API。
- 命令可带 `Idempotency-Key`。同一用户和租户重放同一请求返回原调用；相同键改动作、版本、入口或参数会被拒绝。确认默认五分钟过期；多个请求竞争同一确认时只有一个能领取执行。对改变语义的动作递增 `version`，旧提议不能按新规则执行。
- **本地写入**：`sqliteCommand(db, {...})` 的业务 SQL 和终态回执在同一事务提交。业务拒绝会撤销本次全部 SQL 并保留拒绝原因；输出校验等程序异常同样回滚，回执为 `failed / ACTION_ROLLED_BACK`。进程若在提交前退出，原 AI 提议仍待确认（未过期时），普通直接命令可凭**同一个幂等键**重试。提交后只丢响应，重放读到原回执。模块与框架必须使用同一 `DatabaseSync` **连接实例**，即使两个连接指向同一文件也不行。
- 本地处理函数和校验必须短小、同步；不要启动后台任务、自行提交事务或从中发送邮件、扣款。事务不覆盖进程内存、文件、网络或其他连接。**外部写入**仍用 `command`：仅在确定业务被拒绝时抛 `ActionError`；不确定下游是否已执行时是 `unknown`，崩溃可能留下 `running`。框架不盲重试，以 `invocationId` 和下游对账，不提供跨系统恰好一次。
- SQLite 文件应私有；调用参数、结果、幂等键不要携带凭据。部署方负责保留期、备份和容量。
- 助手会话是单实例内存状态，重启丢对话，不丢提议或回执。`ModelProvider.decide(turn, signal)` 返回 `reply`、`call` 或 `revise`。适配器应把 `signal` 传给下游。内置本机 Codex 默认 `gpt-6.2-sol`，可用 `CODEX_BIN`、`CODEX_MODEL` 调整；启动本机 CLI 不等于离线推理。
- `createHttpServer(backend,{authenticate,provider,assistantLimits:{maxConcurrent:4,maxConcurrentPerUser:1,turnTimeoutMs:120000}})` 展示默认预算。不排队；实例或同租户同用户达到并发上限返回 `429 MODEL_BUSY`；一个对话不能交叉提交。单轮最多 5 次模型决定，整轮超时 `504 MODEL_TIMEOUT`；HTTP 客户端断开也会发取消信号。迟到的决定不能生成新提议；忽略取消信号的适配器在真实返回前仍占名额。已经产生的提议可查待办，取消聊天不回滚业务。
- 会话空闲 30 分钟过期，每用户最多 16 个，每实例最多 1000 个。单事件及决定上限 16 KiB、历史 32 KiB、发给模型的整轮上下文 128 KiB（JSON 字节，不是 token）。工具结果超限只给模型错误码。这里限的是单实例并发与上下文，不是跨实例限流、费用上限或对第三方模型停止计费的保证。
- 模板只提供本机单用户 Bearer 认证。生产宿主应替换 `authenticate`，接入真实权限、TLS、网关限流及监控。浏览器写请求需配置 `allowedOrigin` 为一个完整、精确的 HTTP(S) 源；带 Cookie 写入即使没有 `Origin` 也拒绝。不带 Cookie/Origin 的服务端 Bearer 客户端不受影响。Cookie 仍应使用适当的 `Secure`、`HttpOnly`、`SameSite` 与宿主会话防护。不要直接对公网开放模板。

## 开发与升级

`npm test` 编译包、检查完整示例类型并运行行为测试；`npm audit` 检查依赖公告。0.2 是对旧 `createActions` / 全局动作名 / HTML 工作台的破坏性替换，不提供旧执行接口绕过确认。旧示例 `.data/expenses.sqlite` 不会被打开、删除或自动导入。

**从 0.2 升到 0.3**：停旧实例，做一致性数据库备份，替换框架包并重启。首次启动只追加待确认索引；历史业务记录、幂等键和回执保留。旧 `command` 不会被静默改成事务命令，只有将纯同库动作显式改为 `sqliteCommand(db, {...})` 才获得本地原子性。若要退回 0.2，使用升级前备份；迁移器会拒绝用旧版本打开更高版本的库。

**0.4 升级说明：** 无新增数据库迁移；原有 `ai: true/false` 语义不变。输出 schema 需能表示为 JSON Schema；转换后返回值请用明确的输出 schema（例如 `.transform(...).pipe(z.int())`）。既有模型适配器仍可只返回 `reply/call`；要支持修改提议，另实现 `revise`。跨版本替换需同一批服务使用一致的动作定义。

**从 0.4 升到 0.5 候选版：** 无新增数据库迁移。逐个修改 `ai:true` 的查询，添加显式 `modelOutput`；若数据不应外发，改成 `ai:'describe'` 或关闭 AI。命令无须修改，除非确认后确需给模型看特定结果。自定义模型提供方应支持取消；Cookie 客户端要配置可信 Origin。先在独立副本用业务权限和实际字段验证，再升级所有实例。

**兼容性检查：** `npm run compat:check` 安装与独立示例锁文件 SHA-512 完全一致的包。先用真实的 0.4.0 旧包创建业务记录、幂等回执和一笔 AI 待确认操作，再用新包的 CLI 在含空格和中文的目录生成产品、类型检查，并启动真实服务读取同一份库。它验证未认证请求被拒绝、无模型时 HTTP 可用、历史请求重放不重复写、旧提议重复确认只产生一次业务效果，以及升级后能继续下单。使用临时数据库和随机端口，不接触已有数据。先运行 `npm test`，再运行 `npm run compat:check -- --verify-build`，可逐文件比对候选包与当前编译结果，避免误测旧包。

`.github/workflows/compatibility.yml` 对 Ubuntu、macOS、Windows 原生 runner 运行以上检查以及框架测试：每个平台覆盖 22.18.0 和 22/24/26 各线当前补丁，另测 Linux 的 24.0.0、26.0.0。所有 runner 安装同一份候选包，不能在测试时重写锁或重新打包代替它。工作流写好不代表平台已通过；公开宣称某个平台受支持前，要拿到对应版本的实际成功记录。矩阵不需要模型账号，也不是各平台实际 Codex 登录的验收。

## 发包前如何验收

在源码根目录运行 `npm run release:public-check`（需要受支持的 Node、npm、tar 和 Gitleaks 8.x）。它在干净目录按锁安装、编译、运行框架和独立产品测试并审计依赖；再检查归档白名单、字节和密钥，试装生成产品、发真实 HTTP 请求、验证旧库升级。最后对**同一份归档**执行离线 `npm publish --dry-run`，比较 SHA-512。成功后根目录输出 `.tgz`；此命令既不上传 npm，也不创建待审批包。

- 候选包版本或字节有意改变时，同步 `example/meeting-rooms/package.json` 的本地包名及 `.gitignore` 中该归档的跟踪例外，运行 `npm run release:check -- --refresh-example` 更新示例归档与锁文件；普通检查不刷新示例锁。固定的 `action-workbench-0.4.0.tgz` 是升级基线，勿替换。需实测已登录的本机 Codex 时可加 `--with-codex`，该选项会把合成场景发给模型服务。
- 发布条件：公网 npm registry、公开访问、预发布通道 `next`（不是默认稳定通道 `latest`）、经确认的许可证、真实源码仓和 Issues。预检不会验证登录、2FA、包名最终分配或写入权限；`404` 不会保留包名。源码目录直接 `npm publish` 会由生命周期脚本拒绝，这是防误操作，不是 registry 权限控制。
- **首次发包是另一个明确动作。** 维护者先在自己的终端 `npm whoami --registry=https://registry.npmjs.org/`，核对账号、开启 2FA、复核预检的完整 SHA-512。若采用 [npm 的待审批发布](https://docs.npmjs.com/staged-publishing/)，用 npm ≥11.15.0 对**已验证的文件**执行 `npm stage publish ./action-workbench-0.5.0-rc.2.tgz --registry=https://registry.npmjs.org/ --access=public --tag=next`；不要重新从目录打包。**这一步已上传，首次还会生成公开的 `0.0.0-stage` 占位版本，不是演练。** 复核待审批版本、通道、摘要后再用 2FA 批准。正式上架后比较 `npm view action-workbench@0.5.0-rc.2 dist.integrity --registry=https://registry.npmjs.org/` 与本地记录；不要自动改 `latest`，也不要覆盖同一版本。后续可配置[仅允许 stage 的可信发布](https://docs.npmjs.com/trusted-publishers/)，不必在 GitHub 保存长期 npm 写入 token。

**独立产品验收：** 源码发布目录中的 `example/meeting-rooms/` 是独立 npm 项目，依赖本地 `.tgz` 而非框架源码。进入该目录执行 `npm ci && npm test`；已登录本机 Codex 时，另可 `npm run test:ai`。角色、房间和预约规则全部属于该产品，并非框架内置功能。
