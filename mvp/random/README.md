# Hybrid Random MVP

独立服务，使用官方仓库的 `webs` 表和现有 Sequelize/MySQL、Redis 依赖。Redis 固定使用 DB 5 保存可消耗的随机候选预取批次；两代 Rolling Bloom 历史保存在无状态 Cookie，未触发降级时稳态覆盖最近 20–39 次成功访问。初始批次和有界补采样均未选出站点时，优先成功返回，按明确规则放宽历史并允许重复。只提供随机选站以及健康、统计接口；生产 `app.js`、`modules/router.js` 和原 `/random` 路由不变，Classic 可以继续独立运行。

## 启动

要求 Node.js >= 18、MySQL >= 8.0、支持 DB 5 的独立 Redis（建议 >= 7.0；Redis Cluster 不支持多 DB）。无需 GitHub、Telegram 配置。

```powershell
pnpm install --frozen-lockfile
Copy-Item mvp/random/.env.example mvp/random/.env
# 编辑 mvp/random/.env，填入独立只读账号
pnpm start:random-mvp
```

默认监听 `127.0.0.1:14515`，使用一个进程。启动前验证 MySQL 表和列访问权限，连接 Redis DB 5 并执行 PING；任一依赖失败则退出，不启动 HTTP 服务。支持 SIGINT/SIGTERM 优雅退出：先停止接单和启动新补池、补查，再等待在途补查与完整补池流程（包括发布、解锁的 finally），最后关闭 Redis/MySQL。HTTP 客户端提前断开不会绕过逻辑任务的 drain。10 秒 HTTP 强制断连仅用于收尾网络连接，不会跳过逻辑任务等待而提前关闭数据连接。

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
| `RANDOM_MVP_RESAMPLE_MAX_IN_FLIGHT` | `1` | 每进程额外随机补采样的并发上限，范围 1–4；不排队 |
| `RANDOM_MVP_RESAMPLE_RATE_PER_SECOND` | `2` | 每进程补查令牌每秒补充数量，范围 1–1000 |
| `RANDOM_MVP_RESAMPLE_BURST` | `2` | 每进程补查令牌桶容量，范围 1–1000 |
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

与主线一致，由调用方根据 `url` 完成跳转。无候选返回 HTTP 200 和 `success:false`；非法 `tag` 类型或超过 255 字符返回 400；查询异常或总请求并发超限返回 503。补采样预算不足时直接同批降级，不因此返回 503。`HEAD /random` 返回 405，避免静默推进历史。除这些运行接口外，其他路径返回 404，没有管理或写入接口。

响应均设置 `Cache-Control: no-store`。沿用主线对 `travellings.cn` 及其子域的 Origin 白名单和凭据支持。跨 origin 的浏览器调用需使用 `credentials: 'include'`；统计接口应仅通过内网或受控代理访问。

默认绑定回环地址。若改为对外监听，入口限流、TLS 和统计接口访问控制由部署层配置。

## Redis DB 5 随机预取

缓存按查询条件隔离，键前缀固定为 `travellings:random-mvp:v1:`，后接查询条件的 SHA-256；不会使用主线 Redis 客户端，也不执行 `KEYS`、`FLUSHDB` 或 `FLUSHALL`。仅写自身前缀下的候选队列与短期锁。

请求先用原子 `LPOP` 取走一个候选批次。命中且有候选通过两代 Bloom 及 `lastId` 过滤时不查询 MySQL；候选队列耗尽或过期时，通过带唯一令牌和过期时间的 `SET NX PX` 锁协调补池。进程内同时合并同条件补池，跨进程通过 Redis 锁协调。Lua 校验锁所有者后原子发布批次、设置 TTL、释放锁，过期持有者不能覆盖新池或删除新锁。

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
- 初始批次为 0–8 个候选；补池最多 1 次 SQL，非空批次全部过滤时最多再执行一次独立 `LIMIT 64` 补采样。补采样结果最多拆成 8 批在内存过滤，不能循环回源。候选查询没有 COUNT、OFFSET、NOT IN 或自动重试。连接初始化、启动和健康探测另外执行。
- 缓存 TTL 默认 30 秒，读取不续期。主线的站点更新暂未通知 DB 5，因此状态、链接、标签变更可能延迟一个缓存周期反映；需要更快生效时降低 TTL，后续合并可接入更新失效通知。
- 健康稳定、同条件连续消费完整 8 批且未过期时，一次预取 SQL 可供 8 个请求使用；额外补采样另计。缓存命中不等于零 SQL，必须同时观察补采样查询率。

