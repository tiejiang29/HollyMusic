/**
 * 音源发现面板（admin Tab 子组件）。
 *
 * 发现 → 判级 → 导入三步都在这里收口：候选表给元数据，红绿灯给"真能不能出货"，
 * 导入按钮才碰 config/music-sources.json。
 *
 * 配置全部在这里改（含 GitHub token）——改配置文件要登 NAS，管理员做不到也不该要求。
 * token 是**写入不回显**的：接口只返回脱敏尾巴，输入框留空表示不改动。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  dismissDiscoveryCandidate,
  getDiscovery,
  importDiscoveryCandidate,
  auditRepoFreshness,
  pruneOrphanCandidates,
  saveDiscoverySettings,
  searchDiscoveryRepos,
  startCandidateProbe,
  startCandidateProbeBatch,
  startDiscoveryCrawl,
  startDiscoveryDrain,
  stopDiscovery,
  type DiscoveryCandidate,
  type DiscoverySettingsView,
  type DiscoveryStatus,
  type ProbeCellView,
  type RepoFreshnessReport,
  type RepoSearchItemView,
  type RepoSearchResultView,
} from '@/lib/api/admin-source-discovery'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { Radar, RefreshCw, Loader2, Ban, KeyRound, Trash2, Link2, CheckCircle2, Download, Layers, Square, ListChecks, Search, Save, CalendarClock, Eraser } from 'lucide-react'
import { copyAddress } from '@/lib/utils/clipboard'

const FILTERS = [
  { key: 'suspect', label: '疑似可用', verdict: 'suspect', state: 'new' },
  { key: 'pending', label: '待判定', verdict: 'pending', state: 'new' },
  { key: 'not-source', label: '不像音源', verdict: 'not-source', state: 'new' },
  { key: 'imported', label: '已导入', verdict: '', state: 'imported' },
  { key: 'stale', label: '已被顶掉', verdict: '', state: 'stale' },
] as const

/**
 * 一行候选的地址格：地址本身**始终可读可选**，复制只是锦上添花。
 * 单独抽出来是因为它有一档真实环境里的降级行为（HTTP 无剪贴板），值得直测。
 */
export function AddressCell({ rawUrl, copied, onCopy }: { rawUrl: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="mt-1 flex items-start gap-2">
      <code className="min-w-0 flex-1 break-all rounded bg-accent/40 px-1.5 py-0.5 text-[11px]">{rawUrl}</code>
      <button
        type="button"
        onClick={onCopy}
        title="复制这条 raw 地址；HTTP 下浏览器可能拒绝，那就直接选中复制"
        className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {copied ? <CheckCircle2 className="h-3 w-3 text-green-600" /> : <Link2 className="h-3 w-3" />}
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  )
}

/**
 * 判级红绿灯：一格一个平台，颜色只说"真出货没有"，细节全在 title 里。
 *
 * 单独导出是为了能直测 —— 这格的语义（ok / 各种坏 / 还没判）是管理员要做决定的依据，
 * 不能靠"看起来对"。
 */
