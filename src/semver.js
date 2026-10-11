/**
 * 极简 semver 实现（零依赖）。
 *
 * 为什么不用 `semver` 包？—— 为了让整个项目零依赖：不需要 npm install 就能跑，
 * 没有供应链风险，也便于评委直接阅读全部逻辑。
 *
 * 覆盖范围（与 node-semver 的行为对齐）：
 *   - 精确版本：  1.2.3 / =1.2.3 / v1.2.3
 *   - 比较符：    > >= < <=
 *   - 通配：      * / x / X / 1.x / 1.2.x
 *   - 波浪号：    ~1.2.3 / ~1.2 / ~1
 *   - 插入号：    ^1.2.3 / ^0.2.3 / ^0.0.3
 *   - 连字符区间：1.2.3 - 2.3.4
 *   - 并集：      `||`
 *   - 交集：      空格分隔（AND）
 *   - 预发布版本：遵循 node-semver 规则，默认不参与匹配
 *
 * 明确不支持的（会在 README 中说明）：
 *   - build metadata 参与比较（按 semver 规范，build 不参与排序）
 *   - `*` 之外的复杂 loose 语法
 */

/** 数字标识符（不含前导零，0 本身除外）。 */
const NUMERIC = /^(0|[1-9]\d*)$/;

/**
 * 解析版本字符串。
 * @param {string} input 例如 `1.2.3-beta.1+build.5`
 * @returns {{major:number,minor:number,patch:number,prerelease:(string|number)[],build:string,raw:string}|null}
 */
export function parse(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  // 允许前置 `v` 与 `=`
  const cleaned = raw.replace(/^[v=]+/, '');
  const m =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(cleaned);
  if (!m) return null;

  const [, major, minor, patch, pre, build] = m;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: pre ? pre.split('.').map((id) => (NUMERIC.test(id) ? Number(id) : id)) : [],
    build: build || '',
    raw: cleaned,
  };
}

/**
 * 判断字符串是否为合法 semver 版本。
 * @param {string} v
 */
export function valid(v) {
  return parse(v) !== null;
}