Redis ACL 需要允许所用前缀及 `SELECT/PING/GET/SET/LPOP/RPUSH/EXPIRE/DEL/EVAL` 操作。DB 5 是逻辑数据库，内存仍属于同一个 Redis 实例。

## Rolling Bloom 与有界补采样

Cookie 中保留当前代与上一代两个 Bloom，每个 320 bits、6 个哈希。按随机顺序检查当前批次，选择两个 Bloom 都未命中且不等于 `lastId` 的首个站点。只把最终成功返回的 ID 加入当前代，并增加当前代成功次数；拒绝的候选、失败和 503 均不推进历史。必要时允许下述同批降级，降级结果同样立即写入新的当前代状态。

当前代加入第 20 条后，立即将它作为上一代、丢弃更旧一代，并建立空的当前代、次数归零。未触发降级的连续序列在预热后保留最近 20–39 次成功事件，最近 20 次不会因正常轮换提前遗忘。正常轮换只清理一代；例如完成第 39 次后仍覆盖 1–39，第 40 次成功后只保留 21–40。降级放宽和全重置使用独立指标统计，不能混入正常轮换次数。

Cookie 名为 `_tvl_mvp`，路径 `/random`，HttpOnly、SameSite=Lax，成功响应后刷新 15 天有效期。格式为 `{ "v": 3, "bf": "当前代Base64", "prev": "上一代Base64", "n": 0, "lastId": 123, "t": 1793232000 }`；`n` 为 0–19。两个位图共 80 字节原始空间，JSON/Base64/Cookie 编码后有额外开销。Cookie 缺失、过期、损坏或版本不匹配时整个状态重新初始化；旧 v1 单 Bloom、未发布的 v2 精确队列都不迁移。所有 tag 共享同一份 Cookie 历史，不保存 IP、User-Agent、设备指纹、ID 队列或服务端用户会话；Redis 只保存公共随机候选。

这是近似滑动窗口：Bloom 可能误判，且轮换前会额外过滤部分超过最近 20 次的历史。在有效 Cookie、串行请求且相关历史没有被降级放宽时，正常轮换保留最近 20 次。优先成功返回的降级规则明确允许最近 20 次重复，因此本版本不提供无条件的严格窗口去重保证。多标签页同时使用旧 Cookie 也可能重复或覆盖历史，这是接受的无状态边界。

非空初始批次全部过滤时，预算允许则执行一次独立只读补采样：

```sql
SELECT id, name, link, tag FROM webs
WHERE status = 'RUN' -- 保留当前 tag 的 LIKE 条件
ORDER BY RAND() LIMIT 64;
```

最多 64 个结果在内存分成最多 8 批，以相同两代 Bloom 和 `lastId` 规则继续选站。补采样不使用 `NOT IN`，不将位图当作可恢复的 ID 列表，也不把结果写入公共 Redis 池。

- 找到通过过滤的站点：正常返回并写入当前代。
- 补采样返回空集或所有结果仍被过滤：从原始同批候选执行降级，不继续查询。先找非 `lastId` 且当前代未命中的站点；存在则仅清上一代、保留当前代与次数。否则从同批优先选择非 `lastId` 的站点，清两代并将次数归零。若只有上一站可选则允许重复。选中后立即加入当前代并推进次数；全重置后的次数为 1。
- 补采样并发槽或令牌不足：不排队、不执行 SQL，直接按相同的原始同批规则降级成功返回。
- 查询超时、连接错误、非法结果、Redis 故障或服务正在关闭：返回 503，不放宽历史、不写 Cookie、不重试 SQL。
- 初始预取批次为空：沿用 HTTP 200、`success:false` 空结果响应，不补采样、不更新 Cookie。站点变更的缓存可见性仍受 30 秒 TTL 约束。

补采样采用进程内独立并发限制和令牌桶，默认最多 1 个在途查询、每秒补充 2 个令牌、容量 2；不会扩大 MySQL 连接池。多个实例须分摊整体数据库预算。查询继续受服务端执行超时、连接池获取超时及真正销毁 socket 的客户端期限保护。

