/**
 * tarball 完整性校验。
 *
 * 背景：npm registry 的元信息里带了完整性字段（`dist.integrity` 是 SRI 的
 * sha512、`dist.shasum` 是 sha1、`dist.fileCount` / `dist.unpackedSize` 是体积信息），
 * 它们是用来验证「下载到的东西确实是你请求的那个包」的。
 *
 * 这个项目最初只管下载、完全没校验 —— 是一个真实的缺陷：
 *   - 传输过程中损坏（CDN 边缘节点故障、代理截断）会把坏内容当成正常内容
 *     缓存下来并对外提供，而且因为缓存了 7 天，会持续错下去；
 *   - 私有源或中间链路上的任何篡改都不会被发现。
 *
 * 实现要点：**边流边算，不额外缓冲**。tarball 是流式解包的，
 * 如果为了校验先把整个包读进内存，就白费了流式设计。所以用一个 Transform
 * 在数据流过时更新哈希，解包结束后再比对。
 */

import { createHash } from 'node:crypto';

/**
 * 创建一个完整性校验器。
 *
 * @param {object} dist registry 返回的 `dist` 字段
 * @returns {{update:(chunk:Buffer)=>void, verify:()=>({ok:boolean, checks:Array<{algo:string, expected:string, actual:string, ok:boolean}>, skipped:string[]})}}
 */
export function createIntegrityChecker(dist = {}) {
  const sha512 = createHash('sha512');
  const sha1 = createHash('sha1');
  let bytes = 0;

  /**
   * 哈希对象只能 digest 一次，之后再调用会抛错。
   * 而同一个哈希可能被两个字段复用（例如 integrity 是 sha1-based 时，
   * sha1 既要给 integrity 比对又要给 shasum 比对），所以要记忆化。
   */
  /** @type {{sha512?:string, sha1base64?:string, sha1hex?:string}} */
  const memo = {};
  const sri512 = () => (memo.sha512 ??= `sha512-${sha512.digest('base64')}`);
  const sri1 = () => (memo.sha1base64 ??= `sha1-${sha1.digest('base64')}`);
  const hex1 = () => (memo.sha1hex ??= sha1.digest('hex'));

  return {
    /** 喂入一块数据（流式）。 */
    update(chunk) {
      bytes += chunk.length;
      sha512.update(chunk);
      sha1.update(chunk);
    },

    /**
     * 比对结果。
     *
     * 只校验元信息里**确实提供了**的字段：私有 registry 可能没有 integrity，
     * 这时不能因为「缺少期望值」就判定失败 —— 那是把「没校验」说成「校验失败」。
     *
     * @returns {{ok:boolean, checks:Array<{algo:string, expected:string, actual:string, ok:boolean}>, skipped:string[], bytes:number}}
     */
    verify() {
      const checks = [];
      const skipped = [];

      const expectedSri = dist.integrity;
      if (typeof expectedSri === 'string' && expectedSri.startsWith('sha512-')) {
        const actual = sri512();
        checks.push({ algo: 'sha512(SRI)', expected: expectedSri, actual, ok: actual === expectedSri });
      } else if (typeof expectedSri === 'string' && expectedSri.startsWith('sha1-')) {
        const actual = sri1();
        checks.push({ algo: 'sha1(SRI)', expected: expectedSri, actual, ok: actual === expectedSri });
      } else {
        skipped.push('integrity');
      }

      const expectedShasum = dist.shasum;
      if (typeof expectedShasum === 'string' && expectedShasum.length > 0) {
        const actual = hex1();
        checks.push({ algo: 'sha1(hex)', expected: expectedShasum, actual, ok: actual === expectedShasum });
      } else {
        skipped.push('shasum');
      }

      return {
        ok: checks.every((c) => c.ok),
        checks,
        skipped,
        bytes,
      };
    },
  };
}

/**
 * 把校验结果整理成一行可读的诊断文本。
 * @param {ReturnType<ReturnType<typeof createIntegrityChecker>['verify']>} result
 */
export function describe(result) {
  if (result.checks.length === 0) {
    return `上游未提供 integrity / shasum，跳过校验（已下载 ${result.bytes} 字节）`;
  }
  return result.checks
    .map((c) => `${c.algo} ${c.ok ? '匹配' : `**不匹配**（期望 ${c.expected}，实际 ${c.actual}）`}`)
    .join('；');
}

export default { createIntegrityChecker, describe };
