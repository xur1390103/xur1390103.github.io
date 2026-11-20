const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ROOT, handleApi, sendJson, translateError } = require('./api/_lib/core');

const PORT = Number(process.env.PORT || 3002);
const PUBLIC_ROOTS = new Set(['b', 'a', 'assets', 'log']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function staticFile(pathname) {
  if (pathname === '/') return path.join(ROOT, 'b', 'index.html');
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const parts = decoded.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part.startsWith('.'))) return null;
  if (parts.length === 1 && parts[0] === 'index.html') return path.join(ROOT, 'index.html');
  if (!PUBLIC_ROOTS.has(parts[0])) return null;
  const relative = parts.join('/') + (decoded.endsWith('/') ? '/index.html' : '');
  const file = path.resolve(ROOT, relative);
  const check = path.relative(ROOT, file);
  if (!check || check.startsWith('..') || path.isAbsolute(check)) return null;
  return file;
}

async function serveStatic(response, pathname) {
  const file = staticFile(pathname);
  if (!file) return sendJson(response, 404, { error: '页面不存在。' });
  try {
    const content = await fsp.readFile(file);
    response.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    response.end(content);
  } catch { sendJson(response, 404, { error: '页面不存在。' }); }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(request, response, url.pathname);
      if (!handled) sendJson(response, 404, { error: '接口不存在。' });
      return;
    }
    if (request.method === 'GET' || request.method === 'HEAD') return serveStatic(response, url.pathname);
    return sendJson(response, 405, { error: '不支持的请求方式。' });
  } catch (error) {
    console.error(error.status || 500, error.message);
    if (!response.headersSent) sendJson(response, error.status || 500, { error: translateError(error.message) || '请求处理失败。' });
  }
});

server.listen(PORT, () => console.log(`Supabase 验证服务已启动：http://localhost:${PORT}/b/`));