小候选池被两代完全覆盖时，通过上述放宽历史继续返回站点，不会仅因全池 Bloom 命中而持续 503。全部命中仍不能证明真实候选耗尽；降级是可用性选择，可能由误判、额外保留的旧代或补采样额度不足触发。只有依赖故障、非法结果、关闭或总请求并发超限等条件继续返回 503。88 站点验收不能替代小池、误判和补采样额度耗尽测试。

## 统计含义

指标保存在当前 MVP 进程内，重启归零，不保存 IP、站点或 tag 等标签。

| 指标 | 定义 |
| --- | --- |
| `random_requests_total` | 进入随机路由的 GET 请求数，包含无候选、非法参数、繁忙和异常 |
| `random_bloom_hits_total` | 实际检查的候选中，至少一代 Bloom 命中的次数；同时命中两代只计一次，未检查的候选不计 |
| `random_fallback_total` | 实际通过原始同批降级选站的请求数，不等同于补采样尝试数 |
| `random_history_relaxations_total` | 每次降级放宽历史计一次，包含仅清上一代与全重置 |
| `random_history_resets_total` | 降级时清两代并将次数归零的次数，不包含正常轮换 |
| `random_resample_unresolved_total` | 补采样查询成功，但结果为空或全部仍被过滤的次数；之后可通过同批降级成功返回 |
| `random_resample_attempts_total` | 初始非空批次全部过滤、需要补采样的次数，包含之后被额度拒绝并降级的请求 |
| `random_resample_queries_total` | 通过并发与速率预算、实际调用补采样查询的次数 |
| `random_resample_rejected_total` | 因补查并发或令牌不足而拒绝的次数 |
| `random_resample_errors_total` | 已准入补查的查询异常或结果校验失败次数 |
| `random_query_duration_seconds` | 实际候选 SQL 总耗时直方图，包含预取/直接抽样及补采样、连接池等待、网络和失败查询 |
| `random_prefetch_query_duration_seconds` | 候选预取/直接抽样 SQL 耗时，单位秒 |
| `random_resample_query_duration_seconds` | 独立随机补采样 SQL 耗时，单位秒 |
| `random_request_duration_seconds` | 应用内随机 GET 处理耗时，包含失败请求，单位秒 |
| `random_errors_total` | 随机请求的意外异常；Cookie 重建、无候选、正常兜底、非法参数和繁忙不计 |
| `random_cache_hits_total` | 请求第一次读取缓存即找到批次的次数，空批次也算命中 |
| `random_cache_misses_total` | 请求第一次读取缓存没有批次的次数，包含之后等待补池的请求 |
| `random_cache_refills_total` | 收到 Redis 成功发布确认的补池次数；超时结果未知的发布不计，实际提交量可能更高 |

统计中不再提供精确历史命中或真实耗尽次数。`random_fallback_total` 和 `random_history_relaxations_total` 都按实际降级成功选择计一次；前者不能与 `random_resample_attempts_total` 混算。补采样失败与预算拒绝不计 `random_resample_unresolved_total`，预算拒绝后的降级另计。健康探测与统计抓取不改变这些指标。直方图提供累计 buckets、`_sum`、`_count`；应用内处理耗时不等于包含网关和客户端网络的端到端耗时。

`/stats` 的 `query_duration_source` 在真实服务中为 `mysql`，`candidate_source` 为 `redis-prefetch`，`cache` 显示 DB 5、预取数量和 TTL；测试的数据源明确标为 `mock`。SQL 耗时仅围绕实际回源调用计时，不包含 Redis 读取或等待补池。模拟测试用于验证去重与调用次数，不能据此判断 MySQL 在 2c4g 上的容量。性能评估应使用实际数据分别观察数据库 CPU、慢查询和接口延迟。

## 验证

本轮功能检查与模拟验收数据见 [VALIDATION.md](VALIDATION.md)；其中明确区分模拟结果和仍待执行的实库性能验收。

```powershell
pnpm test:random-mvp
```

默认不连接外部 MySQL 或 Redis，覆盖两代 Bloom 轮换边界、HTTP/Cookie/统计、补采样额度与过载保护、入口生命周期、真实 Sequelize 生成的 SQL，以及补池并发、TTL 和失败行为。还会启动本地临时 MySQL 协议故障服务端，让真实 mysql2/Sequelize 经 TCP 完成握手后故意收不到查询响应，验证 socket 销毁、连接池替换、8 个等待请求释放及后续请求恢复；这属于网络故障测试，不是真实 MySQL 数据库或性能测试。

