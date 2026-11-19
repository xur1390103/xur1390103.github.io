const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const DRAFTS_FILE = path.join(DATA_DIR, 'drafts.json');
const PORT = 3001;
const sessions = new Map();

async function ensureStore(file) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { await fs.access(file); } catch { await fs.writeFile(file, '[]\n', 'utf8'); }
}
async function readStore(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writeStore(file, value) { await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function matches(password, user) {
  const actual = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  const expected = Buffer.from(user.passwordHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function cookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}
function userFrom(request) { return sessions.get(cookies(request).brandSession); }
function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload));
}
function body(request) {
  return new Promise((resolve, reject) => {
    let text = '';
    request.on('data', chunk => { text += chunk; });
    request.on('end', () => { try { resolve(JSON.parse(text || '{}')); } catch { reject(new Error('请求格式不正确。')); } });
  });
}
async function serveFile(response, pathname) {
  const requested = pathname === '/' ? 'b/index.html' : `${pathname.slice(1)}${pathname.endsWith('/') ? 'index.html' : ''}`;
  const file = path.resolve(ROOT, requested);
  if (!file.startsWith(ROOT)) return sendJson(response, 403, { error: '无权访问该文件。' });
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
  try {
    const content = await fs.readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    response.end(content);
  } catch { if (!response.headersSent) sendJson(response, 404, { error: '页面不存在。' }); }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (request.method === 'POST' && url.pathname === '/api/register') {
      const { username = '', password = '', confirmPassword = '' } = await body(request);
      if (!/^[\w-]{3,20}$/.test(username) || password.length < 6) return sendJson(response, 400, { error: '账户为 3–20 位字母、数字、下划线或连字符；密码至少 6 位。' });
      if (password !== confirmPassword) return sendJson(response, 400, { error: '两次输入的密码不一致，请重新确认。' });
      const users = await readStore(USERS_FILE);
      if (users.some(item => item.username.toLowerCase() === username.toLowerCase())) return sendJson(response, 409, { error: '该账户已存在，请换一个。' });
      const { salt, hash } = hashPassword(password);
      const user = { id: crypto.randomUUID(), username, salt, passwordHash: hash, createdAt: new Date().toISOString() };
      users.push(user); await writeStore(USERS_FILE, users);
      return sendJson(response, 201, { message: '注册成功，请登录。' });
    }
    if (request.method === 'POST' && url.pathname === '/api/login') {
      const { username = '', password = '' } = await body(request);
      const user = (await readStore(USERS_FILE)).find(item => item.username.toLowerCase() === username.toLowerCase());
      if (!user || !matches(password, user)) return sendJson(response, 401, { error: '账户或密码错误。' });
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { id: user.id, username: user.username });
      return sendJson(response, 200, { user: { username: user.username } }, { 'Set-Cookie': `brandSession=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600` });
    }
    if (request.method === 'GET' && url.pathname === '/api/me') return sendJson(response, 200, { user: userFrom(request) || null });
    if (request.method === 'POST' && url.pathname === '/api/logout') {
      const token = cookies(request).brandSession; if (token) sessions.delete(token);
      return sendJson(response, 200, { message: '已退出。' }, { 'Set-Cookie': 'brandSession=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }
    if (url.pathname === '/api/draft') {
      const user = userFrom(request); if (!user) return sendJson(response, 401, { error: '请先登录。' });
      const drafts = await readStore(DRAFTS_FILE);
      if (request.method === 'GET') return sendJson(response, 200, { draft: drafts.find(item => item.userId === user.id) || null });
      if (request.method === 'PUT') {
        const { fields } = await body(request);
        if (!Array.isArray(fields) || fields.length !== 6 || fields.some(item => typeof item !== 'string' || item.length > 2000)) return sendJson(response, 400, { error: '草稿内容格式不正确。' });
        const next = { userId: user.id, fields, updatedAt: new Date().toISOString() };
        const index = drafts.findIndex(item => item.userId === user.id);
        if (index === -1) drafts.push(next); else drafts[index] = next;
        await writeStore(DRAFTS_FILE, drafts);
        return sendJson(response, 200, { message: '已暂存到这台电脑。', updatedAt: next.updatedAt });
      }
    }
    if (request.method === 'GET') return serveFile(response, url.pathname);
    return sendJson(response, 405, { error: '不支持的请求方式。' });
  } catch (error) {
    console.error(error); return sendJson(response, 400, { error: error.message || '请求处理失败。' });
  }
});

Promise.all([ensureStore(USERS_FILE), ensureStore(DRAFTS_FILE)]).then(() => server.listen(PORT, () => console.log(`本地作业已启动：http://localhost:${PORT}/b/`)));
