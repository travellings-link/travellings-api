# Hybrid Random MVP

独立服务，使用官方仓库的 `webs` 表和现有 Sequelize/MySQL、Redis 依赖。Redis 固定使用 DB 5 保存可消耗的随机候选预取批次，Bloom 历史仍保存在 Cookie。只提供随机选站以及健康、统计接口；生产 `app.js`、`modules/router.js` 和原 `/random` 路由不变。

## 启动

要求 Node.js >= 18、MySQL >= 8.0、支持 DB 5 的独立 Redis（建议 >= 7.0；Redis Cluster 不支持多 DB）。无需 GitHub、Telegram 配置。

```powershell
pnpm install --frozen-lockfile
Copy-Item mvp/random/.env.example mvp/random/.env
# 编辑 mvp/random/.env，填入独立只读账号
pnpm start:random-mvp
```

默认监听 `127.0.0.1:14515`，使用一个进程。启动前验证 MySQL 表和列访问权限，连接 Redis DB 5 并执行 PING；任一依赖失败则退出，不启动 HTTP 服务。支持 SIGINT/SIGTERM 优雅退出：先停止接单和启动新补池，再等待完整补池流程（包括发布、解锁的 finally），最后关闭 Redis/MySQL。HTTP 客户端提前断开不会绕过逻辑任务的 drain。10 秒 HTTP 强制断连仅用于收尾网络连接，不会跳过补池等待而提前关闭数据连接。

仅加载 `mvp/random/.env` 和进程中的 `RANDOM_MVP_*` 环境变量，不读取主线 `.env`，不回退使用主线 `DB_USER/DB_PASSWORD`。可用 `RANDOM_MVP_ENV_FILE` 指定独立环境文件；相对路径基于启动工作目录。

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `RANDOM_MVP_HOST` | `127.0.0.1` | 监听地址 |
| `RANDOM_MVP_PORT` | `14515` | 独立端口 |
| `RANDOM_MVP_DB_HOST` / `RANDOM_MVP_DB_PORT` | `127.0.0.1` / `3306` | MySQL 地址 |
| `RANDOM_MVP_DB_NAME` / `RANDOM_MVP_DB_USER` | 必填 | 数据库及专用只读账号 |
| `RANDOM_MVP_DB_PASSWORD` | 空 | 只读账号密码 |
| `RANDOM_MVP_DB_POOL_MAX` | `4` | 最大连接数，上限 16 |
| `RANDOM_MVP_QUERY_TIMEOUT_MS` | `2000` | MySQL SELECT 执行超时，毫秒 |
| `RANDOM_MVP_QUERY_CLIENT_TIMEOUT_MS` | 服务端执行超时 + `1000`，默认 `3000` | 每次 mysql2 操作的客户端截止时间，超时销毁连接和底层 socket |
| `RANDOM_MVP_MAX_IN_FLIGHT` | `8` | 同时处理的随机请求数，上限 64；超限立即返回 503 |
| `RANDOM_MVP_COOKIE_SECURE` | `false` | HTTPS 部署须设 `true`，包括代理终止 TLS 的情况 |
| `RANDOM_MVP_REDIS_HOST` / `RANDOM_MVP_REDIS_PORT` | `127.0.0.1` / `6379` | 独立 Redis 连接 |
| `RANDOM_MVP_REDIS_USERNAME` / `RANDOM_MVP_REDIS_PASSWORD` | 空 | Redis ACL 账号或密码 |
| `RANDOM_MVP_REDIS_DB` | `5` | 固定 DB 5；其他值启动时报错 |
| `RANDOM_MVP_REDIS_TIMEOUT_MS` | `1000` | Redis 命令等待上限，毫秒 |
| `RANDOM_MVP_CACHE_TTL_SECONDS` | `30` | 随机预取池过期时间，上限 300 秒 |

