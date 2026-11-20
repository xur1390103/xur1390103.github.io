const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const config = {
  url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || '',
  secretKey: process.env.SUPABASE_SECRET_KEY || '',
};

const AUTH_MESSAGES = {
  'Invalid login credentials': '邮箱或密码不正确。',
  'Email not confirmed': '邮箱尚未验证。请先打开验证邮件中的链接完成验证。',
  'Email rate limit exceeded': '验证邮件发送过于频繁，请稍后再试（通常约 1 小时）。',
  'User already registered': '该邮箱已注册，请直接登录。',
  'Signups not allowed for this instance': '当前项目暂未开放注册。',
  'Password should be at least 6 characters.': '密码至少 6 位。',
};

function translateError(message = '') {
  if (AUTH_MESSAGES[message]) return AUTH_MESSAGES[message];
  const limited = message.match(/For security purposes, you can only request this after (\d+) seconds?/i);
  if (limited) return `操作过于频繁，请 ${limited[1]} 秒后再试。`;
  return message;
}

function configured() { return Boolean(config.url && config.publishableKey && config.secretKey); }

function cookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function isHttps(request) { return request.headers['x-forwarded-proto'] === 'https' || request.socket?.encrypted; }

function sessionHeaders(request, session) {
  const secure = isHttps(request) ? '; Secure' : '';
  return {
    'Set-Cookie': [
      `brandAccessToken=${encodeURIComponent(session.access_token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${session.expires_in}${secure}`,
      `brandRefreshToken=${encodeURIComponent(session.refresh_token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`,
    ],
  };
}

function clearSessionHeaders(request) {
  const secure = isHttps(request) ? '; Secure' : '';
  return {
    'Set-Cookie': [
      `brandAccessToken=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
      `brandRefreshToken=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
    ],
  };
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(payload));
}

function body(request) {
  if (request.body !== undefined && request.body !== null) {
    if (typeof request.body === 'object') return Promise.resolve(request.body);
    try { return Promise.resolve(JSON.parse(request.body || '{}')); } catch { return Promise.reject(Object.assign(new Error('请求格式不正确。'), { status: 400 })); }
  }
  return new Promise((resolve, reject) => {
    let text = '';
    request.on('data', chunk => { text += chunk; });
    request.on('end', () => {
      try { resolve(JSON.parse(text || '{}')); }
      catch { reject(Object.assign(new Error('请求格式不正确。'), { status: 400 })); }
    });
  });
}