/** 比较两个 prerelease 标识符（semver 规则的 §11.4）。 */
function comparePrerelease(a, b) {
  // 无 prerelease 的版本优先级更高
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xNum = typeof x === 'number';
    const yNum = typeof y === 'number';
    if (xNum && yNum) return x < y ? -1 : 1;
    if (xNum) return -1; // 数字标识符优先级低于字母标识符
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  // 前缀相同时，字段更多的版本优先级更高
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * 版本大小比较，可接受字符串或已解析对象。
 * @returns {number} -1 / 0 / 1
 */
export function compare(a, b) {
  const va = typeof a === 'string' ? parse(a) : a;
  const vb = typeof b === 'string' ? parse(b) : b;
  if (!va || !vb) throw new TypeError('compare() 需要合法的 semver 版本');

  if (va.major !== vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor !== vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch !== vb.patch) return va.patch < vb.patch ? -1 : 1;
  return comparePrerelease(va.prerelease, vb.prerelease);
}

/** 排序比较函数，可直接传给 Array#sort。 */
export const rcompare = (a, b) => compare(b, a);

/** 判断是否带预发布标识。 */
export function isPrerelease(v) {
  const parsed = typeof v === 'string' ? parse(v) : v;
  return Boolean(parsed && parsed.prerelease.length > 0);
}

/** 取 x.y.z 三段数值。 */
function triplet(v) {
  return [v.major, v.minor, v.patch];
}

/** 比较 x.y.z 三段是否相等。 */
function sameTriplet(a, b) {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

/**
 * 把单个比较符展开成 `>=` / `<` 边界组合。
 * 返回 comparator 数组：{op, ver}
 */
function expandOperator(op, ver, hasMinor, hasPatch, wild = {}) {
  const p = ver;
  const out = [];

  switch (op) {
    case '':
    case '=':
      if (hasMinor && hasPatch) {
        out.push({ op: '=', ver: p });
      } else if (hasMinor) {
        // 1.2 -> >=1.2.0 <1.3.0
        out.push({ op: '>=', ver: p });
        out.push({ op: '<', ver: { ...p, minor: p.minor + 1, patch: 0, prerelease: [] } });
      } else {
        // 1 -> >=1.0.0 <2.0.0
        out.push({ op: '>=', ver: p });
        out.push({ op: '<', ver: { ...p, major: p.major + 1, minor: 0, patch: 0, prerelease: [] } });
      }
      break;

    case '>':
      if (hasMinor && hasPatch) {
        out.push({ op: '>', ver: p });
      } else if (hasMinor) {
        out.push({ op: '>=', ver: { ...p, minor: p.minor + 1, patch: 0, prerelease: [] } });
      } else {
        out.push({ op: '>=', ver: { ...p, major: p.major + 1, minor: 0, patch: 0, prerelease: [] } });
      }
      break;

    case '>=':
      out.push({ op: '>=', ver: p });
      break;

    case '<':
      out.push({ op: '<', ver: p });
      break;

    case '<=':
      if (hasMinor && hasPatch) {
        out.push({ op: '<=', ver: p });
      } else if (hasMinor) {
        out.push({ op: '<', ver: { ...p, minor: p.minor + 1, patch: 0, prerelease: [] } });
      } else {
        out.push({ op: '<', ver: { ...p, major: p.major + 1, minor: 0, patch: 0, prerelease: [] } });
      }
      break;

    case '~': // ~1.2.3 -> >=1.2.3 <1.3.0 ; ~1 -> >=1.0.0 <2.0.0
      out.push({ op: '>=', ver: p });
      if (hasMinor) {
        out.push({ op: '<', ver: { ...p, minor: p.minor + 1, patch: 0, prerelease: [] } });
      } else {
        out.push({ op: '<', ver: { ...p, major: p.major + 1, minor: 0, patch: 0, prerelease: [] } });
      }
      break;

    /**
     * `^` 的语义是「不改变最左边非零的那一位」：
     *   ^1.2.3 -> >=1.2.3 <2.0.0      ^0.2.3 -> >=0.2.3 <0.3.0
     *   ^0.0.3 -> >=0.0.3 <0.0.4      ^1.x   -> >=1.0.0 <2.0.0
     *   ^0.x   -> >=0.0.0 <1.0.0      ^0.0.x -> >=0.0.0 <0.1.0
     * 分支顺序很关键：必须**先判断 minor 是否非零**，否则 `^0.2.x`
     * 会被误判成 `^0.x` 而展开到 <1.0.0。
     */
    case '^':
      out.push({ op: '>=', ver: p });
      if (!hasMinor || wild.minor) {
        out.push({ op: '<', ver: { ...p, major: p.major + 1, minor: 0, patch: 0, prerelease: [] } });
      } else if (p.major > 0) {
        out.push({ op: '<', ver: { ...p, major: p.major + 1, minor: 0, patch: 0, prerelease: [] } });
      } else if (p.minor > 0) {
        out.push({ op: '<', ver: { ...p, minor: p.minor + 1, patch: 0, prerelease: [] } });
      } else if (wild.patch || !hasPatch) {
        out.push({ op: '<', ver: { ...p, minor: p.minor + 1, patch: 0, prerelease: [] } });
      } else {
        out.push({ op: '<', ver: { ...p, patch: p.patch + 1, prerelease: [] } });
      }
      break;

    default:
      throw new TypeError(`未知的比较符: ${op}`);
  }

  return out;
}

/**
 * 解析一个「比较符集合」（用空格分隔的多个条件，语义为 AND）。
 * @param {string} chunk 例如 `>=1.2.0 <2.0.0`
 * @returns {Array<{op:string, ver:object}>}
 */
function parseComparatorSet(chunk) {
  const text = chunk.trim();
  if (text === '' || text === '*' || text === 'x' || text === 'X') return []; // 空集合 = 恒真

  const out = [];
  // 逐 token 扫描：`^`, `~`, `>=`, `>`, `<=`, `<`, `=`, 以及裸版本
  const tokenRe = /(\^|~|>=|<=|>|<|=)?\s*([v]?[\dxX*]+(?:\.[\dxX*]+)?(?:\.[\dxX*]+)?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/g;

  let match;
  let matchedAny = false;
  while ((match = tokenRe.exec(text)) !== null) {
    matchedAny = true;
    const op = match[1] || '';
    const spec = match[2];

    // 先把预发布后缀 `/1.2.3-beta.1` 拆出来，否则构造 base 时会把它丢掉
    const withoutV = spec.replace(/^v/, '');
    const dashAt = withoutV.indexOf('-');
    const plusAt = withoutV.indexOf('+');
    let core = withoutV;
    let suffix = '';
    if (dashAt !== -1) {
      suffix = withoutV.slice(dashAt);
      core = withoutV.slice(0, dashAt);
    } else if (plusAt !== -1) {
      suffix = withoutV.slice(plusAt);
      core = withoutV.slice(0, plusAt);
    }
    // semver 规范：build metadata 不参与比较，直接丢掉
    const buildAt = suffix.indexOf('+');
    if (buildAt !== -1) suffix = suffix.slice(0, buildAt);

    const parts = core.split('.');
    const dotCount = core.split('.').length - 1;
    const hasMinor = dotCount >= 1;
    const hasPatch = dotCount >= 2;

    // 通配符处理：1.x / 1.2.x / * -> 视为区间
    const isWild = (s) => s === undefined || s === '' || s === 'x' || s === 'X' || s === '*';

    const majorW = isWild(parts[0]);
    const minorW = isWild(parts[1]);
    const patchW = isWild(parts[2]);

    if (majorW) {
      // `*` / `x`：恒真
      if (op === '' || op === '=' || op === '>=' || op === '<=') continue;
      throw new TypeError(`不支持的写法: ${spec}`);
    }

    const major = Number.parseInt(parts[0], 10);
    const minor = minorW ? 0 : Number.parseInt(parts[1], 10);
    const patch = patchW ? 0 : Number.parseInt(parts[2], 10);
    if (![major, minor, patch].every(Number.isFinite)) {
      throw new TypeError(`无法解析版本: ${spec}`);
    }

    const base = parse(`${major}.${minor}.${patch}${minorW || patchW ? '' : suffix}`);
    if (!base) throw new TypeError(`无法解析版本: ${spec}`);

    // 注意：`~1` / `^1` 这类「运算符 + 不完整版本」**不是**通配符，
    // 必须交给 expandOperator 按各自的语义展开；只有裸版本或带比较符的
    // `x`/`*` 才是真正的通配符。
    if ((minorW || patchW) && op !== '~' && op !== '^') {
      /**
       * 通配符展开必须**尊重原来的比较符**，这是 node-semver 的规则：
       *
       *   1.x     -> >=1.0.0 <2.0.0      <1.x    -> <1.0.0
       *   >1.x    -> >=2.0.0             <=1.x   -> <2.0.0
       *   1.2.x   -> >=1.2.0 <1.3.0      <1.2.x  -> <1.2.0
       *   >=1.2.x -> >=1.2.0             <=1.2.x -> <1.3.0
       *
       * 最初的实现无条件展开成 `>=low <high`，于是 `< 3` 被错误地变成
       * `>=3.0.0 <4.0.0` —— 这个 bug 是在深度打包 `safer-buffer` 时暴露的
       * （它的依赖范围是 `>= 2.1.2 < 3`，结果永远匹配不到任何版本）。
       */
      const low = base;
      const high = minorW
        ? { ...base, major: base.major + 1, minor: 0, patch: 0, prerelease: [] }
        : { ...base, minor: base.minor + 1, patch: 0, prerelease: [] };

      switch (op) {
        case '':
        case '=':
          out.push({ op: '>=', ver: low });
          out.push({ op: '<', ver: high });
          break;
        case '>':
          // `>1.2.x` 的语义是「比 1.2 这整个系列都大」，即 >= 下一个系列
          out.push({ op: '>=', ver: high });
          break;
        case '>=':
          out.push({ op: '>=', ver: low });
          break;
        case '<':
          out.push({ op: '<', ver: low });
          break;
        case '<=':
          out.push({ op: '<', ver: high });
          break;
        default:
          throw new TypeError(`通配符不支持比较符: ${op}${spec}`);
      }
      continue;
    }

    out.push(...expandOperator(op, base, hasMinor, hasPatch, { minor: minorW, patch: patchW }));
  }

  if (!matchedAny) throw new TypeError(`无法解析版本范围: ${text}`);
  return out;
}

/**
 * 解析完整版本范围（支持 `||` 并集）。
 * @param {string} range
 * @returns {Array<Array<{op:string, ver:object}>>} OR of AND 的二维结构
 */
export function parseRange(range) {
  const text = String(range ?? '').trim();
  if (text === '') return [[]]; // 空范围视为 `*`

  // 先展开连字符区间：`1.2.3 - 2.3.4` -> `>=1.2.3 <=2.3.4`
  const expanded = text.replace(
    /(\S+)\s+-\s+(\S+)/g,
    (_all, lo, hi) => {
      const loHasMinor = (lo.match(/\./g) || []).length >= 1;
      const hiHasMinor = (hi.match(/\./g) || []).length >= 1;
      const loHasPatch = (lo.match(/\./g) || []).length >= 2;
      const hiHasPatch = (hi.match(/\./g) || []).length >= 2;
      const low = loHasMinor ? `>=${lo}` : `>=${lo}.0.0`;
      const high = hiHasPatch ? `<=${hi}` : hiHasMinor ? `<=${hi}.x` : `<=${hi}.x.x`;
      return `${low} ${high}`;
    },
  );

  return expanded
    .split('||')
    .map((chunk) => parseComparatorSet(chunk.trim()));
}

/** 判断单个版本是否满足单个比较符。 */
function satisfiesComparator(version, { op, ver }) {
  const cmp = compare(version, ver);
  switch (op) {
    case '=':
      return cmp === 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    default:
      throw new TypeError(`未知比较符: ${op}`);
  }
}

/**
 * 判断版本是否落在范围内。
 * @param {string} version
 * @param {string} range
 */
export function satisfies(version, range) {
  const v = parse(version);
  if (!v) return false;

  const sets = parseRange(range);
  const isPre = v.prerelease.length > 0;

  return sets.some((set) => {
    if (!set.every((c) => satisfiesComparator(v, c))) return false;

    // 预发布版本的特殊规则（node-semver §"Prerelease Tags"）：
    // 只有当范围内某个比较符「显式提到了同样的 x.y.z 且带预发布标识」时才允许匹配。
    if (isPre) {
      return set.some(
        (c) => c.ver.prerelease.length > 0 && sameTriplet(c.ver, v),
      );
    }
    return true;
  });
}

/**
 * 在一批版本号中挑出满足范围的最高版本。
 * @param {string[]} versions
 * @param {string} range
 * @returns {string|null}
 */
export function maxSatisfying(versions, range) {
  let best = null;
  for (const raw of versions) {
    const v = parse(raw);
    if (!v) continue;
    if (!satisfies(v.raw, range)) continue;
    if (best === null || compare(v, best) > 0) best = v;
  }
  return best ? best.raw : null;
}

/** 判断某个 range 是否是精确版本（如 `1.2.3`）。 */
export function isExact(range) {
  const text = String(range ?? '').trim().replace(/^[v=]+/, '');
  return parse(text) !== null;
}

/** 取 [major, minor, patch] 三元组字符串，便于日志输出。 */
export function tripletOf(version) {
  return triplet(parse(version)).join('.');
}

export default {
  parse,
  valid,
  compare,
  rcompare,
  satisfies,
  maxSatisfying,
  parseRange,
  isPrerelease,
  isExact,
};
