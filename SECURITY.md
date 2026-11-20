# 安全待办（上线前必做）

## 在把真实客户 / 案件数据写入 Supabase 之前

- [ ] 轮换 Supabase 的 `SUPABASE_SECRET_KEY`：Supabase Dashboard → Project Settings → API → 重新生成 secret key。
- [ ] 更新本机 `.env` 里的 `SUPABASE_SECRET_KEY`。
- [ ] 更新 Vercel 项目的 `SUPABASE_SECRET_KEY` 环境变量（Production，至少）。
- [ ] 重新部署，确认线上注册、登录、草稿保存正常。
- [ ] 确认旧 secret key 已失效。

**原因**：本地旧服务一度把 `/.env` 当静态文件返回（已修复），无法证明暴露窗口内没有其他设备访问。当前只有测试数据，风险有限；真实客户数据前必须轮换。

## 日常

- `.env` 不要提交、不要发人、不要写进日志。
- Vercel 只通过环境变量注入密钥；浏览器端只使用 publishable key。
- 本地服务不使用时停掉，不要长期监听 `0.0.0.0`。