MySQL 连接完整握手和连接池获取超时均为 5 秒，不自动重试查询。服务端执行超时限制 MySQL 的 SELECT 执行时间；客户端截止时间单独保护 mysql2 的 `query` 和 `execute`，也覆盖会话初始化、版本探测、健康检查及预编译准备阶段。它们是各阶段期限，不是整个 HTTP 请求的单一截止时间。

客户端操作超时会先标记连接不可复用、调用驱动销毁方法并显式 `stream.destroy()`，再以 `RANDOM_MYSQL_CLIENT_TIMEOUT` 结算挂起回调；迟到回调被忽略。Sequelize 的 `afterQuery` 随后将坏连接从池中移除，新请求重新建立会话。这不是仅对外层 Promise 限时：底层客户端 socket 会关闭。补池 Promise 因此拒绝，进程内补池记录、Redis 锁和所有等待请求的并发槽在原有 `finally` 中释放。客户端断连无法保证远端在同一时刻停止计算，因此仍保留 MySQL 服务端执行超时。

Redis 启动连接等待最多为命令超时的两倍；运行中会自动重连，断线期间不排队命令，内部待处理命令上限 64。Redis 变更操作超时返回 `RANDOM_REDIS_TIMEOUT`，包含操作名及 `outcomeUnknown: true`：客户端不知道远端是否已执行，不能当作确定失败而重试。

- `SET NX PX` 获取锁也位于补池 `try/finally` 中；只要尝试过获取，就按唯一令牌尽力释放，即使没收到成功确认。
- 若超时后收到迟到的 `OK`，会额外尝试一次令牌校验释放，不能删除新持有者的锁。关闭期间不再启动新的迟到清理。
- 首次清理完成后仍可能出现迟到的 SET；若成功确认永久丢失，第二次清理也无法启动。因此 **PX TTL 始终是必要兜底，finally 不保证锁一定被立即清除**。
- `LPOP` 可能已消费批次，超时后不重试、不放回；迟到结果直接丢弃。发布可能已提交，超时后本请求返回失败，不重复发布或再次查 SQL；后续请求可以正常消费已发布批次。
- Redis 关闭会等待已启动且有期限的操作、迟到清理结束，再断开客户端；不会无限等待永远没有确认的底层命令。此类远端结果仍受令牌和 TTL 约束。

Redis 锁过期不承担 MySQL 查询取消职责。

## 只读连接

数据库管理员应预先配置一个仅对目标表具有 `SELECT` 权限的专用账号，例如将以下占位符替换后执行：

```sql
CREATE USER 'travellings_random_readonly'@'<MVP来源地址>' IDENTIFIED BY '<独立密码>';
GRANT SELECT ON `<数据库名>`.`webs` TO 'travellings_random_readonly'@'<MVP来源地址>';
```

MVP 不创建账号、不修改权限、不执行 `sync()`、迁移或任何数据写入，也不导出原始连接/写模型。每个新连接在进入连接池前执行：

```sql
SET SESSION transaction_read_only = 1, max_execution_time = <配置毫秒数>;
```

初始化失败会销毁连接并报错。会话只读是额外约束，账号的 SELECT-only 权限才是数据库权限边界。启动及 `/health` 使用 `SELECT id, status, name, link, tag FROM webs LIMIT 0` 检查所有使用到的列，不读取站点数据。

## 接口

| 方法与路径 | 行为 |
| --- | --- |
| `GET /random` | 随机选站，沿用主线 JSON 返回格式 |
| `GET /random?tag=blog` | 保留主线的 `tag LIKE '%blog%'` 筛选语义 |
| `GET /health` | 检查 MySQL 表和 Redis 连通性，标明 Redis DB 5；正常 200，任一异常 503 |
| `GET /stats` | JSON 内部统计与算法参数 |
| `GET /metrics` | Prometheus 文本格式计数器和耗时直方图 |

Redis 故障时 `/random` 返回 503，不让所有请求直接回源 MySQL。`/stats` 和 `/metrics` 使用本地内存，在 Redis 故障时仍可读取。

选站成功示例：

