/**
 * Next.js 服务端启动钩子（standalone 下随 server.js 启动执行一次）。
 *
 * config-sync 原挂在 /rest/[method] 路由的模块加载副作用上——只有访问
 * Subsonic /rest 接口才会触发，全新部署（无人用 Subsonic 客户端）永远不会
 * 创建 admin 初始账户，导致面板部署后无法登录。移到这里保证每次启动执行。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { logger } = await import('@/lib/logger')
  const configSync = (await import('@/lib/config-sync')).default
  configSync
    .syncUsersFromConfig()
    .then(r => console.info('[startup] config-sync result', r))
    .catch(e => console.warn('[startup] config-sync error', e))

  // 明文 HTTP 部署提醒（纯打印，不写任何内存态——写内存态的启动逻辑必须放路由侧模块，
  // 见 lib/music-source-manager.ts 的 wireSourceProbe 注释）
  const { cookieSecurityWarning } = await import('@/lib/services/auth')
  const cookieWarn = cookieSecurityWarning()
  if (cookieWarn) console.warn(cookieWarn)

  // 封面自动回填：启动首轮 + 每 6 小时自愈轮（kw/kg/tx 库内空 img 自动补齐）
  const { startCoverBackfillScheduler } = await import('@/lib/services/cover-backfill')
  startCoverBackfillScheduler()

  // 音源周测不挂在这里：它要写的是**取址侧那份**内存账本（3c 的跳过依据），而 Next 给
  // instrumentation 单独一套 lib 模块副本，从这边写进去路由读不到。改由
  // MusicSourceManager.initialize() 末尾拉起，见 lib/music-source-manager.ts 的 wireSourceProbe。

  // 首页「大家都在听」预热：trending 虽有 10 分钟内存缓存，但重启即空，冷启动首开
  // 要现场拉五平台热歌榜（秒级）。启动 5 秒后后台拉一次填掉第一跳——topPerSource=20
  // 与 Web/App 默认请求参数一致（缓存键含该值）；失败静默，getTrending 对空结果不缓存，
  // 用户首开时自然会重试。delay 让路给启动期的迁移/config-sync。
  setTimeout(() => {
    void (async () => {
      try {
        const { getTrending } = await import('@/lib/services/discovery-service')
        const r = await getTrending(20)
        logger.info('[startup] trending 预热完成:', r.list.length, '首')
      } catch (err) {
        logger.warn('[startup] trending 预热失败（不影响启动，首开时会重试）:', err)
      }
    })()
  }, 5_000)
}
