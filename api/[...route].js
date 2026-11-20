const { handleApi, sendJson, translateError } = require('./_lib/core');

module.exports = async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    const handled = await handleApi(request, response, url.pathname);
    if (!handled) sendJson(response, 404, { error: '接口不存在。' });
  } catch (error) {
    console.error(error.status || 500, error.message);
    if (!response.headersSent) sendJson(response, error.status || 500, { error: translateError(error.message) || '请求处理失败。' });
  }
};