```json
{"success":true,"data":[{"id":142,"name":"站点名","url":"https://example.com","tag":"blog"}]}
```

与主线一致，由调用方根据 `url` 完成跳转。无候选返回 HTTP 200 和 `success:false`；非法 `tag` 类型或超过 255 字符返回 400；查询异常或并发超限返回 503。`HEAD /random` 返回 405，避免静默推进历史。除这些运行接口外，其他路径返回 404，没有管理或写入接口。

响应均设置 `Cache-Control: no-store`。沿用主线对 `travellings.cn` 及其子域的 Origin 白名单和凭据支持。跨 origin 的浏览器调用需使用 `credentials: 'include'`；统计接口应仅通过内网或受控代理访问。

默认绑定回环地址。若改为对外监听，入口限流、TLS 和统计接口访问控制由部署层配置。

## Redis DB 5 随机预取

缓存按查询条件隔离，键前缀固定为 `travellings:random-mvp:v1:`，后接查询条件的 SHA-256；不会使用主线 Redis 客户端，也不执行 `KEYS`、`FLUSHDB` 或 `FLUSHALL`。仅写自身前缀下的候选队列与短期锁。

请求先用原子 `LPOP` 取走一个候选批次。命中时不查询 MySQL；耗尽或过期时，通过带唯一令牌和过期时间的 `SET NX PX` 锁协调补池。进程内同时合并同条件补池，跨进程通过 Redis 锁协调。Lua 校验锁所有者后原子发布批次、设置 TTL、释放锁，过期持有者不能覆盖新池或删除新锁。

每个缓存未命中请求使用单调时钟建立一次绝对等待期限，默认 3 秒；等待同进程补池、抢批失败后重新检查、跨进程抢锁都不重置预算。跟随者到期会结束自己的等待，不取消补池者的 SQL；补池者的 SQL 仍由底层客户端超时保护。已在途的 Redis 命令及令牌清理受各自操作超时限制，可能在等待预算后短暂收尾。

只有补池者执行一次只读查询：

```sql
SELECT id, name, link, tag FROM webs
WHERE status = 'RUN' -- 有 tag 时再追加参数化的 LIKE 条件
ORDER BY RAND() LIMIT 64;
```

- 返回 64 行时，按数据库随机顺序分为 8 批，每批 8 个；当前请求使用第一批，其余 7 批缓存并逐批消耗，避免所有用户长期复用固定的 8 个站点。
- 返回少于 64 行时，已取得全部符合条件的站点；从整个小池分别随机采样，生成 8 批，每批最多 8 个。空池也缓存空批次，避免连续空查询反复回源。
- 一个批次只能被一个请求取走。当前批次未被最终选中的站点不写入用户 Bloom，也不会放回队列。
- 每请求交给 Bloom 的候选仍为 0–8 个；缓存命中 0 次 SQL，补池最多 1 次 SQL，没有 COUNT、OFFSET 或 SQL 重试。连接初始化、启动和健康探测另外执行。
- 缓存 TTL 默认 30 秒，读取不续期。主线的站点更新暂未通知 DB 5，因此状态、链接、标签变更可能延迟一个缓存周期反映；需要更快生效时降低 TTL，后续合并可接入更新失效通知。
- 健康稳定、同条件连续消费完整 8 批且未过期时，一次 SQL 可供 8 个请求使用；实际效果以缓存命中和回源计数衡量。

Redis ACL 需要允许所用前缀及 `SELECT/PING/GET/SET/LPOP/RPUSH/EXPIRE/DEL/EVAL` 操作。DB 5 是逻辑数据库，内存仍属于同一个 Redis 实例。

## Bloom 算法与历史

按数据库随机顺序检查候选，选择 Bloom 未命中且不等于 `lastId` 的首个站点。只把最终返回的站点写入历史。

