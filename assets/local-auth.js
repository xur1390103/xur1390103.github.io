async function localApi(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  } catch {
    throw new Error('无法连接服务。请确认服务已启动，并从服务地址打开此页面。');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败。');
  return data;
}
async function updateLocalAccountLink() {
  const menu = document.querySelector('[data-account-menu]');
  if (!menu) return;
  const loginLink = menu.querySelector('[data-login-link]');
  const trigger = menu.querySelector('[data-account-trigger]');
  const panel = menu.querySelector('[data-account-panel]');
  const { user } = await localApi('/api/me');
  if (!user) return;
  loginLink.classList.add('hidden');
  trigger.textContent = user.username;
  trigger.classList.remove('hidden');
  panel.classList.remove('hidden');
  trigger.addEventListener('click', event => {
    event.stopPropagation();
    const isOpen = menu.classList.toggle('open');
    trigger.setAttribute('aria-expanded', String(isOpen));
  });
  document.addEventListener('click', () => { menu.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false'); });
  panel.querySelector('[data-logout-button]').addEventListener('click', async () => {
    await localApi('/api/logout', { method: 'POST' });
    location.href = '/b/index.html';
  });
}
function redirectAfterLogin() {
  const next = new URLSearchParams(location.search).get('next');
  location.href = next && next.startsWith('/') ? next : '/b/my-draft.html';
}
