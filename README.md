# BYR Archive

> 最简版 jsDelivr —— 直接从 npm registry 拉取包，并按 URL 提供「入口文件 / 目录列表 / 任意文件 / 打包产物」服务。

**零运行时依赖**，只用 Node.js 内置模块实现。自己写了 npm registry 客户端、tar(gzip) 解包器、semver 版本解析器、JS 词法压缩器、一个能跨包内联的打包器和一个小型 CLI。

```bash
git clone <repo>
cd byr-archive
node src/index.js          # 无需 npm install，直接跑
# → http://localhost:8080
```

---

## 快速验证

```bash
# 入口文件（按 jsdelivr → exports["."].default → main 优先级解析）
curl -i http://localhost:8080/react        # 命中 exports["."].default
curl -i http://localhost:8080/vue@3.3.4    # 命中 jsdelivr 字段
curl -i http://localhost:8080/lodash       # 命中 main 字段

# 目录列表 / 指定文件
curl http://localhost:8080/vue@3.3.4/
curl -i http://localhost:8080/vue@3.3.4/dist/vue.runtime.esm-browser.js

# 版本范围 / dist-tag
curl -I http://localhost:8080/vue@%5E3.2.0/package.json
curl -I http://localhost:8080/vue@beta/package.json

# 压缩与打包
curl -i 'http://localhost:8080/lodash@4.17.21/lodash.js?min'
curl -i 'http://localhost:8080/mime@3.0.0/index.js?bundle'
curl -i 'http://localhost:8080/axios@1.6.0/lib/axios.js?esm'
curl -i 'http://localhost:8080/express@4.18.2/lib/express.js?bundle=deep'   # 递归内联 70 个包

# 包信息 JSON API（给程序用）
curl http://localhost:8080/_api/vue@3.3.4
curl http://localhost:8080/_api/vue@3.3.4/tree
curl http://localhost:8080/_api/vue@3.3.4/dir/dist

# 监控与自检
curl http://localhost:8080/_metrics         # Prometheus 文本格式
curl http://localhost:8080/_stats           # JSON 快照
node src/index.js verify vue@3.3.4          # CLI 逐环节自检
```

## URL 规则

| URL 形态 | 行为 |
|---|---|
| `/` | 服务首页 |
| `/_health` / `/_stats` / `/_metrics` | 健康检查 / JSON 统计 / Prometheus 指标 |
| `/_api/{包}[@{版本}]` | 包信息 JSON（`/tree`、`/dir/{路径}`、`/file/{路径}`） |
| `/{包名}` | 返回**入口文件**内容 |
| `/{包名}@{版本}` | 同上，版本可精确、`^`、`~`、范围或 dist-tag |
| `/{包名}@{版本}/` | **目录列表**页 |
| `/{包名}@{版本}/{子目录}/` | 子目录列表 |
| `/{包名}@{版本}/{文件路径}` | 返回该文件内容 |
| `/npm/{包名}@{版本}/...` | jsDelivr 兼容前缀 |

包名支持 scoped：`/@vue/shared@3.4.21/package.json`。

### 查询参数

| 参数 | 作用 |
|---|---|
| `?min` / `?minify` | 服务端即时压缩 JS / CSS |
| `?bundle` | 把**包内**相对依赖内联成单文件（CJS） |
| `?bundle=deep` | 递归内联**外部依赖**，真正把多个包合并成一个文件 |
| `?bundle=rewrite` / `?esm` | 把 import 说明符重写为指向本服务的绝对 URL |

### `.min.js` 回退

请求 `/pkg@1.0.0/xxx.min.js` 而包内没有该文件时，会自动取 `xxx.js` 并即时压缩后返回，而不是 404 —— 与 jsDelivr 行为一致。

## 命令行工具

```bash
node src/index.js serve                      # 启动服务（默认命令）
node src/index.js info  vue@3.3.4            # 解析结果概览
node src/index.js tree  vue@3.3.4            # 完整文件树
node src/index.js ls    vue@3.3.4 dist       # 目录列表
node src/index.js cat   lodash@4.17.21 lodash.js > out.js
node src/index.js min   lodash@4.17.21 lodash.js -s
node src/index.js bundle express@4.18.2 lib/express.js --deep -o bundle.cjs
node src/index.js verify express@4.18.2      # 逐环节自检，退出码反映结果
```