`rollingAcceptance.test.js` 使用模拟存储和真实 HTTP/Cookie 流程，运行 88 个 Life 站点、20 个用户各 50 次的场景，并输出重复数、错误、缓存命中率、查询次数和客户端延迟。测试客户端用独立日志检查最近 20 次重复，该日志仅属于验收工具，服务 Cookie 仍只存 Rolling Bloom。需要测量已启动的独立 MVP 时，显式指定服务地址：

```powershell
pnpm benchmark:random-mvp http://127.0.0.1:14515 --tag=life --users=20 --visits=50 --concurrency=8 --timeout=10000
```

脚本不自动启动服务或访问生产地址，不保存或输出 Cookie。报告使用 `/stats` 前后进程级差值，应隔离其他流量；未获取到统计或服务中途重启时，相应值为 `null`，不能当作零查询。HTTP 200 的业务失败同样计入失败；有失败或最近 20 次重复时，命令以非零状态退出。客户端延迟包含网络，模拟存储的延迟不能用于判断实际 MySQL/Redis 容量。

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

### Rolling Bloom 串行去重验收

以 Life 类 88 个符合条件的站点为数据集，20 个独立模拟用户各访问 50 次。每个用户使用独立 Cookie jar，用户内部串行；正常验收的总在途请求数不超过默认 8 个槽位。逐次检查成功 ID 是否出现于该用户此前最多 20 条成功记录，目标为零重复、零异常。记录总请求数、业务成功数、Redis 命中率、预取与补采样 SQL 次数、降级/放宽/全重置次数、客户端 p50/p95/p99 和最大延迟；若触发降级，不能隐去已允许的窗口内重复。模拟数据只能验算法与调用次数，性能结论必须来自实际 MySQL/Redis 环境。

正常 1000 次请求可能一次补采样也不触发，不能只用该结果认定补采样正确。还须强制覆盖：当前 8 个候选全部过滤但补采样中存在可返回站点；补采样空集或全部过滤后仅清上一代与全重置两种降级；并发或令牌不足时无 SQL 同批降级；真实查询超时、错误及非法结果不放宽、不写 Cookie；单站点/小池连续成功及空池；跨 tag 共享历史；旧 v1/v2、过期和损坏 Cookie；第 19/20/39/40 次正常轮换边界。降级选择立即入当前代，全重置后成功次数为 1，不声称通过 Bloom 证明真实候选耗尽。

另做 20 个用户同时请求的容量测试，明确记录总请求默认 8 槽造成的受控 503，以及补采样预算不足造成的同批降级。不能把这一组混入正常负载的零异常验收，也不能在报告中隐去拒绝或重复。比较旧算法与新算法时，应保持相同数据集、请求率、并发、TTL 和预热状态。

### 高基数 tag

按 tag 隔离缓存不会自动限制不同条件的查询速率。即使预取每请求最多回源一次、每进程最多 8 个在途请求，持续的首次 tag 仍可持续消耗 MySQL；独立补采样还可能增加一次查询，虽有独立额度也不能忽略。空批次缓存只对重复访问同一条件有收益；TTL 不能让不断变化的 tag 命中缓存。

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
| 总请求并发超限、补池等待超时、服务排空中 | 默认返回失败，按独立运行策略处理 |
| 补采样额度不足或结果全部过滤 | Hybrid 内部同批降级，成功结果仍归于 Hybrid；无需触发网关 Classic 回退 |
| 未分类的 503 或网关连接错误 | 默认不自动回退 |
| Classic 回退本身失败 | 结束请求，不在两个算法间循环重试 |

**当前 503 未提供足够的稳定故障分类，不能直接把所有 503 配成 `error_page 503 = @classic`。** 灰度接入前需增加由可信上游产生的分类信号，并测试网关确实按原因限量回退。Nginx 的错误拦截与内部转发只是机制，不能代替容量预算；参见 [proxy_intercept_errors](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_intercept_errors)。

网关日志至少区分以下字段（待灰度阶段实现）：

- `assigned_algorithm`：最初被分配到 Classic 或 Hybrid。
- `served_algorithm`：最终实际交付结果的算法，无结果时为 `none`。
- `gateway_fallback` / `fallback_reason`：是否尝试回退及有界原因分类。
- `request_id`、首次上游状态/耗时、回退上游状态/耗时、最终状态/总耗时。

