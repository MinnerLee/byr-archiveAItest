/**
 * HTTP 错误类型。
 *
 * 把「业务流程里发现的错误」和「网络层异常」区分开，
 * 让 handler 能用统一的方式把它们翻译成状态码 + 响应体。
 */

export class HttpError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} message 面向调用者的简短说明
   * @param {object} [extra] 附加信息（会写进响应 JSON）
   */
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

/** 400 请求格式非法。 */
export const badRequest = (msg, extra) => new HttpError(400, msg, extra);

/** 404 包 / 版本 / 文件不存在。 */
export const notFound = (msg, extra) => new HttpError(404, msg, extra);

/** 403 路径越权（目录穿越）。 */
export const forbidden = (msg, extra) => new HttpError(403, msg, extra);

/** 413 超过体积上限。 */
export const tooLarge = (msg, extra) => new HttpError(413, msg, extra);

/** 502 上游 registry 返回了异常结果。 */
export const upstreamError = (msg, extra) => new HttpError(502, msg, extra);

/** 504 上游超时。 */
export const gatewayTimeout = (msg, extra) => new HttpError(504, msg, extra);