全局参数：`--registry <url>`（优先级最高）、`-j/--json`、`-o <文件>`、`-s`、`-h`。

## 配置

全部通过环境变量覆盖，也可用 `--port` / `--host` / `--registry` 命令行参数。

### 上游 registry（优先级从高到低）

```
命令行 --registry  >  REGISTRY / REGISTRY_TOKEN  >  ./.npmrc  >  ~/.npmrc  >  https://registry.npmjs.org
```

`.npmrc` 支持 `registry=`、`//host/path/:_authToken=`、`_auth`、`${VAR}` 插值。`_authToken` 用 Bearer，`_auth` 用 Basic。

### 主要环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | 监听地址 |
| `REGISTRY` / `REGISTRY_TOKEN` | 官方源 / 空 | 上游地址与令牌 |
| `NPMRC` | `true` | 是否读取 `.npmrc` |
| `CACHE_DIR` | `./.byr-cache` | 磁盘缓存目录 |
| `DISK_CACHE` | `true` | 是否启用磁盘缓存 |
| `MEMORY_CACHE_BYTES` | `67108864`（64MB） | 内存 LRU 字节上限 |
| `TTL_MANIFEST` / `TTL_PACKUMENT` / `TTL_FILE` / `TTL_NEGATIVE` | 1h / 5min / 7d / 30s | 分类型缓存时长（ms） |
| `UPSTREAM_TIMEOUT` | `30000` | 上游请求超时（ms） |
| `MAX_TARBALL_BYTES` / `MAX_FILE_BYTES` | 128MB / 64MB | 体积上限 |
| `MAX_CONCURRENT_EXTRACT` / `MAX_EXTRACT_QUEUE` | `4` / `64` | 并发解包上限与队列上限 |
| `RATE_LIMIT_PER_MINUTE` | `0`（关闭） | 每客户端每分钟额度；`>0` 开启令牌桶限流 |
| `RATE_LIMIT_BURST` / `RATE_LIMIT_MAX_KEYS` | 同额度 / `10000` | 突发容量 / 最多跟踪的客户端数 |
| `TRUST_PROXY` | `false` | 是否信任 `X-Forwarded-For`（反向代理后才该开） |
| `MINIFY` / `COMPRESS` | `true` | 代码压缩 / gzip-brotli 传输压缩 |
| `CORS` / `SECURITY_HEADERS` | `true` | CORS 头 / `nosniff` 与列表页 CSP |
| `METRICS` / `API` | `true` | 是否暴露 `/_metrics` / `/_api/` |
| `NPM_PREFIX` | `true` | 是否识别 `/npm/` 前缀 |
| `BUNDLE_MAX_DEPTH` / `BUNDLE_MAX_MODULES` / `BUNDLE_MAX_BYTES` | `8` / `300` / `16MB` | 深度打包上限 |
| `ENTRY_CONDITIONS` | `false` | 是否启用 exports 完整条件解析兜底 |
| `ENTRY_NODE_DEFAULT` | `false` | 4 条入口规则全落空时，是否回退到 Node 默认解析（包根 `index.js`） |
| `LOG_LEVEL` | `info` | `silent` / `error` / `info` / `debug` |

### 关于 `ENTRY_NODE_DEFAULT`

题面的入口解析规则第 4 条明确要求「以上均不满足则返回 404」。但实测有些主流包（如 `express@4.18.2`、`mime@3.0.0`）**发布的 package.json 里确实没有 `main` 也没有 `exports`** —— 它们靠 Node 的默认解析（包根 `index.js`）工作。

本服务默认**严格遵循题面**返回 404，但会在响应体里给出解释和解决办法：

```json
{
  "error": "包 express@4.18.2 没有可用的入口文件（jsdelivr / exports[\".\"] / main 均未命中）",
  "hint": "该包的 package.json 未声明 main / exports，但包含 index.js……设置 ENTRY_NODE_DEFAULT=1 可启用 Node 默认解析回退。",
  "nodeDefaultCandidate": "index.js"
}
```

设置 `ENTRY_NODE_DEFAULT=1` 即可获得与 Node 一致的行为。打包器解析**依赖包**入口时始终启用该回退（那里模拟的是 Node 的模块解析语义）。

## 项目结构