- 正常轮换：已经成功返回 15 次，下次请求清空 Bloom、次数归零，保留 `lastId`。
- 同批兜底：实际返回的候选全部无法通过过滤，清空 Bloom，在同批中优先选择非旧 `lastId` 的站点。选中结果立即加入新 Bloom，次数为 1。
- 无候选：沿用空结果响应，不算兜底或异常，不更新 Cookie。
- 只有一个候选：必要时允许重复，仍然只查询一次。
- Cookie 缺失、过期或损坏：整个历史重新初始化，不信任旧 `lastId`。

Cookie 名为 `_tvl_mvp`，避免与同域生产站点互相覆盖，路径 `/random`，HttpOnly、SameSite=Lax，有效期为最近一次成功返回后 15 天。内容为版本、40 字节 Bloom 的 Base64、成功次数、`lastId` 和更新时间；不存 IP/UA。校验长度、版本、编码、数值范围与时间。Cookie 不作为权限凭据；即使位图全部置位，也只能影响本次选站偏好，无法增加数据库查询次数。

所有标签共享同一浏览器历史。Bloom 参数为 320 bits、6 hashes。这是按轮次近似去重：存在误判，批次全部命中也不代表全库耗尽。多标签页并发可能覆盖 Cookie，这是接受的设计边界；不引入服务端匿名用户会话或集中历史存储。

## 统计含义

指标保存在当前 MVP 进程内，重启归零，不保存 IP、站点或 tag 等标签。

| 指标 | 定义 |
| --- | --- |
| `random_requests_total` | 进入随机路由的 GET 请求数，包含无候选、非法参数、繁忙和异常 |
| `random_bloom_hits_total` | 实际检查时 Bloom 命中的候选次数；每候选每请求最多一次，未检查的候选不计 |
| `random_fallback_total` | 触发同批兜底的请求数，每请求最多一次 |
| `random_query_duration_seconds` | 实际 MySQL 候选查询端到端耗时直方图，包含连接池等待、网络和失败查询，单位秒；缓存命中不记入 |
| `random_errors_total` | 随机请求的意外异常；Cookie 重建、无候选、正常兜底、非法参数和繁忙不计 |
| `random_cache_hits_total` | 请求第一次读取缓存即找到批次的次数，空批次也算命中 |
| `random_cache_misses_total` | 请求第一次读取缓存没有批次的次数，包含之后等待补池的请求 |
| `random_cache_refills_total` | 收到 Redis 成功发布确认的补池次数；超时结果未知的发布不计，实际提交量可能更高 |

仅因 `lastId` 相等但 Bloom 未命中的拒绝，不计 Bloom 命中。成功数达到 15 时的正常轮换不计兜底。健康探测与统计抓取不改变上述指标。直方图提供标准累计 buckets、`_sum`、`_count`，不直接声称服务器执行耗时或精确 p95。

`/stats` 的 `query_duration_source` 在真实服务中为 `mysql`，`candidate_source` 为 `redis-prefetch`，`cache` 显示 DB 5、预取数量和 TTL；测试的数据源明确标为 `mock`。SQL 耗时仅围绕实际回源调用计时，不包含 Redis 读取或等待补池。模拟测试用于验证去重与调用次数，不能据此判断 MySQL 在 2c4g 上的容量。性能评估应使用实际数据分别观察数据库 CPU、慢查询和接口延迟。

## 验证

```powershell
pnpm test:random-mvp
```

默认不连接外部 MySQL 或 Redis，覆盖算法状态转换、HTTP/Cookie/统计、过载保护、入口生命周期、真实 Sequelize 生成的 SQL，以及补池并发、TTL 和失败行为。还会启动本地临时 MySQL 协议故障服务端，让真实 mysql2/Sequelize 经 TCP 完成握手后故意收不到查询响应，验证 socket 销毁、连接池替换、8 个等待请求释放及后续请求恢复；这属于网络故障测试，不是真实 MySQL 数据库或性能测试。

`redisRaces.test.js` 用可控的变更执行/响应时序验证：获取锁成功但确认超时、清理后的迟到 SET、永久丢失确认的 TTL 兜底、LPOP/发布结果不确定、全局等待预算以及客户端断连后的完整补池关闭顺序。它属于竞态故障模拟，不代表已完成真实 Redis 联调。