保留完整上游状态与耗时链，不能仅记录最后一个 200；Nginx 的 [upstream_status](https://nginx.org/en/docs/http/ngx_http_upstream_module.html#var_upstream_status) 可用于记录上游状态链。响应中的算法标记应由可信网关生成或覆盖，不能信任客户端自报值。

建议独立计数 `random_gateway_fallback_total{from="hybrid",to="classic",reason="redis_unavailable"}`。现有 `random_fallback_total` 表示 Hybrid 内部实际放宽历史并同批选站，不能与网关 Classic 回退次数或补采样尝试数合并。跨版本报告须区分算法版本与具体降级规则。

归因与验收约束：

- 分配给 Hybrid 后发生 503，即使 Classic 救回最终请求，也保留一次 Hybrid 失败样本；不能删除或改写为 Hybrid 成功。
- Classic 回退结果进入单独的回退组，不能混入最初分配给 Classic 的原生对照组。端到端可用性与 Hybrid 自身成功率分别报告。
- 主线 Classic 的业务失败可能返回 HTTP 200、`success:false`；压测客户端应校验 JSON，不能只用 HTTP 状态判断业务成功。
- Classic 回退不会更新 Hybrid Cookie 历史。混合算法序列的重复率与纯 Hybrid 序列分开报告；纯 Hybrid 内部的历史放宽也须单独记录，不能宣称降级序列仍严格覆盖最近 20 次。
- 验证一次回退上限、网关与应用重试不叠加、tag 保留、预算耗尽后的行为，以及 Redis 恢复后重新进入 Hybrid。

正式替换 Classic 后需另行确定降级目标和容量预算，不能默认继承灰度回退规则。

## 后续接入主线

算法在 `modules/random/`，路由工厂在 `routes/public/hybridRandom.js`。主线确认后可以用现有 `webModel` 创建数据源，显式注入单次补查服务：

```js
const { webModel } = require('../../modules/sqlModel');
const { createCandidateSource, measureCandidateQuery } = require('../../modules/random/source');
const { createResampleSource } = require('../../modules/random/resample');
const { RandomMetrics } = require('../../modules/random/metrics');
const { createHybridRandomRouter } = require('./hybridRandom');

const metrics = new RandomMetrics();
const resampleSource = createResampleSource({
    resampleCandidates: createCandidateSource(webModel, { limit: 64 }),
    metrics,
    maxInFlight: 1,
    ratePerSecond: 2,
    burst: 2,
});

module.exports = createHybridRandomRouter({
    findCandidates: measureCandidateQuery(createCandidateSource(webModel), metrics),
    resampleSource,
    metrics,
    cookieName: '_tvl',
    cookieSecure: true, // 按主线实际 HTTPS 部署配置
});
```

上面的示例是无缓存的最小接线示意，主线部署还须接入关闭流程并核实连接层保护。要保留预取，用 `createCandidateSource(webModel, { limit: PREFETCH_LIMIT })` 构造回源函数，再注入 `createPrefetchSource({ cache, prefetchCandidates, metrics })`，将其 `findCandidates` 交给路由。独立补采样使用相同 tag 条件的 `LIMIT 64` 数据源，结果不存入公共池；Cookie 中的 Bloom 不会转换成 SQL 排除列表。直接 SQL 模式的采样耗时可用 `measureCandidateQuery` 包装数据源，预取和补采样服务分别在实际 SQL 调用处计时，避免重复计数。

主线关闭时，先停止接单及补池/补采样准入，再等待 `candidateSource.close()` 和 `resampleSource.close()`，最后关闭共享数据库与 Redis。不能仅等待 HTTP socket，也不能把补采样混入共享补池 Promise；采样结果在各请求自己的 Bloom 下过滤。

MVP 入口、只读连接、健康与统计接口可以继续独立运行，无需一并接入主线；指标实例可由主线自行注入。原主线入口与业务路由在本阶段不变，也没有新增依赖或 MySQL 结构变更。

本阶段的客户端超时保护位于 `mvp/random/mysqlClient.js`，通过独立连接的 `dialectModule` 和 `afterQuery` 接入。将来合并主线时，要同时迁入这两处连接层接线，才能让主线连接获得相同的故障恢复能力；仅替换随机路由不会自动获得保护。
