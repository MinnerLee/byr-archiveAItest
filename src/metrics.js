/**
 * 运行指标。
 *
 * 一个自称「最佳实践」的服务如果只有日志、没有指标，运维上是不可观测的：
 * 日志能告诉你「发生了什么」，指标才能告诉你「有多频繁、有没有恶化」。
 *
 * 这里手写一个极小的计数器 / 直方图实现，并输出 Prometheus 文本格式
 * （`/_metrics`），同时提供一个 JSON 快照（`/_stats`）。
 * 不引入 prom-client 的原因还是零依赖。
 *
 * 额外采集了 **事件循环延迟直方图** —— 对一个既有 CPU 密集操作（gunzip、压缩、
 * 词法分析）又有磁盘 IO 的 Node 服务来说，这是最能反映「服务健康度」的指标：
 * 平均延迟正常但事件循环延迟飙升，说明某处有同步阻塞，需要去做背压或限流。
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';

/* ------------------------------------------------------------------ */
/* 计数器与直方图                                                       */
/* ------------------------------------------------------------------ */

/** @type {Map<string, {help:string, type:string, values:Map<string, number>}>} */
const registry = new Map();

/** 把标签对象序列化成稳定的字符串键。 */
function labelKey(labels) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`).join(',');
}

/**
 * 声明并获取一个计数器/仪表。
 * @param {string} name 指标名
 * @param {'counter'|'gauge'} type
 * @param {string} help 说明文本
 */
function getSeries(name, type, help) {
  let series = registry.get(name);
  if (!series) {
    series = { help, type, values: new Map() };
    registry.set(name, series);
  }
  return series;
}

/** 计数器加一（或加 n）。 */
export function inc(name, labels = {}, value = 1) {
  const series = getSeries(name, 'counter', '');
  const key = labelKey(labels);
  series.values.set(key, (series.values.get(key) || 0) + value);
}

/** 设置仪表的值。 */
export function gauge(name, labels = {}, value = 0) {
  const series = getSeries(name, 'gauge', '');
  const key = labelKey(labels);
  series.values.set(key, value);
}

/* ------------------------------------------------------------------ */
/* 直方图                                                              */
/* ------------------------------------------------------------------ */

/** 请求耗时直方图的分桶（秒）。覆盖 0.5ms ~ 10s。 */
const DURATION_BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** @type {Map<string, {le:number, count:number}[]>} */
const histogramBuckets = new Map();
/** @type {Map<string, number>} */
const histogramSum = new Map();
/** @type {Map<string, number>} */
const histogramCount = new Map();

/**
 * 记录一个观测值。
 * @param {string} name 指标名
 * @param {string} key 标签串
 * @param {number} value 观测值
 * @param {number[]} buckets 分桶边界（升序）
 */
function observe(name, key, value, buckets) {
  let series = histogramBuckets.get(`${name}|${key}`);
  if (!series) {
    series = buckets.map((le) => ({ le, count: 0 }));
    histogramBuckets.set(`${name}|${key}`, series);
  }
  for (const bucket of series) {
    if (value <= bucket.le) bucket.count += 1;
  }
  histogramSum.set(`${name}|${key}`, (histogramSum.get(`${name}|${key}`) || 0) + value);
  histogramCount.set(`${name}|${key}`, (histogramCount.get(`${name}|${key}`) || 0) + 1);
}

/** 记录一次 HTTP 请求耗时（秒）。 */
export function observeRequestDuration(seconds, labels = {}) {
  observe('byr_http_request_duration_seconds', labelKey(labels), seconds, DURATION_BUCKETS);
}

/* ------------------------------------------------------------------ */
/* 事件循环延迟                                                        */
/* ------------------------------------------------------------------ */

/**
 * 事件循环延迟采样器。
 * 每 20ms 采一次（Node 内部用定时器精度做的直方图），成本可忽略。
 */
let eventLoop = null;
try {
  eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
} catch {
  eventLoop = null; // 极老版本 Node 上降级为不采集
}

/** 取事件循环延迟统计（毫秒）。 */
export function eventLoopStats() {
  if (!eventLoop) return null;
  return {
    meanMs: Number((eventLoop.mean / 1e6).toFixed(3)),
    maxMs: Number((eventLoop.max / 1e6).toFixed(3)),
    p50Ms: Number((eventLoop.percentile(50) / 1e6).toFixed(3)),
    p99Ms: Number((eventLoop.percentile(99) / 1e6).toFixed(3)),
  };
}

/** 重置事件循环延迟采样（用于按窗口统计，如每 60 秒归零一次）。 */
export function resetEventLoop() {
  eventLoop?.reset();
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

/** 生成 Prometheus 文本格式。 */
export function renderPrometheus() {
  const lines = [];

  // 计数器 / 仪表
  for (const [name, series] of registry) {
    if (series.values.size === 0) continue;
    const type = series.type;
    if (series.help) lines.push(`# HELP ${name} ${series.help}`);
    lines.push(`# TYPE ${name} ${type}`);
    for (const [labels, value] of series.values) {
      lines.push(labels ? `${name}{${labels}} ${value}` : `${name} ${value}`);
    }
  }

  // 直方图
  const histogramNames = new Set([...histogramBuckets.keys()].map((k) => k.split('|')[0]));
  for (const name of histogramNames) {
    lines.push(`# TYPE ${name} histogram`);
    for (const [compoundKey, buckets] of histogramBuckets) {
      const [seriesName, labels] = compoundKey.split('|');
      if (seriesName !== name) continue;
      for (const bucket of buckets) {
        const merged = labels ? `${labels},le="${bucket.le}"` : `le="${bucket.le}"`;
        lines.push(`${name}_bucket{${merged}} ${bucket.count}`);
      }
      const infLabels = labels ? `${labels},le="+Inf"` : 'le="+Inf"';
      lines.push(`${name}_bucket{${infLabels}} ${histogramCount.get(compoundKey) || 0}`);
      lines.push(
        labels
          ? `${name}_sum{${labels}} ${(histogramSum.get(compoundKey) || 0).toFixed(6)}`
          : `${name}_sum ${(histogramSum.get(compoundKey) || 0).toFixed(6)}`,
      );
      lines.push(
        labels ? `${name}_count{${labels}} ${histogramCount.get(compoundKey) || 0}` : `${name}_count ${histogramCount.get(compoundKey) || 0}`,
      );
    }
  }

  // 进程级指标
  const memory = process.memoryUsage();
  lines.push('# HELP process_uptime_seconds 进程运行时长');
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${process.uptime().toFixed(3)}`);
  lines.push('# HELP process_resident_memory_bytes 常驻内存');
  lines.push('# TYPE process_resident_memory_bytes gauge');
  lines.push(`process_resident_memory_bytes ${memory.rss}`);
  lines.push('# HELP nodejs_heap_used_bytes V8 堆使用量');
  lines.push('# TYPE nodejs_heap_used_bytes gauge');
  lines.push(`nodejs_heap_used_bytes ${memory.heapUsed}`);

  const loop = eventLoopStats();
  if (loop) {
    lines.push('# HELP byr_event_loop_lag_seconds 事件循环延迟');
    lines.push('# TYPE byr_event_loop_lag_seconds gauge');
    lines.push(`byr_event_loop_lag_seconds{quantile="0.5"} ${(loop.p50Ms / 1000).toFixed(6)}`);
    lines.push(`byr_event_loop_lag_seconds{quantile="0.99"} ${(loop.p99Ms / 1000).toFixed(6)}`);
    lines.push(`byr_event_loop_lag_seconds{quantile="1"} ${(loop.maxMs / 1000).toFixed(6)}`);
  }

  return `${lines.join('\n')}\n`;
}

/** 生成 JSON 快照。 */
export function snapshot() {
  /** @type {Record<string, any>} */
  const counters = {};
  for (const [name, series] of registry) {
    for (const [labels, value] of series.values) {
      const key = labels ? `${name}{${labels}}` : name;
      counters[key] = value;
    }
  }

  /** @type {Record<string, any>} */
  const histograms = {};
  for (const [compoundKey, buckets] of histogramBuckets) {
    const [name, labels] = compoundKey.split('|');
    const key = labels ? `${name}{${labels}}` : name;
    histograms[key] = {
      count: histogramCount.get(compoundKey) || 0,
      sumSeconds: Number((histogramSum.get(compoundKey) || 0).toFixed(4)),
      avgMs: histogramCount.get(compoundKey)
        ? Number((((histogramSum.get(compoundKey) || 0) / histogramCount.get(compoundKey)) * 1000).toFixed(3))
        : 0,
      p99Seconds: (buckets.find((b) => b.count >= (histogramCount.get(compoundKey) || 0) * 0.99) || { le: 0 }).le,
    };
  }

  return {
    counters,
    histograms,
    eventLoop: eventLoopStats(),
    memory: process.memoryUsage(),
    uptimeSeconds: Number(process.uptime().toFixed(2)),
  };
}

/** 清空所有指标（测试用）。 */
export function reset() {
  registry.clear();
  histogramBuckets.clear();
  histogramSum.clear();
  histogramCount.clear();
  resetEventLoop();
}

/* ------------------------------------------------------------------ */
/* 常用指标的语义化封装                                                 */
/* ------------------------------------------------------------------ */

export const metrics = {
  /** 记录一次 HTTP 请求完成。 */
  httpRequest({ method, status, durationSeconds, bytes, encoding }) {
    inc('byr_http_requests_total', { method, status: String(status) });
    observeRequestDuration(durationSeconds, { method });
    if (bytes > 0) {
      inc('byr_http_bytes_sent_total', { encoding: encoding || 'identity' }, bytes);
    }
  },

  /** 记录一次上游 registry 请求。 */
  upstreamRequest(kind, ok = true) {
    inc('byr_upstream_requests_total', { kind, result: ok ? 'ok' : 'error' });
  },

  /** 记录一次缓存访问。 */
  cacheAccess(layer, hit) {
    inc(hit ? 'byr_cache_hits_total' : 'byr_cache_misses_total', { layer });
  },

  /** 记录一次解包。 */
  extraction({ ms, bytes, files, ok }) {
    inc('byr_extractions_total', { result: ok ? 'ok' : 'error' });
    if (ok) {
      inc('byr_extracted_bytes_total', {}, bytes);
      inc('byr_extracted_files_total', {}, files);
      observe('byr_extraction_duration_seconds', '', ms / 1000, [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]);
    }
  },

  /** 记录压缩节省的字节。 */
  compressionSaved(saved, encoding) {
    inc('byr_compression_bytes_saved_total', { encoding }, saved);
  },

  /** 记录代码压缩节省的字节。 */
  minifySaved(saved) {
    inc('byr_minify_bytes_saved_total', {}, saved);
  },

  /** 记录一次限流拒绝。 */
  rateLimited(limit) {
    inc('byr_ratelimit_rejected_total', { limit: String(limit) });
  },
};

export default { inc, gauge, observe, observeRequestDuration, renderPrometheus, snapshot, reset, metrics, eventLoopStats };
