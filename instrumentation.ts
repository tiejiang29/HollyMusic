/**
 * Next.js 服务端启动钩子（standalone 下随 server.js 启动执行一次）。
 *
 * config-sync 原挂在 /rest/[method] 路由的模块加载副作用上——只有访问
 * Subsonic /rest 接口才会触发，全新部署（无人用 Subsonic 客户端）永远不会
 * 创建 admin 初始账户，导致面板部署后无法登录。移到这里保证每次启动执行。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const configSync = (await import('@/lib/config-sync')).default
  configSync
    .syncUsersFromConfig()
    .then(r => console.info('[startup] config-sync result', r))
    .catch(e => console.warn('[startup] config-sync error', e))
}