```
src/
  index.js       进程入口（入口守卫 + 交给 CLI）
  cli.js         命令行工具（serve / info / tree / ls / cat / min / bundle / verify）
  server.js      node:http 服务器、超时、优雅退出
  handler.js     HTTP 语义层（Content-Type / ETag / Range / 条件请求 / 压缩 / CORS / 安全头）
  router.js      URL → 路由对象（纯函数，可单测穷举）
  api.js         /_api/ 包信息 JSON 接口
  registry.js    npm registry 客户端（三级请求策略 + 请求合并 + 缓存 + stale-if-error）
  store.js       包仓库层：把「包名+版本」变成可读文件树
  tar.js         纯 JS USTAR / PAX / GNU tar 解包器（流式、防穿越、防压缩炸弹）
  semver.js      自实现 semver 范围解析
  cache.js       两级缓存（内存 LRU + 磁盘、分类型 TTL、原子落盘）
  compress.js    gzip / brotli 内容协商与压缩缓存
  minify.js      JS / CSS 词法级安全压缩器
  bundle.js      打包器（Inline / Deep Inline / Rewrite 三种模式）
  entry.js       入口文件解析优先级链
  listing.js     目录列表页 / 服务首页
  mime.js        扩展名 → Content-Type
  npmrc.js       .npmrc 解析（私有源与鉴权）
  metrics.js     Prometheus 指标（计数器 / 直方图 / 事件循环延迟）
  ratelimit.js   令牌桶限流
  semaphore.js   计数信号量（并发解包上限）
  errors.js      HTTP 错误类型
  config.js      配置
  logger.js      分级日志
  util.js        单飞、哈希、HTML 转义等
test/
  smoke.mjs      118 项测试（单元 + 端到端，打真实 registry）
  benchmark.mjs  11 个方面的基准测量
docs/
  开发记录.md     逐环节的实现记录：做法、实测效果、取舍、踩坑
  benchmark-output.txt
```

## 运行测试

```bash
npm test                 # 118 项用例；无外网时自动跳过联网用例
node test/benchmark.mjs  # 基准测量，打印体积/耗时/压缩率
node src/index.js verify <包>   # 对单个包做逐环节自检
```

## 实测数据摘要

| 项 | 结果 |
|---|---|
| 上游请求策略 | 精确版本走单版本接口 2.9KB，比完整 packument 2.0MB **省 99.9%** |
| 请求合并 | 20 个并发 `fetchManifest` → 上游只被请求 **1 次** |
| 缓存 | `vue@3.3.4` 首次 166ms → 磁盘缓存 0.8ms → 内存 LRU 0.03ms |
| 传输压缩 | `vue.global.js` 463KB → 代码压缩 + brotli **80.7KB（降 82.6%）** |
| 并发保护 | 5 个冷包同时请求 → 峰值解包并发精确停在 4（上限 4） |
| 打包（包内） | `express/lib/express.js` 内联 11 个模块 → 93KB |
| 打包（跨包） | `express/lib/express.js?bundle=deep` **144 模块 / 70 包 → 928KB**，产物可真实 `require` 并起 HTTP 服务 |
| 限流 | 60/分钟 + 突发 5 → 第 6 个请求被拒，`Retry-After: 1s` |
| 指标 | `/_metrics` 1.1ms 导出 16 个指标 / 54 个样本 |

完整数据见 [`docs/benchmark-output.txt`](docs/benchmark-output.txt)。

## 实现边界

- **ESM 不做单文件合并**。需要完整的导入提升 + 活绑定实现（rollup / esbuild 量级），本项目改为「重写说明符为绝对 URL」（`?esm`），这正是 jsDelivr `+esm` 与 esm.sh 的做法。
- **深度打包不处理 Node 内置模块垫片**。产物在 Node 中完全可用；在浏览器中遇到 `require('fs')` 会抛出带说明的错误。
- **深度打包不处理 `package.json` 的 `browser` 字段**。
- **压缩器不做混淆**。只做词法层面的安全压缩，不做变量重命名、死代码消除。
- **限流默认关闭**。代码完整且有用例覆盖，但默认开启会误伤正常的批量构建脚本。
- **不支持 scoped registry**（`@scope:registry`）。
- **缓存无主动失效**。靠 TTL；版本化内容天然不可变，用 `immutable` + 长 TTL。

更多取舍与踩坑记录见 [`docs/开发记录.md`](docs/开发记录.md)（含 20 个真实 bug 的定位与修复过程）。

## License

MIT