async function supabase(pathname, { method = 'GET', key = config.publishableKey, accessToken, payload, headers = {} } = {}) {
  if (!configured()) throw Object.assign(new Error('服务尚未完成 Supabase 配置。'), { status: 503 });
  const response = await fetch(`${config.url}${pathname}`, {
    method,
    // sb_secret_/sb_publishable_ are API keys, not bearer JWTs; only forward a real user's access token.
    headers: { apikey: key, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const error = new Error(translateError(data?.msg || data?.message || data?.error_description || '服务请求失败。'));
    error.status = response.status;
    throw error;
  }
  return data;
}

function toUser(user) {
  return { id: user.id, email: user.email, displayName: user.user_metadata?.display_name || '用户' };
}

async function userFrom(request) {
  const accessToken = cookies(request).brandAccessToken;
  if (!accessToken) return null;
  try { return toUser(await supabase('/auth/v1/user', { accessToken })); } catch { return null; }
}

async function registrationConflicts(email, displayName) {
  const [usersPage, profiles] = await Promise.all([
    supabase('/auth/v1/admin/users?page=1&per_page=1000', { key: config.secretKey }),
    supabase(`/rest/v1/profiles?display_name=eq.${encodeURIComponent(displayName)}&select=id`, { key: config.secretKey }),
  ]);
  const emailExists = (usersPage.users || []).some(user => user.email?.toLowerCase() === email);
  return { emailExists, displayNameExists: profiles.length > 0 };
}

async function verifyTokenHash(tokenHash, type) {
  if (!configured()) throw Object.assign(new Error('服务尚未完成 Supabase 配置。'), { status: 503 });
  const types = [...new Set([type, 'signup', 'email'].filter(Boolean))];
  for (const candidate of types) {
    const response = await fetch(`${config.url}/auth/v1/verify?token_hash=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(candidate)}`, {
      headers: { apikey: config.publishableKey },
      redirect: 'manual',
    });
    if (response.status >= 200 && response.status < 400) return true;
    const text = await response.text();
    if (/already confirmed|already been confirmed/i.test(text)) return true;
  }
  return false;
}

async function handleApi(request, response, pathname) {
  if (request.method === 'POST' && pathname === '/api/register') {
    const { displayName = '', email = '', password = '', confirmPassword = '' } = await body(request);
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[\w-]{3,20}$/.test(displayName) || !/^\S+@\S+\.\S+$/.test(normalizedEmail) || String(password).length < 6) {
      return sendJson(response, 400, { error: '显示名称为 3–20 位字母、数字、下划线或连字符；请输入有效邮箱；密码至少 6 位。' }), true;
    }
    if (password !== confirmPassword) return sendJson(response, 400, { error: '两次输入的密码不一致，请重新确认。' }), true;
    const { emailExists, displayNameExists } = await registrationConflicts(normalizedEmail, displayName);
    if (emailExists && displayNameExists) return sendJson(response, 409, { error: '该显示名称和邮箱均已注册，请直接登录。' }), true;
    if (emailExists) return sendJson(response, 409, { error: '该邮箱已注册，请直接登录。' }), true;
    if (displayNameExists) return sendJson(response, 409, { error: '该显示名称已被使用，请更换一个。' }), true;
    const data = await supabase('/auth/v1/signup', { method: 'POST', payload: { email: normalizedEmail, password, data: { display_name: displayName } } });
    return sendJson(response, 201, { message: data.session ? '注册成功，请登录。' : '注册成功，请前往邮箱点击验证链接，再回来登录。', needsEmailConfirmation: !data.session }), true;
  }
  if (request.method === 'POST' && pathname === '/api/login') {
    const { email = '', password = '' } = await body(request);
    const data = await supabase('/auth/v1/token?grant_type=password', { method: 'POST', payload: { email: String(email).trim().toLowerCase(), password } });
    return sendJson(response, 200, { user: toUser(data.user) }, sessionHeaders(request, data)), true;
  }
  if (request.method === 'GET' && pathname === '/api/me') return sendJson(response, 200, { user: await userFrom(request) }), true;
  if (request.method === 'POST' && pathname === '/api/logout') {
    const token = cookies(request).brandAccessToken;
    if (token) await supabase('/auth/v1/logout', { method: 'POST', accessToken: token }).catch(() => undefined);
    return sendJson(response, 200, { message: '已退出。' }, clearSessionHeaders(request)), true;
  }
  if (request.method === 'GET' && pathname === '/api/confirm') {
    const url = new URL(request.url, 'http://localhost');
    const tokenHash = url.searchParams.get('token_hash') || '';
    const type = url.searchParams.get('type') || 'signup';
    if (!tokenHash) return sendJson(response, 400, { error: '验证链接不完整。' }), true;
    const ok = await verifyTokenHash(tokenHash, type);
    return ok
      ? (sendJson(response, 200, { ok: true }), true)
      : (sendJson(response, 400, { error: '验证链接已失效或已被使用，请重新获取。' }), true);
  }
  if (pathname === '/api/draft') {
    const user = await userFrom(request);
    if (!user) return sendJson(response, 401, { error: '请先登录。' }), true;
    if (request.method === 'GET') {
      const rows = await supabase(`/rest/v1/drafts?user_id=eq.${encodeURIComponent(user.id)}&select=fields,updated_at`, { key: config.secretKey });
      return sendJson(response, 200, { draft: rows[0] || null }), true;
    }
    if (request.method === 'PUT') {
      const { fields } = await body(request);
      if (!Array.isArray(fields) || fields.length !== 6 || fields.some(item => typeof item !== 'string' || item.length > 2000)) {
        return sendJson(response, 400, { error: '草稿内容格式不正确。' }), true;
      }
      const [draft] = await supabase('/rest/v1/drafts?on_conflict=user_id', {
        method: 'POST', key: config.secretKey,
        payload: { user_id: user.id, fields, updated_at: new Date().toISOString() },
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      });
      return sendJson(response, 200, { message: '已安全保存到云端。', updatedAt: draft.updated_at }), true;
    }
  }
  return false;
}

module.exports = { ROOT, configured, cookies, isHttps, sessionHeaders, clearSessionHeaders, sendJson, body, supabase, userFrom, registrationConflicts, handleApi, translateError };
