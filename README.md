# BYR Archive

> 最简版 jsDelivr —— 直接从 npm registry 拉取包，并按 URL 提供「入口文件 / 目录列表 / 任意文件」服务。

零运行时依赖，只用 Node.js 内置模块实现：自己写了 npm registry 客户端、tar(gzip) 解包器、semver 版本解析器、JS 词法压缩器和一个小型打包器。

```bash
git clone <repo>
cd byr-archive
node src/index.js          # 无需 npm install，直接跑
# → http://localhost:8080
```

## 快速验证

```bash
# 入口文件（按 jsdelivr → exports["."].default → main 优先级解析）
curl -i http://localhost:8080/react
curl -i http://localhost:8080/lodash

# 目录列表
curl http://localhost:8080/vue@3.3.4/

# 指定文件
curl -i http://localhost:8080/vue@3.3.4/dist/vue.runtime.esm-browser.js

# 版本范围 / dist-tag
curl -I http://localhost:8080/vue@%5E3.2.0/package.json
curl -I http://localhost:8080/vue@beta/package.json

# 压缩与打包
curl -i 'http://localhost:8080/lodash@4.17.21/lodash.js?min'
curl -i 'http://localhost:8080/mime@3.0.0/index.js?bundle'
curl -i 'http://localhost:8080/axios@1.6.0/lib/axios.js?esm'
```

## URL 规则

| URL 形态 | 行为 |
|---|---|
| `/` | 服务首页 |
| `/_health` `/_stats` | 健康检查 / 缓存与运行统计 |
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
| `?bundle` | 把包内相对依赖内联成单文件（CJS） |
| `?bundle=rewrite` / `?esm` | 把 import 说明符重写为指向本服务的绝对 URL |

### `.min.js` 回退

请求 `/pkg@1.0.0/xxx.min.js` 而包内没有该文件时，会自动取 `xxx.js` 并即时压缩后返回，而不是 404 —— 与 jsDelivr 行为一致。

## 配置

全部通过环境变量覆盖（也可用 `--port` / `--host` / `--registry` 命令行参数）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `REGISTRY` | `https://registry.npmjs.org` | 上游 npm registry（题目要求的私有源入口） |
| `REGISTRY_TOKEN` | 空 | 私有源 Bearer 令牌 |
| `CACHE_DIR` | `./.byr-cache` | 磁盘缓存目录 |
| `DISK_CACHE` | `true` | 是否启用磁盘缓存 |
| `MEMORY_CACHE_BYTES` | `67108864`（64MB） | 内存 LRU 字节上限 |
| `TTL_MANIFEST` | `3600000` | 单版本元信息缓存时长（ms） |
| `TTL_PACKUMENT` | `300000` | packument 缓存时长 |
| `TTL_FILE` | `604800000` | 解包文件缓存时长 |
| `TTL_NEGATIVE` | `30000` | 404 负缓存时长 |
| `MAX_TARBALL_BYTES` | `134217728`（128MB） | tarball 体积上限 |
| `MAX_FILE_BYTES` | `67108864`（64MB） | 单文件体积上限 |
| `MAX_CONCURRENT_EXTRACT` | `4` | 并发解包上限 |
| `MINIFY` | `true` | 是否允许即时压缩 |
| `COMPRESS` | `true` | 是否开启 gzip / brotli |
| `CORS` | `true` | 是否发送 `Access-Control-Allow-Origin: *` |
| `NPM_PREFIX` | `true` | 是否识别 `/npm/` 前缀 |
| `ENTRY_CONDITIONS` | `false` | 是否启用 exports 完整条件解析兜底（默认关闭以严格贴合题面） |
| `LOG_LEVEL` | `info` | `silent` / `error` / `info` / `debug` |

## 项目结构

```
src/
  index.js       进程入口（参数解析、启动）
  server.js      node:http 服务器、超时、优雅退出
  handler.js     HTTP 语义层（Content-Type / ETag / Range / 压缩 / CORS）
  router.js      URL → 路由对象（纯函数，可单测穷举）
  registry.js    npm registry 客户端（三级请求策略 + 请求合并 + 缓存）
  store.js       包仓库层：把「包名+版本」变成可读文件树
  tar.js         纯 JS USTAR / PAX / GNU tar 解包器（流式）
  semver.js      自实现 semver 范围解析（^ ~ x - || 比较符 dist-tag）
  cache.js       两级缓存（内存 LRU + 磁盘、分类型 TTL、原子落盘）
  compress.js    gzip / brotli 内容协商与压缩缓存
  minify.js      JS / CSS 词法级安全压缩器
  bundle.js      打包器（Inline 内联 / Rewrite 重写）
  entry.js       入口文件解析优先级链
  listing.js     目录列表页 / 服务首页
  mime.js        扩展名 → Content-Type
  errors.js      HTTP 错误类型
  config.js      配置
  logger.js      分级日志
  util.js        单飞、哈希、HTML 转义等
test/
  smoke.mjs      79 项测试（单元 + 端到端，打真实 registry）
  benchmark.mjs  基准测量（产出 docs/benchmark-output.txt 里的所有数字）
docs/
  开发记录.md     逐环节的实现记录：做法、实测效果、取舍、踩坑
  benchmark-output.txt
```

## 运行测试

```bash
npm test                 # 79 项用例；无外网时自动跳过联网用例
node test/benchmark.mjs  # 基准测量，打印体积/耗时/压缩率
```

## 实现边界（已知不足）

- **ESM 不内联**。ESM 合并成单文件需要完整的导入提升与活绑定实现，本项目改为「重写说明符为绝对 URL」（`?esm`），这是 jsDelivr `+esm` 与 esm.sh 的真实做法。
- **外部依赖不内联**。`?bundle` 只合并包内相对依赖；`require('body-parser')` 这类裸依赖会保留原样（Rewrite 模式下会被重写为指向本服务的绝对 URL 并锁定精确版本）。
- **压缩器不做混淆**。只做词法层面的安全压缩（删注释、压空白），不做变量重命名、死代码消除。
- **缓存无主动失效**。靠 TTL；版本化内容天然不可变，靠 `immutable` + 长 TTL。

## License

MIT
