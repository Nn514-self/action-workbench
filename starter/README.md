# 我的业务后端

这是独立的 Node.js 后端（22.x 从 22.18.0 起、24.x、26.x），不含前端。订单和费用模块可替换；`server.ts` 只负责组装模块、身份认证和可选模型。框架包已随项目打包，移动项目后仍可安装。

生成的项目默认 `private: true`。`LICENSE.action-workbench` 是框架及随附模板的 MIT 声明；分发这些代码时请保留，不替你选择自有业务代码的许可证。

```sh
npm install
npm run check
export WORKBENCH_TOKEN="$(node -p 'crypto.randomUUID()+crypto.randomUUID()')"
npm start       # 不联系模型；开启助手改用 npm run start:ai
```

令牌只保留在当前终端环境；运行客户端时使用同一个环境。API 默认 `http://127.0.0.1:4881`，所有请求都需要 `Authorization: Bearer $WORKBENCH_TOKEN`。不要将令牌放在 URL 或提交到版本库。

Windows PowerShell 使用 `$env:WORKBENCH_TOKEN = node -p "crypto.randomUUID()+crypto.randomUUID()"`。数据目录应只授权当前服务账号；Windows 不支持 POSIX 目录权限位。设置 `PORT=0` 可由系统分配空闲端口，启动输出显示实际地址。Windows 本机模型需可执行的 `codex.exe`，不是 `.cmd` 或 PowerShell 包装。

```sh
curl -sS -H "Authorization: Bearer $WORKBENCH_TOKEN" http://127.0.0.1:4881/_aw/actions
curl -sS -H "Authorization: Bearer $WORKBENCH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"item":"会议笔记本"}' http://127.0.0.1:4881/orders
```

增加模块时，只读用 `query`；仅写同一个 SQLite 连接用 `sqliteCommand(db, {...})`，业务改动和成功回执一起提交。涉及网络或异步调用用 `command`。HTTP 接口文档位于 `GET /_aw/openapi.json`。`ai: true` 开放代办，`ai: 'describe'` 只允许助手向有权限的人介绍，省略则完全不向助手披露。

给 `ai:true` 的查询加 `modelOutput`，只列允许传给模型的字段；`output` 保留完整的授权 HTTP 结果。命令确认后默认只把状态给模型。`query` 必须只读，任何需要确认的副作用都应声明为命令。

命令默认待确认。关闭聊天或重启后，用 `GET /_aw/invocations/pending?limit=20` 查自己的待办；核对返回的 `input`，再用 `POST /_aw/invocations/:id/confirm` 或 `/cancel`，不传新参数。`GET /_aw/invocations/:id` 可查具体回执。重发同一业务请求请沿用 `Idempotency-Key`。对话使用 `POST /_aw/assistant/messages`，JSON 为 `{"message":"我有哪些未发货的订单？"}`，追问带返回的 `conversationId`。

待确认时可以继续向助手问“这一步具体会改什么”。修改同一提议会返回新调用编号；显示新参数与新编号，不要沿用旧编号确认。

示例是单用户本机服务，业务数据在 `.data/product.sqlite`。部署前替换 `authenticate`，从可信身份系统解析用户、租户和权限；模型服务并非离线，勿对其开放未获授权的数据。完整接口与故障语义见安装包的 `node_modules/action-workbench/README.md`。

若改用 Cookie，写接口必须收到与 `createHttpServer` 的 `allowedOrigin` 精确匹配的 `Origin`。模型预算可用 `assistantLimits` 配置：默认每个用户 1 个、实例共 4 个并发、每轮 120 秒；这些限制不会占用普通 HTTP 的模型配额，也不代替多实例网关限流。