真实 MySQL 联调默认跳过；配置专用只读账号后显式启用：

```powershell
$env:RANDOM_MVP_MYSQL_TEST = '1'
pnpm test:random-mvp
Remove-Item Env:RANDOM_MVP_MYSQL_TEST
```

真实联调只读现有表，并检查会话只读标志、执行超时与抽样上限，不创建测试表或写入数据。

Redis 联调也默认跳过，可单独启用。它使用唯一测试前缀的 DB 5 队列和短期锁，验证消费原子性、TTL、锁所有权及 DB 0 隔离；SQL 在该项测试中为模拟数据，不测 MySQL 性能。按实际 Redis 地址设置环境变量：

```powershell
$env:RANDOM_MVP_REDIS_TEST = '1'
$env:RANDOM_MVP_REDIS_HOST = '127.0.0.1'
$env:RANDOM_MVP_REDIS_PORT = '6379'
pnpm test:random-mvp
Remove-Item Env:RANDOM_MVP_REDIS_TEST
```

此联调读取进程中的 Redis 环境变量，不自动加载环境文件。服务启动仍按上文加载 `mvp/random/.env`。

保持 Cookie 的手动检查：

```powershell
curl.exe -c cookies.txt -b cookies.txt http://127.0.0.1:14515/random
curl.exe http://127.0.0.1:14515/health
curl.exe http://127.0.0.1:14515/stats
curl.exe http://127.0.0.1:14515/metrics
```

## 压测与灰度验收（待执行）

本节记录后续验收约束，不代表已完成真实压测或启用 Nginx 回退。当前 MVP 仍直接返回自身结果。

### 高基数 tag

按 tag 隔离缓存不会自动限制不同条件的查询速率。即使每请求最多回源一次、全局最多 8 个在途请求，持续的首次 tag 仍可持续消耗 MySQL。空批次缓存只对重复访问同一条件有收益；TTL 不能让不断变化的 tag 命中缓存。

使用相同数据库、请求率及并发阶梯，分别测试：

| 场景 | 核心观察 |
| --- | --- |
| 默认 `/random`，冷缓存与热缓存 | 基线回源量及缓存收益 |
| 少量合法热点 tag | 各条件命中与补池合并 |
| 大量不同合法 tag | 条件分散后的真实查询率 |
| 每请求不同的未知 tag，例如 `abc1/abc2/...` | 缓存收益接近消失时的持续负载 |
| 既有 LIKE 通配符条件，如 `%`、`_` | 大候选集查询及预取缓存占用 |
| 高基数 tag 与默认请求混合 | 默认路径是否被冷条件请求挤占 |

报告要同时记录实际请求率、SQL 查询率、缓存命中/补池数、MySQL CPU/慢查询、HTTP p95/p99/503、Redis 键数量与内存变化，以及停止负载后的资源恢复。Prometheus 标签不使用原始 tag；测试生成器在离线报告中记录唯一条件数。

区分并发保护与速率保护。若此场景超出容量，优先在入口设置总请求率或冷条件预算；tag 白名单/规范化涉及现有 LIKE 语义，应另行确认。不能依据仅默认路径的热缓存结果判断 2c4g 容量。

### 受控灰度期间的 Classic 回退

Hybrid 与 Classic 共用 MySQL。自动回退会重新访问该数据库，因此灰度回退必须同时具有：明确故障原因、MySQL 健康判断、回退速率/并发预算和最多一次尝试。预算及故障识别未验证前，默认关闭自动回退。

| Hybrid 结果/原因 | 灰度阶段建议策略 |
| --- | --- |
| 明确的 Redis 不可用，MySQL 正常且预算允许 | 可以尝试一次 Classic |
| MySQL 超时、连接失败或连接池压力 | 直接返回失败，避免再次查询同一数据库 |
| 并发超限、补池等待超时、服务排空中 | 默认返回失败，按独立运行策略处理 |
| 未分类的 503 或网关连接错误 | 默认不自动回退 |
| Classic 回退本身失败 | 结束请求，不在两个算法间循环重试 |