export function ProbeLights({ cells }: { cells: Record<string, ProbeCellView> }) {
  const platforms = Object.keys(cells)
  if (!platforms.length) return <span className="text-muted-foreground">—</span>
  return (
    <span className="flex flex-wrap gap-1">
      {platforms.map(platform => {
        const cell = cells[platform]
        const ok = cell.outcome === 'ok'
        // 通道没判成用灰色：红=这格真不行，灰=我们没测出来，两者对管理员是不同动作（后者该重判）
        const harness = cell.outcome === 'harness'
        const label = OUTCOME_LABEL[cell.outcome] ?? cell.outcome
        return (
          <span
            key={platform}
            title={`${PLATFORM_LABELS[platform] ?? platform}：${label}${cell.latencyMs != null ? ` ${cell.latencyMs}ms` : ''}${cell.container ? `｜${cell.container}` : ''}${cell.reason ? `｜${cell.reason}` : ''}`}
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              ok ? 'bg-green-600/15 text-green-700'
                : harness ? 'bg-accent text-muted-foreground'
                  : 'bg-destructive/15 text-destructive'
            }`}
          >
            {PLATFORM_LABELS[platform] ?? platform}
          </span>
        )
      })}
    </span>
  )
}

/**
 * 判级里真出货的平台数 —— 导入按钮的依据。
 *
 * 导出是为了能直测：服务端 `importCandidate` 有同一条判据（至少一格 ok），
 * 两边算得不一样时，按钮会说"可以装"而接口回你 409，管理员看到的就是自相矛盾。
 */
export function okPlatformCount(cells: Record<string, ProbeCellView> | undefined): number {
  if (!cells) return 0
  return Object.values(cells).filter(cell => cell.outcome === 'ok').length
}

/**
 * 一次点击能不能直接导？判级有平台出货**且**没撞上库里已有的同名源，才算"直接"。
 *
 * 导出是为了能直测：服务端 `importCandidate` 有同一套判据（至少一格 ok；同名要 force），
 * 两边算得不一样时，按钮会说"可以装"而接口回你 409，管理员看到的就是自相矛盾。
 */
export function needsForceConfirm(row: Pick<DiscoveryCandidate, 'probe' | 'duplicateOf'>): boolean {
  return okPlatformCount(row.probe?.cells) === 0 || row.duplicateOf?.kind === 'name'
}

/**
 * 「仍然判级」——静态分读不懂、但长得像一份真载荷的候选，允许人工送去真跑一次。
 *
 * 混淆过的音源脚本没有 `musicSearch` 这类字面量，静态打分必然不过线，可它照样能出货；
 * 而"跑一次"是唯一能证明这件事的手段。判据与服务端 `looksLikeObfuscatedSource` 同一条
 * （@name 非空 + 正文 20KB~1MB），两边不一致的话按钮会点亮而判级失败信息只在进度里闪一下。
 * 体积窗口不是装饰：小于 20KB 多半是碎屑，大于 1MB 多半打包了二进制，白打第三方取址接口。
 */
export function canForceProbe(row: Pick<DiscoveryCandidate, 'verdict' | 'scriptName' | 'sizeBytes'>): boolean {
  return row.verdict === 'not-source'
    && row.scriptName.trim().length > 0
    && row.sizeBytes >= 20 * 1024
    && row.sizeBytes <= 1024 * 1024
}

/**
 * 搜索结果的一行，附"多久之前推送"那句话。
 * 时间差在**拿到结果的那一刻**算好，不在 render 里算：一来 React 要求 render 纯净
 * （每次重渲染调 Date.now() 会让同一份结果显示着变来变去），二来"上次搜索时它是多久前的仓"
 * 本来就该跟着那次搜索走。
 */
type RepoSearchRow = RepoSearchItemView & { ageBadge: string }
type RepoSearchView = Omit<RepoSearchResultView, 'items'> & { items: RepoSearchRow[] }

/**
 * 把搜索勾选的仓并进现有清单：保持原顺序、后面追加新的、去重。
 *
 * 导出是为了能直测：服务端 `saveDiscoverySettings` 也会 normalize + 去重，
 * 但"面板算出来的清单"和"存进去的清单"如果对不上，管理员在文本框里看到的就是假象。
 */
export function mergeRepos(current: string[], added: string[]): string[] {
  const out: string[] = []
  for (const repo of [...current, ...added]) {
    const trimmed = repo.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/**
 * 「名字近似」那句提示的文案。**只提示，不参与任何判据**：导入按钮要不要二次确认仍由
 * `needsForceConfirm`（内容/同名撞车 + 有没有出货）说了算，这句不改它。
 *
 * 为什么需要：作者给同一个源起的名字会漂移（`lx-玉宁熙V1.2.2` → `lx-玉宁熙-Pro`），
 * 归一键剥得掉版本号却剥不掉 `Pro` 这种后缀，于是两条既不撞内容也不撞同名，看着像无关的新源。
 * 已经有硬撞车时不再补这句 —— 同一格里两句话会被读成两件事。
 */
export function similarNameBadge(row: Pick<DiscoveryCandidate, 'duplicateOf' | 'similarTo'>): string | null {
  if (row.duplicateOf || !row.similarTo) return null
  return `库里有条名字近似的源 → ${row.similarTo.name || row.similarTo.path}（可能是同一个源的另一个版本）`
}

const STALE_REPO_DAYS = 365

/**
 * 从清单里剔掉勾选的仓。
 * 导出是为了能直测：剔完还要过"清单不能为空"那一档（与服务的 prune 同一条护栏）——
 * 面板算错一次就能把 28 个仓剔成 0 个，接着那个清理按钮会把整张候选表都当成失效仓删掉。
 */
export function reposAfterRemoval(current: string[], removing: string[]): string[] {
  const doomed = new Set(removing)
  return current.filter(repo => !doomed.has(repo))
}

type FreshnessRow = { daysSince: number | null; archived: boolean; missing: boolean; movedTo: string }

/**
 * 一行体检结论的人话标签。顺序有讲究：先说"仓没了/归档了"这类硬事实，再说超阈值。
 * 阈值必须跟着体检那次走：不然把阈值调成 200 天时，一条 250 天没动的仓会被服务端判成
 * 该剔、面板却显示"正常在更"——勾着红叉的行自己说没事，管理员就没法信这张表了。
 * `daysSince === null` 说的是"GitHub 没给可读的时间"，不是"这个仓新"。
 */
export function freshnessBadges(row: FreshnessRow, maxAgeDays: number): string[] {
  const out: string[] = []
  if (row.missing) out.push('已消失(404)')
  if (row.archived) out.push('已归档')
  if (row.daysSince != null) {
    if (row.daysSince > maxAgeDays) {
      out.push(row.daysSince > STALE_REPO_DAYS ? `停更 ${Math.floor(row.daysSince / 365)} 年+` : `超阈值 ${row.daysSince} 天（阈值 ${maxAgeDays}）`)
    }
  } else {
    out.push('读不到推送时间')
  }
  if (row.movedTo) out.push(`改名 → ${row.movedTo}`)
  return out
}

/**
 * 搜索结果里的"最近推送"给管理员一句人话：清单一次就 27 个仓，引进来一个停更两年的仓
 * 等于给每轮白加一次树调用（我们上一次清理就是按满一年剔的 11 个仓）。
 */
export function repoAgeBadge(lastPushAt: string, nowMs: number): string {
  if (!lastPushAt) return ''
  const pushed = Date.parse(lastPushAt)
  if (!Number.isFinite(pushed)) return ''
  const days = Math.floor((nowMs - pushed) / 86_400_000)
  if (days < 0) return ''
  if (days <= 7) return `${days} 天前动过`
  if (days < STALE_REPO_DAYS) return `${Math.round(days / 30)} 个月前`
  return `停更 ${Math.floor(days / 365)} 年+`
}

const OUTCOME_LABEL: Record<string, string> = {
  ok: '真出货',
  'no-address': '没给地址',
  timeout: '超时',
  error: '脚本报错',
  fake: '假地址(非音频)',
  ssrf: '私网地址',
  'http-error': 'HTTP 错',
  'head-error': '首块拉不动',
  unverified: '未验证',
  unsupported: '不支持',
  'load-failed': '初始化失败',
  'no-sample': '库里无基准样本',
  harness: '通道没判成(可重判)',
}

const PLATFORM_LABELS: Record<string, string> = {
  tx: '腾讯', wy: '网易', kw: '酷我', kg: '酷狗', mg: '咪咕', _: '加载',
}

export function SourceDiscoveryPanel() {
  const [settings, setSettings] = useState<DiscoverySettingsView | null>(null)
  const [status, setStatus] = useState<DiscoveryStatus | null>(null)
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>(FILTERS[0])
  const [reposText, setReposText] = useState('')
  const [budgetText, setBudgetText] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  // 文本框里正在编辑的内容别被轮询覆写：dirty 时不跟随服务端，保存成功后再解除
  const reposDirty = useRef(false)
  const budgetDirty = useRef(false)
  const [searchQuery, setSearchQuery] = useState('lxmusic source')
  const [searchSort, setSearchSort] = useState<'best' | 'updated' | 'stars'>('updated')
  const [searchResult, setSearchResult] = useState<RepoSearchView | null>(null)
  const [searchPicked, setSearchPicked] = useState<string[]>([])
  const [searching, setSearching] = useState(false)
  const [addingRepos, setAddingRepos] = useState(false)
  const [scanOnlyAdded, setScanOnlyAdded] = useState(true)
  const [searchNote, setSearchNote] = useState<string | null>(null)
  const [freshnessDays, setFreshnessDays] = useState('365')
  const [freshnessReport, setFreshnessReport] = useState<RepoFreshnessReport | null>(null)
  const [freshnessPicked, setFreshnessPicked] = useState<string[]>([])
  const [checkingFresh, setCheckingFresh] = useState(false)
  const [removingFresh, setRemovingFresh] = useState(false)
  const [pruneAfterRemove, setPruneAfterRemove] = useState(true)
  const [freshNote, setFreshNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const [importingId, setImportingId] = useState<number | null>(null)
  // 判级没出货的候选要点两下：第一下只把按钮变成「确认强制导入」。
  // force 是"管理员对着红灯坚持要装"那一档，不该一次点击就能触发。
  const [forceConfirmId, setForceConfirmId] = useState<number | null>(null)
  const [pruning, setPruning] = useState(false)
  const [importNote, setImportNote] = useState<string | null>(null)
  // 面板跑在明文 HTTP 上（NAS 局域网），非安全上下文里 navigator.clipboard 直接不存在，
  // 所以必须能降级成"手动选中"，否则这个按钮在真实环境是死的
  const [clipboardBlocked, setClipboardBlocked] = useState(false)

  const reload = useCallback(async () => {
    try {
      const view = await getDiscovery({ verdict: filter.verdict || undefined, state: filter.state || undefined })
      setSettings(view.settings)
      setStatus(view.status)
      setCandidates(view.candidates)
      setCounts(view.counts)
      // 只要没在编辑就跟服务端同步：原先的条件是"空且没在跑才填"，
      // 于是"边跑边打开面板"会让文本框一直空着，而下方的保存按钮照样会把空清单写进库
      if (!reposDirty.current) setReposText(view.settings.repos.join('\n'))
      if (!budgetDirty.current) setBudgetText(String(view.settings.maxDownloadsPerRound))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    // 不 setLoading(true)：首屏初值已经是 true。set-state-in-effect 那条告警与既有面板
    // 同源（LoginLocks/Users 等一共 6 处同型写法），不是这里能单独消掉的
    void reload()
  }, [reload])

  // 有一轮发现、一次连轮、一批判级或一次判级在跑就轮进度，都停下来自动收（不留着空转）
  useEffect(() => {
    if (!status?.running && !status?.draining && !status?.probeBatch?.running && status?.probingId == null) {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
      return
    }
    pollRef.current = setInterval(() => { void reload() }, 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [status?.running, status?.draining, status?.probeBatch?.running, status?.probingId, reload])

  /**
   * 只把传进来的那几个字段写回去。
   * 原先这里是"无论改什么都顺手把文本框里的 repos 一起存"，于是清空文本框再点 token 的
   * 「保存」就会把扫描清单抹掉 —— 每个字段只管自己，仓库清单只有它自己的按钮能动。
   */
  const savePatch = async (patch: Parameters<typeof saveDiscoverySettings>[0]) => {
    setSaving(true)
    try {
      const result = await saveDiscoverySettings(patch)
      setSettings(result.settings)
      if (result.rejected.length) {
        alert(`这些写法没被接受（要 owner/repo）：\n${result.rejected.join('\n')}`)
      }
      if (patch.repos !== undefined) {
        reposDirty.current = false
        setReposText(result.settings.repos.join('\n'))
      }
      if (patch.maxDownloadsPerRound !== undefined) {
        budgetDirty.current = false
        setBudgetText(String(result.settings.maxDownloadsPerRound))
      }
      // 只在这次真的存了 token 才清空输入框：否则"顺手保存一下仓库清单"会把手打的 token 抹掉
      if (patch.githubToken !== undefined) setTokenInput('')
      return result
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败')
      return null
    } finally {
      setSaving(false)
    }
  }

  const handleRepoSave = async () => {
    const repos = reposText.split(/[\n,，]/).map(line => line.trim()).filter(Boolean)
    if (!repos.length && !confirm('仓库清单是空的：保存后「开始发现」会没有目标，之前采到的候选也不会被清掉。确认要清空？')) {
      return
    }
    await savePatch({ repos })
  }

  const handleTokenSave = async () => {
    const token = tokenInput.trim()
    if (!token) {
      alert('输入框是空的：留空表示不改动 token。要清掉已配的请点右边「清除 token」')
      return
    }
    await savePatch({ githubToken: token })
  }

  const handleCrawl = async () => {
    setStarting(true)
    try {
      await startDiscoveryCrawl()
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : '起不来这一轮')
    } finally {
      setStarting(false)
    }
  }

  const handleDrain = async () => {
    setStarting(true)
    try {
      const result = await startDiscoveryDrain()
      if (!result.started) alert(result.reason ?? '已有任务在跑')
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : '起不来连轮')
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    try {
      const result = await stopDiscovery()
      if (!result.stopping) alert('现在没有在跑的任务')
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : '停止请求没送出去')
    }
  }

  const handleBudgetSave = async () => {
    const parsed = Number.parseInt(budgetText, 10)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2000) {
      alert('每轮抓正文上限要填 0~2000 的整数')
      return
    }
    await savePatch({ maxDownloadsPerRound: parsed })
  }

  const handleSearch = async (page = 1) => {
    setSearching(true)
    try {
      const result = await searchDiscoveryRepos(searchQuery.trim(), { page, sort: searchSort })
      const nowMs = Date.now()
      setSearchResult({ ...result, items: result.items.map(item => ({ ...item, ageBadge: repoAgeBadge(item.lastPushAt, nowMs) })) })
      // 换页/换词就重选：跨页留着勾选会让人以为已经勾上，实际看不见
      setSearchPicked([])
      setSearchNote(null)
    } catch (e) {
      setSearchResult(null)
      alert(e instanceof Error ? e.message : '搜索失败')
    } finally {
      setSearching(false)
    }
  }

  const togglePicked = (repo: string) => {
    setSearchPicked(prev => prev.includes(repo) ? prev.filter(item => item !== repo) : [...prev, repo])
  }

  /**
   * 把勾选的仓并进扫描清单（这就是唯一入清单的路，搜索本身不改配置）。
   * `scanOnlyAdded` 决定要不要顺手只扫这几个新仓 —— 不勾就只是进清单，等下一轮全量扫。
   */
  const handleAddPicked = async () => {
    const rows = (searchResult?.items ?? []).filter(item => searchPicked.includes(item.repo) && !item.alreadyListed)
    if (!rows.length) {
      alert('先勾选至少一个还没进清单的仓库')
      return
    }
    setAddingRepos(true)
    try {
      const merged = mergeRepos(settings?.repos ?? [], rows.map(row => row.repo))
      const result = await savePatch({ repos: merged })
      if (!result) return
      const addedNow = rows.map(row => row.repo).filter(repo => result.settings.repos.includes(repo))
      if (!addedNow.length) {
        setSearchNote('勾选的仓没被接受（要 owner/repo 的写法）')
        return
      }
      if (!scanOnlyAdded) {
        setSearchNote(`已把 ${addedNow.length} 个仓加进扫描清单，下次点「开始发现」会扫到`)
        await reload()
        return
      }
      if (!settings?.enabled) {
        setSearchNote(`已把 ${addedNow.length} 个仓加进清单，但「启用音源发现」还没打开，所以没起扫描`)
        await reload()
        return
      }
      const started = await startDiscoveryCrawl(addedNow)
      setSearchNote(!started.started
        ? `已加进清单（${addedNow.length} 个），但这一轮没起来：${started.reason ?? '已有任务在跑'}`
        : `已加进清单，并起了一轮「只扫这 ${addedNow.length} 个仓」的发现`)
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : '加入清单失败')
    } finally {
      setAddingRepos(false)
    }
  }

  const handleFreshness = async () => {
    const parsed = Number.parseInt(freshnessDays, 10)
    if (!Number.isFinite(parsed) || parsed < 30 || parsed > 3650) {
      alert('停更阈值要填 30~3650 的天数（默认 365，就是我们上次剔仓用的那把尺子）')
      return
    }
    setCheckingFresh(true)
    try {
      const report = await auditRepoFreshness(parsed)
      // 判停更/失效的排前面：一屏看得见要处理的那几行，不用在 28 行里找
      const sorted = [...report.items].sort((a, b) => Number(b.stale) - Number(a.stale))
      setFreshnessReport({ ...report, items: sorted })
      setFreshnessPicked(report.items.filter(item => item.stale).map(item => item.repo))
      setFreshNote(null)
    } catch (e) {
      setFreshnessReport(null)
      alert(e instanceof Error ? e.message : '体检失败')
    } finally {
      setCheckingFresh(false)
    }
  }

  /**
   * 把勾选的仓移出扫描清单。剔完还能顺手清掉它们留下的候选行（就是那个「清理已移除仓的候选」），
   * 这两步本来是同一件事：仓不扫了，留在表里的候选就再也不会被刷新。
   */
  const handleRemoveStale = async () => {
    const removing = (freshnessReport?.items ?? []).filter(item => freshnessPicked.includes(item.repo))
    if (!removing.length) {
      alert('先勾选要移出的仓库')
      return
    }
    const next = reposAfterRemoval(settings?.repos ?? [], removing.map(item => item.repo))
    if (!next.length) {
      alert('清单不能剔空：那样「清理已移除仓的候选」会把整张候选表都当成失效仓删掉。至少留一个仓。')
      return
    }
    if (!confirm(`把 ${removing.length} 个仓移出扫描清单？\n${removing.map(item => item.repo).join('\n')}`)) return

    setRemovingFresh(true)
    try {
      const result = await savePatch({ repos: next })
      if (!result) return
      let note = `已移出 ${removing.length} 个仓，清单剩 ${result.settings.repos.length} 个`
      if (pruneAfterRemove) {
        const pruned = await pruneOrphanCandidates()
        note += `；顺手清掉 ${pruned.removed} 行候选`
        if (pruned.keptImported.length) note += `（保留 ${pruned.keptImported.length} 行已导入的）`
      }
      setFreshNote(note)
      setFreshnessReport(null)
      setFreshnessPicked([])
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : '移出失败')
    } finally {
      setRemovingFresh(false)
    }
  }

  const handlePrune = async () => {
    if (!confirm('清掉「已不在扫描列表里的仓」留下的候选行？已导入成音源的会保留。这一步不可撤销（重新把仓加回列表会当新候选重采）。')) return
    setPruning(true)
    try {
      const result = await pruneOrphanCandidates()
      setImportNote(`清理完成：删掉 ${result.removed} 行候选`
        + (result.keptImported.length ? `；保留 ${result.keptImported.length} 行已导入的（${result.keptImported.join('；')}）` : ''))
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : '清理失败')
    } finally {
      setPruning(false)
    }
  }

  const handleCopy = async (rawUrl: string, id: number) => {
    const result = await copyAddress(rawUrl, navigator.clipboard)
    if (result === 'copied') {
      setCopiedId(id)
      setClipboardBlocked(false)
    } else {
      setCopiedId(null)
      setClipboardBlocked(true)
    }
  }

  const handleProbe = async (id: number, force = false) => {
    try {
      const result = await startCandidateProbe(id, force)
      if (!result.started) alert(result.reason ?? '已有判级在跑')
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : '判级失败')
    }
  }

  const handleProbeBatch = async () => {
    try {
      const result = await startCandidateProbeBatch()
      if (!result.started) alert(result.reason ?? '已有一批判级在跑')
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : '批量判级起不来')
    }
  }

  const handleDismiss = async (id: number) => {
    try {
      await dismissDiscoveryCandidate(id)
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : '操作失败')
    }
  }

  const handleImport = async (row: DiscoveryCandidate) => {
    const forced = needsForceConfirm(row)
    if (forced && forceConfirmId !== row.id) {
      setForceConfirmId(row.id)
      return
    }
    setForceConfirmId(null)
    setImportingId(row.id)
    try {
      const result = await importDiscoveryCandidate(row.id, forced)
      setImportNote(`已导入为「${result.imported.name}」（${result.imported.path}），到「音源管理」可调优先级或直接停用`)
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : '导入失败')
    } finally {
      setImportingId(null)
    }
  }

  /**
   * 分类页签上的计数。counts 的键是 `verdict/state`，所以页签给的两个维度都得各自匹配
   * （空串=不限）—— 之前只按一个键名前缀筛，"已被顶掉/已导入"这类按 state 分的页签恒显示 0。
   */
  const countOf = (verdict: string, state: string) => Object.entries(counts)
    .filter(([compound]) => {
      const [rowVerdict, rowState] = compound.split('/')
      return (!verdict || rowVerdict === verdict) && (!state || rowState === state)
    })
    .reduce((sum, [, n]) => sum + n, 0)

  const typedRepos = reposText.split(/[\n,，]/).map(line => line.trim()).filter(Boolean)
  const pickedNew = (searchResult?.items ?? []).filter(item => searchPicked.includes(item.repo) && !item.alreadyListed)

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <Radar className="h-5 w-5 text-primary" />
            音源发现
          </h2>
          <p className="text-sm text-muted-foreground">
            从 GitHub 仓库树里挑出疑似洛雪音源脚本，静态打分去重后进候选表；「判级」在一次性沙箱里真取一次址，
            点过「导入」才会把它装进音源列表。列表按**判级真出货的格数**从多到少排，没判过的按静态分排在后面等判。
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => { setLoading(true); void reload() }}
            className="flex items-center gap-1 rounded-full px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="h-4 w-4" /> 刷新
          </button>
          <button
            onClick={handleCrawl}
            disabled={starting || saving || !settings?.enabled || status?.running}
            className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status?.running || starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
            {status?.running ? '本轮进行中' : '开始发现'}
          </button>
          <button
            onClick={handleDrain}
            disabled={starting || saving || !settings?.enabled || status?.running || status?.draining}
            title="一轮把「每轮抓正文上限」吃满就自动接下一轮，直到没有待判定 —— 存量几千条时不用人守着点"
            className="flex items-center gap-1 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status?.draining ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}
            {status?.draining ? `连轮中 第 ${status.round} 轮` : '连轮清完'}
          </button>
          <button
            onClick={handleProbeBatch}
            disabled={starting || saving || !settings?.enabled || status?.running || status?.draining || Boolean(status?.probeBatch?.running)}
            title="把「疑似可用」页签里没判过的候选排队逐条判（一批最多 50 条，串行）。实测一条几秒到一分多钟 —— 判不动的平台要等超时档，所以一批约 8 分钟；判级是真打第三方取址接口，所以分批"
            className="flex items-center gap-1 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status?.probeBatch?.running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />}
            {status?.probeBatch?.running ? `判级中 ${status.probeBatch.done}/${status.probeBatch.total}` : '批量判级'}
          </button>
          {status?.running || status?.draining || status?.probeBatch?.running ? (
            <button
              onClick={handleStop}
              disabled={Boolean(status?.stopRequested)}
              title="已经在抓的那一条会抓完，之后的都停下；连轮不再起下一轮，判级不再起下一条"
              className="flex items-center gap-1 rounded-full border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Square className="h-4 w-4" />
              {status?.stopRequested ? '停止中…' : '停止'}
            </button>
          ) : null}
        </div>
      </div>

      {loading ? (
        <LoadingSkeleton count={4} />
      ) : error ? (
        <EmptyState icon={Radar} title="加载失败" description={error} />
      ) : (
        <>
          <div className="mb-6 rounded-lg border border-border p-4">
            <label className="mb-3 flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={Boolean(settings?.enabled)}
                onChange={e => {
                  const enabled = e.target.checked
                  setSettings(prev => prev ? { ...prev, enabled } : prev)
                  void savePatch({ enabled })
                }}
              />
              启用音源发现（默认关，因为它会向 GitHub 发起请求）
            </label>

            <div className="mb-3">
              <div className="mb-1 text-xs uppercase text-muted-foreground">扫描的仓库（一行一个 owner/repo）</div>
              <textarea
                value={reposText}
                onChange={e => { reposDirty.current = true; setReposText(e.target.value) }}
                rows={6}
                spellCheck={false}
                className="w-full rounded border border-border bg-background p-2 font-mono text-xs"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <button
                  onClick={() => { void handleRepoSave() }}
                  disabled={saving}
                  title="把文本框里的这份清单写进库。只有这个按钮动仓库清单——改 token、改每轮上限都不会顺手改它"
                  className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 font-medium hover:bg-accent/70 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  保存仓库清单
                </button>
                <span className="text-muted-foreground">
                  库里 {settings?.repos.length ?? 0} 个
                  {typedRepos.length !== (settings?.repos.length ?? 0) ? `，文本框里 ${typedRepos.length} 个（还没保存）` : ''}
                </span>
                <button
                  onClick={handlePrune}
                  disabled={pruning}
                  title="把「已从这个列表里移除的仓」留下的候选行清掉。已导入成音源的行会保留；重新把某个仓加回来会当新候选重采一遍。"
                  className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  {pruning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                  清理已移除仓的候选
                </button>
              </div>
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <label className="uppercase text-muted-foreground" htmlFor="discovery-budget">每轮抓正文上限</label>
              <input
                id="discovery-budget"
                type="number"
                min={0}
                max={2000}
                value={budgetText}
                onChange={e => { budgetDirty.current = true; setBudgetText(e.target.value) }}
                disabled={saving}
                className="w-24 rounded border border-border bg-background px-2 py-1 font-mono"
              />
              <button
                onClick={handleBudgetSave}
                disabled={saving}
                className="rounded bg-accent px-3 py-1.5 font-medium hover:bg-accent/70 disabled:opacity-50"
              >
                保存
              </button>
              <span className="text-muted-foreground">
                待判定条数 ÷ 这个数 = 要跑几轮；点「连轮清完」就不用一轮一轮手点。填 0 表示这轮只登记文件、不抓正文。
              </span>
            </div>

            <div className="mb-3">
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={Boolean(settings?.preferLatestRelease)}
                  onChange={e => { void savePatch({ preferLatestRelease: e.target.checked }) }}
                />
                <span>
                  <span className="font-medium">有 release 的仓只取最新一次发布的 .js 资产</span>
                  <span className="block text-muted-foreground">
                    关掉它就一律改扫仓库 tree。实测某个仓的 tree 里堆着 969 个历史版本 .js，
                    而它最新一次发布只有 1 个资产 —— 开着这一个仓就从 300 行塌成 1 行。
                    最新 release 里没有 .js（比如发的是 zip）或这仓从没发过，仍会自动回落扫 tree。
                    代价：每个仓多一次 GitHub 接口调用。
                  </span>
                </span>
              </label>
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-3">
              <div className="text-xs uppercase text-muted-foreground">GitHub Token</div>
              <input
                type="password"
                value={tokenInput}
                onChange={e => setTokenInput(e.target.value)}
                placeholder={settings?.hasToken ? `已配置 ${settings.tokenTail}（留空则不改动）` : '只用于提升 API 限额，可不带任何 scope'}
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs"
              />
              <button
                onClick={() => { void handleTokenSave() }}
                disabled={saving}
                className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-medium hover:bg-accent/70 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                保存
              </button>
              {settings?.hasToken ? (
                <button
                  onClick={() => { void savePatch({ clearToken: true }) }}
                  disabled={saving}
                  className="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" /> 清除 token
                </button>
              ) : null}
            </div>

            <p className="text-xs text-muted-foreground">
              没 token 时 GitHub 匿名限额 60 次/小时，仓库数一多就会不够；接口会在起轮前直接告诉你差多少。
              token 只存本库、出网一律脱敏，任何接口都不会把它回给你。
            </p>
          </div>

          <div className="mb-6 rounded-lg border border-border p-4">
            <div className="mb-1 flex items-center gap-2 text-sm font-medium">
              <Search className="h-4 w-4 text-primary" />
              搜索 GitHub 仓库
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              这一步只搜、只给元数据：勾上再点「加进扫描清单」才会写进库，搜索本身不下载任何正文、不改配置。
              关键词按空格分；<code className="font-mono">in:name</code> 这类限定符可用，但中文词配
              <code className="font-mono"> in:name</code> 实测零命中（裸词能命中名字与描述）。
              搜索配额与爬仓库树的额度是两档（带 token 30 次/分，匿名 10 次/分）。
            </p>

            <div className="mb-3 flex flex-wrap items-center gap-2">
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { void handleSearch(1) } }}
                placeholder="关键词，例：lxmusic source"
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
              />
              <select
                value={searchSort}
                onChange={e => setSearchSort(e.target.value as 'best' | 'updated' | 'stars')}
                className="rounded border border-border bg-background px-2 py-1.5 text-xs"
              >
                <option value="updated">按最近更新</option>
                <option value="stars">按 star 数</option>
                <option value="best">按最佳匹配</option>
              </select>
              <button
                onClick={() => { void handleSearch(1) }}
                disabled={searching || saving}
                className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                搜索
              </button>
            </div>

            {searchResult ? (
              <>
                <div className="mb-2 text-xs text-muted-foreground">
                  命中 {searchResult.total} 个（第 {searchResult.page} 页 · 每页 {searchResult.pageSize}）
                  {searchResult.quota ? `｜搜索配额剩 ${searchResult.quota.remaining}/${searchResult.quota.limit}` : ''}
                  {searchResult.incomplete ? '｜GitHub 说这批没算完，翻不全就换个词' : ''}
                </div>
                {searchResult.items.length === 0 ? (
                  <div className="mb-2 text-xs text-muted-foreground">这一页没有可显示的仓库（私有的不会出现）。</div>
                ) : (
                  <div className="overflow-hidden rounded border border-border">
                    <table className="w-full text-xs">
                      <thead className="bg-accent/40 text-left uppercase text-muted-foreground">
                        <tr>
                          <th className="w-8 px-2 py-2"></th>
                          <th className="px-2 py-2 font-medium">仓库</th>
                          <th className="px-2 py-2 font-medium">描述</th>
                          <th className="px-2 py-2 font-medium">★</th>
                          <th className="px-2 py-2 font-medium">最近推送</th>
                          <th className="px-2 py-2 font-medium">标记</th>
                        </tr>
                      </thead>
                      <tbody>
                        {searchResult.items.map(item => {
                          const badge = item.ageBadge
                          const stale = badge.includes('停更')
                          return (
                            <tr key={item.repo} className="border-t border-border">
                              <td className="px-2 py-2">
                                <input
                                  type="checkbox"
                                  checked={searchPicked.includes(item.repo)}
                                  disabled={item.alreadyListed}
                                  onChange={() => togglePicked(item.repo)}
                                />
                              </td>
                              <td className="px-2 py-2 font-mono">
                                {item.repo}
                                {item.alreadyListed ? <span className="ml-1 text-muted-foreground">（已在清单）</span> : null}
                              </td>
                              <td className="max-w-[22rem] px-2 py-2 text-muted-foreground">{item.description || '—'}</td>
                              <td className="px-2 py-2">{item.stars}</td>
                              <td className={`px-2 py-2 ${stale ? 'text-amber-600' : 'text-muted-foreground'}`}>{badge || '—'}</td>
                              <td className="px-2 py-2 text-muted-foreground">
                                {[item.language, item.fork ? 'fork' : '', item.archived ? '已归档' : ''].filter(Boolean).join(' · ') || '—'}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <label
                    className="flex items-center gap-1"
                    title="勾上就只扫新加进来的这几个仓（清单外的仓这个参数带不进去）；不勾只是进清单，等下一次「开始发现」全量扫"
                  >
                    <input
                      type="checkbox"
                      checked={scanOnlyAdded}
                      onChange={e => setScanOnlyAdded(e.target.checked)}
                    />
                    加进清单后只扫这几个新仓
                  </label>
                  <button
                    onClick={() => { void handleAddPicked() }}
                    disabled={addingRepos || saving || pickedNew.length === 0}
                    className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 font-medium hover:bg-accent/70 disabled:opacity-50"
                  >
                    {addingRepos ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    把勾选的 {pickedNew.length} 个加进扫描清单
                  </button>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      onClick={() => { void handleSearch(searchResult.page - 1) }}
                      disabled={searching || searchResult.page <= 1}
                      className="rounded px-2 py-1 text-muted-foreground hover:bg-accent disabled:opacity-40"
                    >
                      上一页
                    </button>
                    <button
                      onClick={() => { void handleSearch(searchResult.page + 1) }}
                      disabled={searching || searchResult.page * searchResult.pageSize >= searchResult.total}
                      className="rounded px-2 py-1 text-muted-foreground hover:bg-accent disabled:opacity-40"
                    >
                      下一页
                    </button>
                  </div>
                </div>

                {searchNote ? (
                  <div className="mt-2 rounded border border-green-600/40 bg-green-600/10 px-3 py-1.5 text-xs text-green-800">
                    {searchNote}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="mb-6 rounded-lg border border-border p-4">
            <div className="mb-1 flex items-center gap-2 text-sm font-medium">
              <CalendarClock className="h-4 w-4 text-primary" />
              停更仓体检
            </div>
            <p className="mb-3 text-xs text-muted-foreground">
              逐个读清单里仓库的 <code className="font-mono">pushed_at</code>（GitHub 仓库接口，一次一个仓，
              吃的是爬树那档 core 额度，起手的配额预检不够会直接告诉你差多少）。
              这一步只读：勾完点「移出扫描清单」才会写进库。查不动的仓（超时/5xx）只列进「这次没查到」，
              不会被判成停更。
            </p>

            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <label className="uppercase text-muted-foreground" htmlFor="discovery-stale-days">停更阈值（天）</label>
              <input
                id="discovery-stale-days"
                type="number"
                min={30}
                max={3650}
                value={freshnessDays}
                onChange={e => setFreshnessDays(e.target.value)}
                disabled={checkingFresh || removingFresh}
                className="w-24 rounded border border-border bg-background px-2 py-1.5 font-mono"
              />
              <button
                onClick={() => { void handleFreshness() }}
                disabled={checkingFresh || removingFresh}
                className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {checkingFresh ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarClock className="h-3.5 w-3.5" />}
                体检停更仓
              </button>
              <span className="text-muted-foreground">365 天 = 上次手工剔 11 个仓用的那把尺子</span>
            </div>

            {freshnessReport ? (
              <>
                <div className="mb-2 text-xs text-muted-foreground">
                  体检 {freshnessReport.checked} 个仓｜阈值 {freshnessReport.maxAgeDays} 天｜
                  判停更/失效 {freshnessReport.items.filter(item => item.stale).length} 个
                  {freshnessReport.quota ? `｜GitHub 余量 ${freshnessReport.quota.remaining}/${freshnessReport.quota.limit}` : ''}
                  {freshnessReport.failed.length ? `｜没查到 ${freshnessReport.failed.length} 个` : ''}
                </div>
                {freshnessReport.failed.length ? (
                  <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700">
                    这些仓这次没查到，所以没被判成停更（等额度恢复或网络稳了再体检一次）：{freshnessReport.failed.join('；')}
                  </div>
                ) : null}
                <div className="overflow-hidden rounded border border-border">
                  <table className="w-full text-xs">
                    <thead className="bg-accent/40 text-left uppercase text-muted-foreground">
                      <tr>
                        <th className="w-8 px-2 py-2"></th>
                        <th className="px-2 py-2 font-medium">仓库</th>
                        <th className="px-2 py-2 font-medium">★</th>
                        <th className="px-2 py-2 font-medium">最近推送</th>
                        <th className="px-2 py-2 font-medium">候选行</th>
                        <th className="px-2 py-2 font-medium">结论</th>
                      </tr>
                    </thead>
                    <tbody>
                      {freshnessReport.items.map(item => (
                        <tr key={item.repo} className="border-t border-border">
                          <td className="px-2 py-2">
                            <input
                              type="checkbox"
                              checked={freshnessPicked.includes(item.repo)}
                              onChange={() => setFreshnessPicked(prev => prev.includes(item.repo)
                                ? prev.filter(repo => repo !== item.repo)
                                : [...prev, item.repo])}
                            />
                          </td>
                          <td className="px-2 py-2 font-mono">{item.repo}</td>
                          <td className="px-2 py-2">{item.stars}</td>
                          <td className="px-2 py-2 text-muted-foreground">
                            {item.daysSince == null ? '—' : `${item.daysSince} 天前`}
                          </td>
                          <td className="px-2 py-2 text-muted-foreground">{item.candidates}</td>
                          <td className={`px-2 py-2 ${item.stale ? 'text-amber-600' : 'text-muted-foreground'}`}>
                            {freshnessBadges(item, freshnessReport.maxAgeDays).join('｜') || '正常在更'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                  <label
                    className="flex items-center gap-1"
                    title="仓不扫了，留在候选表里的行就再也不会被刷新 —— 这两步本来就是同一件事"
                  >
                    <input
                      type="checkbox"
                      checked={pruneAfterRemove}
                      onChange={e => setPruneAfterRemove(e.target.checked)}
                    />
                    顺手清掉它们留下的候选（已导入成音源的保留）
                  </label>
                  <button
                    onClick={() => { void handleRemoveStale() }}
                    disabled={removingFresh || checkingFresh || freshnessPicked.length === 0}
                    className="flex items-center gap-1 rounded bg-destructive/15 px-3 py-1.5 font-medium text-destructive hover:bg-destructive/25 disabled:opacity-50"
                  >
                    {removingFresh ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eraser className="h-3.5 w-3.5" />}
                    把勾选的 {freshnessPicked.length} 个仓移出扫描清单
                  </button>
                </div>

                {freshNote ? (
                  <div className="mt-2 rounded border border-green-600/40 bg-green-600/10 px-3 py-1.5 text-xs text-green-800">
                    {freshNote}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          {status?.running ? (
            <div className="mb-4 rounded-lg border border-border bg-accent/20 px-4 py-3 text-sm">
              {status.draining ? `连轮第 ${status.round} 轮 · ` : ''}
              {status.phase}：{status.reposDone}/{status.reposTotal} 个仓库，已抓正文 {status.downloaded} 个
              {status.stopRequested ? ' · 已请求停止，抓完手头这条就收' : ''}
            </div>
          ) : null}
          {status?.drainLast && !status.running && !status.draining ? (
            <div className="mb-4 text-xs text-muted-foreground">
              上次连轮：跑了 {status.drainLast.rounds} 轮，抓正文 {status.drainLast.downloaded}，
              疑似 {status.drainLast.suspect}，剩余待判定 {status.drainLast.pendingLeft}
              {status.drainLast.note ? `｜${status.drainLast.note}` : ''}
            </div>
          ) : null}
          {status?.lastError ? (
            <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              上一轮失败：{status.lastError}
            </div>
          ) : null}
          {status?.probeBatch?.running ? (
            <div className="mb-4 rounded-lg border border-border bg-accent/20 px-4 py-3 text-sm">
              批量判级：{status.probeBatch.done}/{status.probeBatch.total} 条，
              {status.probeBatch.withAddress} 条真出货
              {status.probeBatch.failed ? `，${status.probeBatch.failed} 条没判成` : ''}
              {status.stopRequested ? ' · 已请求停止，判完手头这条就收' : ''}
            </div>
          ) : null}
          {status?.probeBatch && !status.probeBatch.running ? (
            <div className="mb-4 text-xs text-muted-foreground">
              上次批量判级：{status.probeBatch.done}/{status.probeBatch.total} 条，
              {status.probeBatch.withAddress} 条真出货
              {status.probeBatch.note ? `｜${status.probeBatch.note}` : ''}
            </div>
          ) : null}
          {status?.last && !status.running ? (
            <div className="mb-4 text-xs text-muted-foreground">
              上一轮：扫 {status.last.reposScanned} 仓，候选 {status.last.seen}（新采 {status.last.created}），
              抓正文 {status.last.downloaded}，疑似 {status.last.suspect}，不像音源 {status.last.notSource}，顶掉 {status.last.stale}
              {status.last.quota ? `｜GitHub 余量 ${status.last.quota.remaining}/${status.last.quota.limit}` : ''}
              {status.last.note ? `｜${status.last.note}` : ''}
              {status.last.truncatedRepos?.length ? (
                <div className="mt-1 text-amber-600">
                  树被 GitHub 截断（这仓结果不完整）：{status.last.truncatedRepos.join('、')}
                </div>
              ) : null}
              {status.last.releaseRepos?.length ? (
                <div className="mt-1 text-primary">
                  走最新 release 采集：{status.last.releaseRepos.join('、')}
                  {status.last.releaseSuperseded ? `；tree 里的 ${status.last.releaseSuperseded} 行历史文件已标成"已被顶掉"` : ''}
                </div>
              ) : null}
              {status.last.releaseFallbacks?.length ? (
                <div className="mt-1 text-muted-foreground">回落扫 tree：{status.last.releaseFallbacks.join('；')}</div>
              ) : null}
              {status.last.zipNotes?.length ? (
                <div className="mt-1 text-muted-foreground">压缩包：{status.last.zipNotes.join('；')}</div>
              ) : null}
              {status.last.reposSkipped?.length ? (
                <div className="mt-1">跳过：{status.last.reposSkipped.join('；')}</div>
              ) : null}
            </div>
          ) : null}

          <div className="mb-3 flex flex-wrap gap-1">
            {FILTERS.map(item => (
              <button
                key={item.key}
                onClick={() => { setFilter(item); setForceConfirmId(null) }}
                className={`rounded-full px-3 py-1.5 text-xs font-medium ${filter.key === item.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}
              >
                {item.label}
                <span className="ml-1 opacity-70">{countOf(item.verdict, item.state)}</span>
              </button>
            ))}
          </div>

          {importNote ? (
            <div className="mb-3 rounded-lg border border-green-600/40 bg-green-600/10 px-4 py-2 text-xs text-green-800">
              {importNote}
            </div>
          ) : null}

          {candidates.length === 0 ? (
            <EmptyState icon={Radar} title="这一类没有候选" description="开一轮发现后再看，或换个分类" />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-accent/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">来源与地址</th>
                    <th className="px-4 py-3 font-medium">@name</th>
                    <th className="px-4 py-3 font-medium">分</th>
                    <th className="px-4 py-3 font-medium">大小</th>
                    <th className="px-4 py-3 font-medium">判定依据</th>
                    <th className="px-4 py-3 font-medium">判级（真跑一次取址）</th>
                    <th className="px-4 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map(row => (
                    <tr key={row.id} className="border-t border-border hover:bg-accent/20">
                      <td className="px-4 py-3 font-mono text-xs">
                        <div>{row.repo}</div>
                        {row.releaseTag ? (
                          <div
                            className="text-primary"
                            title={row.assetDigest
                              ? (row.zipMember
                                ? `整包的 sha256：${row.assetDigest}（取条目之前先复验整包）`
                                : `发布资产的 sha256：${row.assetDigest}（导入前会按它复验）`)
                              : '这个发布资产 GitHub 没给 digest，导入时无从复验'}
                          >
                            来自发布 {row.releaseTag}{row.upstreamAt ? `（${row.upstreamAt.slice(0, 10)}）` : ''}
                          </div>
                        ) : null}
                        <div className="text-muted-foreground">
                          {row.zipMember ? '包内条目：' : row.releaseTag ? '资产文件：' : ''}{row.zipMember || row.path}
                        </div>
                        {row.importedPath ? (
                          <div className="text-green-700">已导入 → {row.importedPath}</div>
                        ) : null}
                        <AddressCell
                          rawUrl={row.rawUrl}
                          copied={copiedId === row.id}
                          onCopy={() => { void handleCopy(row.rawUrl, row.id) }}
                        />
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div>{row.scriptName || '—'}</div>
                        {row.duplicateOf ? (
                          <div className={row.duplicateOf.kind === 'content' ? 'text-destructive' : 'text-amber-600'}>
                            {row.duplicateOf.kind === 'content'
                              ? `库里已装着同一份 → ${row.duplicateOf.name || row.duplicateOf.path}`
                              : `库里已有同名源 → ${row.duplicateOf.name}`}
                          </div>
                        ) : null}
                        {similarNameBadge(row) ? (
                          <div
                            className="text-muted-foreground/80 italic"
                            title="只是提示，不影响你装：内容不同、名字归一后也不同，所以两档撞车都没命中。要不要并排装、要不要换掉库里那条，看判级那盏灯自己定"
                          >
                            {similarNameBadge(row)}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs font-medium">{row.score}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {row.sizeBytes ? `${Math.round(row.sizeBytes / 1024)}KB` : '—'}
                      </td>
                      <td className="max-w-[22rem] px-4 py-3 text-xs text-muted-foreground">
                        {row.reason || '还没抓正文'}
                        {canForceProbe(row) ? (
                          <div className="text-amber-600" title="静态特征读不懂（多半是混淆过的），但它带 @name 且正文体积像一份真载荷 —— 可以点「仍然判级」真跑一次；跑出平台出货会自动提升为疑似可用">
                            静态特征读不懂（疑似混淆载荷，可「仍然判级」）
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {row.probe
                          ? <ProbeLights cells={row.probe.cells} />
                          : <span className="text-muted-foreground">{status?.probingId === row.id ? '判级中…' : '未判'}</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => { void handleProbe(row.id, row.verdict !== 'suspect') }}
                            disabled={status?.probingId !== null || Boolean(status?.probeBatch?.running) || (row.verdict !== 'suspect' && !canForceProbe(row))}
                            title={row.verdict === 'suspect'
                              ? '下载它、复验 blob sha、在一次性沙箱里真取一次址'
                              : canForceProbe(row)
                                ? '仍然判级：静态分不够但像载荷，真跑一次试试；跑出平台出货会把它提升为疑似可用'
                                : '不像音源（没有 @name 或体积不在 20KB~1MB），不给判级'}
                            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {status?.probingId === row.id
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Radar className="h-3.5 w-3.5" />}
                            {row.verdict === 'suspect' ? '判级' : '仍然判级'}
                          </button>
                          {row.state === 'imported' || row.duplicateOf?.kind === 'content' ? null : (
                            <button
                              onClick={() => { void handleImport(row) }}
                              disabled={row.verdict !== 'suspect' || importingId !== null}
                              title={!needsForceConfirm(row)
                                ? '按记录里的地址重新下载、复验 blob sha，通过后才装入音源列表'
                                : row.duplicateOf?.kind === 'name'
                                  ? '库里已经有同名源 —— 两条同名会共用健康账本那一格，再点一次表示坚持并排装'
                                  : '判级里没有平台真出货 —— 再点一次表示坚持导入'}
                              className={`flex items-center gap-1 rounded px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${
                                forceConfirmId === row.id
                                  ? 'bg-destructive/15 text-destructive hover:bg-destructive/25'
                                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                              }`}
                            >
                              {importingId === row.id
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <Download className="h-3.5 w-3.5" />}
                              {forceConfirmId === row.id ? '确认强制导入' : '导入'}
                            </button>
                          )}
                          <button
                            onClick={() => handleDismiss(row.id)}
                            disabled={row.state === 'stale' || row.state === 'imported'}
                            title={row.state === 'imported' ? '它已经是音源了，请到「音源管理」里删除' : '从候选里剔除'}
                            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <Ban className="h-3.5 w-3.5" /> 剔除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {clipboardBlocked ? (
            <p className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
              浏览器在非 HTTPS 环境下不允许脚本写剪贴板 —— 直接选中地址复制即可，功能本身不受影响。
            </p>
          ) : null}

          <p className="mt-4 text-xs text-muted-foreground">
            候选表里只有元数据（地址、内容哈希、打分、判定），脚本正文既不落库也不留在服务器上。
            点「导入」时服务端按记录里的地址重新下载，先复验仓库 tree 的 blob sha 再进一次性沙箱校验，
            对不上就直接拒绝 —— 装进列表的一定是判级时看过的那一份。导入后的源会登记成订阅，
            上游更新可在「音源管理」里手动拉取。
          </p>
        </>
      )}
    </div>
  )
}
