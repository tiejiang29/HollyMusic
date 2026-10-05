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
  saveDiscoverySettings,
  startCandidateProbe,
  startCandidateProbeBatch,
  startDiscoveryCrawl,
  startDiscoveryDrain,
  stopDiscovery,
  type DiscoveryCandidate,
  type DiscoverySettingsView,
  type DiscoveryStatus,
  type ProbeCellView,
} from '@/lib/api/admin-source-discovery'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { Radar, RefreshCw, Loader2, Ban, KeyRound, Trash2, Link2, CheckCircle2, Download, Layers, Square, ListChecks } from 'lucide-react'
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
        const label = OUTCOME_LABEL[cell.outcome] ?? cell.outcome
        return (
          <span
            key={platform}
            title={`${PLATFORM_LABELS[platform] ?? platform}：${label}${cell.latencyMs != null ? ` ${cell.latencyMs}ms` : ''}${cell.container ? `｜${cell.container}` : ''}${cell.reason ? `｜${cell.reason}` : ''}`}
            className={`rounded px-1.5 py-0.5 text-[11px] ${ok ? 'bg-green-600/15 text-green-700' : 'bg-destructive/15 text-destructive'}`}
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
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const [importingId, setImportingId] = useState<number | null>(null)
  // 判级没出货的候选要点两下：第一下只把按钮变成「确认强制导入」。
  // force 是"管理员对着红灯坚持要装"那一档，不该一次点击就能触发。
  const [forceConfirmId, setForceConfirmId] = useState<number | null>(null)
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
      setReposText(prev => (prev === '' && !view.status.running ? view.settings.repos.join('\n') : prev))
      setBudgetText(prev => (prev === '' && !view.status.running ? String(view.settings.maxDownloadsPerRound) : prev))
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

  const handleSave = async (extra: Record<string, unknown> = {}) => {
    setSaving(true)
    try {
      const repos = reposText.split(/[\n,，]/).map(line => line.trim()).filter(Boolean)
      const result = await saveDiscoverySettings({ repos, ...extra })
      setSettings(result.settings)
      if (result.rejected.length) {
        alert(`这些写法没被接受（要 owner/repo）：\n${result.rejected.join('\n')}`)
      }
      setTokenInput('')
    } catch (e) {
      alert(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
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
    await handleSave({ maxDownloadsPerRound: parsed })
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

  const handleProbe = async (id: number) => {
    try {
      const result = await startCandidateProbe(id)
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
            点过「导入」才会把它装进音源列表。
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
                  void handleSave({ enabled })
                }}
              />
              启用音源发现（默认关，因为它会向 GitHub 发起请求）
            </label>

            <div className="mb-3">
              <div className="mb-1 text-xs uppercase text-muted-foreground">扫描的仓库（一行一个 owner/repo）</div>
              <textarea
                value={reposText}
                onChange={e => setReposText(e.target.value)}
                rows={6}
                spellCheck={false}
                className="w-full rounded border border-border bg-background p-2 font-mono text-xs"
              />
            </div>

            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <label className="uppercase text-muted-foreground" htmlFor="discovery-budget">每轮抓正文上限</label>
              <input
                id="discovery-budget"
                type="number"
                min={0}
                max={2000}
                value={budgetText}
                onChange={e => setBudgetText(e.target.value)}
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
                onClick={() => handleSave(tokenInput.trim() ? { githubToken: tokenInput.trim() } : {})}
                disabled={saving}
                className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-medium hover:bg-accent/70 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                保存
              </button>
              {settings?.hasToken ? (
                <button
                  onClick={() => handleSave({ clearToken: true })}
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
                        <div className="text-muted-foreground">{row.path}</div>
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
                      </td>
                      <td className="px-4 py-3 text-xs font-medium">{row.score}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {row.sizeBytes ? `${Math.round(row.sizeBytes / 1024)}KB` : '—'}
                      </td>
                      <td className="max-w-[22rem] px-4 py-3 text-xs text-muted-foreground">{row.reason || '还没抓正文'}</td>
                      <td className="px-4 py-3 text-xs">
                        {row.probe
                          ? <ProbeLights cells={row.probe.cells} />
                          : <span className="text-muted-foreground">{status?.probingId === row.id ? '判级中…' : '未判'}</span>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => { void handleProbe(row.id) }}
                            disabled={status?.probingId !== null || Boolean(status?.probeBatch?.running) || row.verdict !== 'suspect'}
                            title="下载它、复验 blob sha、在一次性沙箱里真取一次址"
                            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {status?.probingId === row.id
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Radar className="h-3.5 w-3.5" />}
                            判级
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
