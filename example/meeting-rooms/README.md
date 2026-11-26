# 会议室预约后端

这个产品只依赖目录内锁定的 Action Workbench npm 候选包和 Zod，不引用框架源码。场地管理员登记会议室；员工可以查询空闲、预约、改期、取消；只读用户不能写。除了 Codex 模式，所有请求都不需要模型。不提供页面或公网登录系统。

## 在本机使用

使用带 npm 的 Node 22.x（至少 22.18.0）、24.x 或 26.x，在本目录执行：

```sh
npm ci
npm test
export ROOMS_USER_TOKEN="$(node -p "require('node:crypto').randomBytes(32).toString('hex')")"
npm run access -- grant demo alice manager
npm start                         # 或 npm run start:ai
```

服务默认 `http://127.0.0.1:4882`。保持同一环境变量，在客户端发送 `Authorization: Bearer $ROOMS_USER_TOKEN`。本地 `access` 命令按租户、用户管理 `viewer`、`staff`、`manager` 三种角色；重复 `grant` 更新角色或轮换令牌，`npm run access -- revoke demo alice` 立即撤销该身份。令牌只从环境读取，库内保存摘要。请为每个账号生成不同的随机令牌；不要把环境变量写入提交。数据目录默认 `.data/`，可用 `ROOMS_DATA_DIR` 改为私有目录。

```sh
base=http://127.0.0.1:4882
curl -sS -H "Authorization: Bearer $ROOMS_USER_TOKEN" "$base/_aw/openapi.json"
curl -sS -H "Authorization: Bearer $ROOMS_USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"roomId":"A","name":"海棠厅"}' "$base/rooms"
curl -sS -H "Authorization: Bearer $ROOMS_USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"roomId":"A","title":"预算讨论","startsAt":"2099-08-27T01:00:00Z","endsAt":"2099-08-27T02:00:00Z"}' "$base/bookings"
```

最后一个响应是提议。核对后发空请求 `POST /_aw/invocations/{调用编号}/confirm`，再 `GET /bookings` 查询本人预约。持有调用编号本身不授权。创建、改期、取消都需确认；房间登记是管理员手动操作，助手只可介绍。公开目录和 OpenAPI 按每次请求的最新身份生成。

## 日历与冲突规则

HTTP 时间用 UTC、精确到秒；对话中的本地时间默认中国标准时间。时段为左闭右开 `[startsAt, endsAt)`，相邻时段不冲突。其他租户可独立使用同样的房号，其他员工只能查本组织的空闲房，不会看见会议标题或负责人。`bookings.move` 保持房间和标题不变，并绑定原预约编号和版本。读到空房不是占位；确认时若被别人抢先预约，返回 `409 SLOT_CONFLICT`，不改约别处。旧版本返回 `409 BOOKING_CHANGED`。

`npm test` 包含两个进程共享私有测试库的并发用例、经助手提议后的冲突/撤权；不调用模型。`npm run test:ai` 使用本机已登录的真实 Codex，以合成预约验证歧义澄清、解释、修改与确认。该命令会将这些合成记录交给模型服务，使用账号额度；失败不回退到模拟模型。