**当前 503 未提供足够的稳定故障分类，不能直接把所有 503 配成 `error_page 503 = @classic`。** 灰度接入前需增加由可信上游产生的分类信号，并测试网关确实按原因限量回退。Nginx 的错误拦截与内部转发只是机制，不能代替容量预算；参见 [proxy_intercept_errors](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_intercept_errors)。

网关日志至少区分以下字段（待灰度阶段实现）：

- `assigned_algorithm`：最初被分配到 Classic 或 Hybrid。
- `served_algorithm`：最终实际交付结果的算法，无结果时为 `none`。
- `gateway_fallback` / `fallback_reason`：是否尝试回退及有界原因分类。
- `request_id`、首次上游状态/耗时、回退上游状态/耗时、最终状态/总耗时。

保留完整上游状态与耗时链，不能仅记录最后一个 200；Nginx 的 [upstream_status](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#var_upstream_status) 可用于记录上游状态链。响应中的算法标记应由可信网关生成或覆盖，不能信任客户端自报值。

建议独立计数 `random_gateway_fallback_total{from="hybrid",to="classic",reason="redis_unavailable"}`。现有 `random_fallback_total` 只表示 Bloom 同批兜底，两者不得合并。

归因与验收约束：

- 分配给 Hybrid 后发生 503，即使 Classic 救回最终请求，也保留一次 Hybrid 失败样本；不能删除或改写为 Hybrid 成功。
- Classic 回退结果进入单独的回退组，不能混入最初分配给 Classic 的原生对照组。端到端可用性与 Hybrid 自身成功率分别报告。
- 主线 Classic 的业务失败可能返回 HTTP 200、`success:false`；压测客户端应校验 JSON，不能只用 HTTP 状态判断业务成功。
- Classic 回退不会更新 Hybrid Cookie 历史。混合算法序列的重复率与纯 Hybrid 序列分开报告，继续接受近似去重边界。
- 验证一次回退上限、网关与应用重试不叠加、tag 保留、预算耗尽后的行为，以及 Redis 恢复后重新进入 Hybrid。

正式替换 Classic 后需另行确定降级目标和容量预算，不能默认继承灰度回退规则。

## 后续接入主线

算法在 `modules/random/`，路由工厂在 `routes/public/hybridRandom.js`。主线确认后可以用现有 `webModel` 创建数据源，将原随机路由替换为：

```js
const { webModel } = require('../../modules/sqlModel');
const { createCandidateSource } = require('../../modules/random/source');
const { createHybridRandomRouter } = require('./hybridRandom');

module.exports = createHybridRandomRouter({
    findCandidates: createCandidateSource(webModel),
    cookieName: '_tvl',
    cookieSecure: true, // 按主线实际 HTTPS 部署配置
});
```

上面的示例是无缓存的最小接入方式。要保留预取，用 `createCandidateSource(webModel, { limit: PREFETCH_LIMIT })` 构造回源函数，再注入 `createPrefetchSource({ cache, prefetchCandidates, metrics })`，将其 `findCandidates` 交给路由；Redis 连接、预取池和算法均可分别复用。直接 SQL 模式的耗时可用 `measureCandidateQuery` 包装数据源，预取模式已在实际回源位置计时，避免重复计数。

MVP 入口、只读连接、健康与统计接口可以继续独立运行，无需一并接入主线；指标实例可由主线自行注入。原主线入口与业务路由在本阶段不变，也没有新增依赖或 MySQL 结构变更。

本阶段的客户端超时保护位于 `mvp/random/mysqlClient.js`，通过独立连接的 `dialectModule` 和 `afterQuery` 接入。将来合并主线时，要同时迁入这两处连接层接线，才能让主线连接获得相同的故障恢复能力；仅替换随机路由不会自动获得保护。
