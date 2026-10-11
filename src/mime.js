/**
 * 扩展名 -> Content-Type 映射。
 *
 * 题目要求：根据文件扩展名在响应 header 中返回对应的 Content-Type，
 * 例如 json 需要 `application/json; charset=utf-8`。
 *
 * 实现要点：
 * - 文本类类型统一补 `charset=utf-8`，否则浏览器会按 latin-1 猜编码，中文会乱码；
 * - 二进制类（图片、字体、wasm）绝不加 charset，加了反而是错的；
 * - 无法识别的扩展名回退 `application/octet-stream`，让浏览器走下载。
 */

/**
 * 文本类类型 -> 需要追加 charset。
 * 只列出「文本」语义的类型，二进制不在此表中。
 */
const TEXT_TYPES = new Set([
  'application/json',
  'application/manifest+json',
  'application/ld+json',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/ecmascript',
  'application/x-javascript',
  'application/x-httpd-php',
  'application/x-sh',
  'application/x-yaml',
  'application/graphql',
  'application/sql',
  'application/node',
  'application/x-www-form-urlencoded',
  'image/svg+xml',
]);

/** 扩展名（小写、不含点）到 MIME 的映射表。 */
const MIME_TABLE = {
  // ---- JavaScript / TypeScript ----
  js: 'application/javascript',
  mjs: 'application/javascript',
  cjs: 'application/javascript',
  jsx: 'application/javascript',
  ts: 'application/typescript',
  mts: 'application/typescript',
  cts: 'application/typescript',
  tsx: 'application/typescript',
  map: 'application/json',

  // ---- 数据 ----
  json: 'application/json',
  json5: 'application/json',
  jsonc: 'application/json',
  webmanifest: 'application/manifest+json',
  ndjson: 'application/x-ndjson',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  yaml: 'application/x-yaml',
  yml: 'application/x-yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  wasm: 'application/wasm',

  // ---- 文档 / 文本 ----
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  css: 'text/css',
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  rst: 'text/x-rst',
  ini: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  env: 'text/plain',
  sh: 'application/x-sh',
  bash: 'application/x-sh',
  zsh: 'application/x-sh',
  ps1: 'text/plain',
  bat: 'text/plain',
  cmd: 'text/plain',
  sql: 'application/sql',
  graphql: 'application/graphql',
  gql: 'application/graphql',
  diff: 'text/plain',
  patch: 'text/plain',
  license: 'text/plain',
  gitignore: 'text/plain',
  npmignore: 'text/plain',
  npmrc: 'text/plain',
  editorconfig: 'text/plain',

  // ---- 图片 ----
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  apng: 'image/apng',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  cur: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',

  // ---- 字体 ----
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',

  // ---- 音视频 ----
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',

  // ---- 压缩 / 归档 ----
  gz: 'application/gzip',
  tgz: 'application/gzip',
  br: 'application/brotli',
  zip: 'application/zip',
  tar: 'application/x-tar',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',

  // ---- 其它 ----
  pdf: 'application/pdf',
  wasm2: 'application/wasm',
  exe: 'application/vnd.microsoft.portable-executable',
  node: 'application/octet-stream',
  pem: 'application/x-pem-file',
  crt: 'application/x-x509-ca-cert',
  cer: 'application/x-x509-ca-cert',
  key: 'application/x-pem-file',
  p12: 'application/x-pkcs12',
  pfx: 'application/x-pkcs12',
};

/** 没有扩展名时，按文件名猜测的类型。 */
const NO_EXT_TABLE = {
  license: 'text/plain',
  licence: 'text/plain',
  readme: 'text/markdown',
  changelog: 'text/markdown',
  makefile: 'text/plain',
  dockerfile: 'text/plain',
  '.gitignore': 'text/plain',
  '.npmignore': 'text/plain',
  '.npmrc': 'text/plain',
  '.babelrc': 'application/json',
  '.eslintrc': 'application/json',
  '.editorconfig': 'text/plain',
  '.prettierrc': 'application/json',
};

/**
 * 取文件路径的扩展名（小写、不含点）。
 * 特殊处理：点开头的隐藏文件（如 `.gitignore`）不算「有扩展名」，
 * 否则 `.gitignore` 会被解析成扩展名 `gitignore`。
 *
 * @param {string} filename 文件名或路径
 * @returns {string} 扩展名，没有则返回空串
 */
export function extname(filename) {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return ''; // dot === 0 表示 `.gitignore` 这类隐藏文件
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 判断某个 MIME 类型是否为文本类型（需要 charset）。
 * @param {string} mime
 */
export function isTextMime(mime) {
  return mime.startsWith('text/') || TEXT_TYPES.has(mime);
}

/**
 * 根据文件路径推导 Content-Type。
 *
 * @param {string} filePath 包内相对路径，如 `dist/vue.js`
 * @returns {string} 完整的 Content-Type，例如 `application/json; charset=utf-8`
 */
export function lookup(filePath) {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const ext = extname(filePath);

  if (ext === '') {
    // 无扩展名：先查特名字典（LICENSE / README / Dockerfile...）
    const named = NO_EXT_TABLE[base.toLowerCase()];
    if (named) return withCharset(named);
    // 全大写的 README 之类
    const namedUpper = NO_EXT_TABLE[base.toLowerCase().replace(/\.(md|txt)$/, '')];
    if (namedUpper) return withCharset(namedUpper);
    return 'application/octet-stream';
  }

  const mime = MIME_TABLE[ext] || 'application/octet-stream';
  return withCharset(mime);
}

/**
 * 给文本类 MIME 补上 charset。
 * @param {string} mime
 * @returns {string}
 */
export function withCharset(mime) {
  if (!isTextMime(mime)) return mime;
  if (/charset=/i.test(mime)) return mime;
  return `${mime}; charset=utf-8`;
}

export default { lookup, extname, isTextMime, withCharset };
