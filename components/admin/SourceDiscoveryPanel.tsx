/**
 * 音源发现面板（admin Tab 子组件，P0-a：只发现、不导入）。
 *
 * 配置全部在这里改（含 GitHub token）——改配置文件要登 NAS，管理员做不到也不该要求。
 * token 是**写入不回显**的：接口只返回脱敏尾巴，输入框留空表示不改动。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  dismissDiscoveryCandidate,
  getDiscovery,
  saveDiscoverySettings,
  startDiscoveryCrawl,
  type DiscoveryCandidate,
  type DiscoverySettingsView,
  type DiscoveryStatus,
} from '@/lib/api/admin-source-discovery'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { Radar, RefreshCw, Loader2, Ban, KeyRound, Trash2 } from 'lucide-react'

const FILTERS = [
  { key: 'suspect', label: '疑似可用', verdict: 'suspect', state: 'new' },
  { key: 'pending', label: '待判定', verdict: 'pending', state: 'new' },
  { key: 'not-source', label: '不像音源', verdict: 'not-source', state: 'new' },
  { key: 'stale', label: '已被顶掉', verdict: '', state: 'stale' },
] as const

export function SourceDiscoveryPanel() {
  const [settings, setSettings] = useState<DiscoverySettingsView | null>(null)
  const [status, setStatus] = useState<DiscoveryStatus | null>(null)
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>(FILTERS[0])
  const [reposText, setReposText] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const reload = useCallback(async () => {
    try {
      const view = await getDiscovery({ verdict: filter.verdict || undefined, state: filter.state || undefined })
      setSettings(view.settings)
      setStatus(view.status)
      setCandidates(view.candidates)
      setCounts(view.counts)
      setReposText(prev => (prev === '' && !view.status.running ? view.settings.repos.join('\n') : prev))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    setLoading(true)
    reload()
  }, [reload])

  // 有一轮在跑就轮进度，跑完自动停（不留着空转）
  useEffect(() => {
    if (!status?.running) {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
      return
    }
    pollRef.current = setInterval(() => { void reload() }, 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [status?.running, reload])

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

  const handleDismiss = async (id: number) => {
    try {
      await dismissDiscoveryCandidate(id)
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : '操作失败')
    }
  }

  const countOf = (key: string) => Object.entries(counts)
    .filter(([compound]) => compound.startsWith(`${key}/`))
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
            从 GitHub 仓库树里挑出疑似洛雪音源脚本，静态打分去重后进候选表。<b>本期只做发现，导入下一期再开</b>。
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
              {status.phase}：{status.reposDone}/{status.reposTotal} 个仓库，已抓正文 {status.downloaded} 个
            </div>
          ) : null}
          {status?.lastError ? (
            <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              上一轮失败：{status.lastError}
            </div>
          ) : null}
          {status?.last && !status.running ? (
            <div className="mb-4 text-xs text-muted-foreground">
              上一轮：扫 {status.last.reposScanned} 仓，候选 {status.last.seen}（新采 {status.last.created}），
              抓正文 {status.last.downloaded}，疑似 {status.last.suspect}，不像音源 {status.last.notSource}，顶掉 {status.last.stale}
              {status.last.quota ? `｜GitHub 余量 ${status.last.quota.remaining}/${status.last.quota.limit}` : ''}
              {status.last.note ? `｜${status.last.note}` : ''}
            </div>
          ) : null}

          <div className="mb-3 flex flex-wrap gap-1">
            {FILTERS.map(item => (
              <button
                key={item.key}
                onClick={() => setFilter(item)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium ${filter.key === item.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}
              >
                {item.label}
                <span className="ml-1 opacity-70">{countOf(item.verdict || item.state)}</span>
              </button>
            ))}
          </div>

          {candidates.length === 0 ? (
            <EmptyState icon={Radar} title="这一类没有候选" description="开一轮发现后再看，或换个分类" />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-accent/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">来源</th>
                    <th className="px-4 py-3 font-medium">@name</th>
                    <th className="px-4 py-3 font-medium">分</th>
                    <th className="px-4 py-3 font-medium">大小</th>
                    <th className="px-4 py-3 font-medium">判定依据</th>
                    <th className="px-4 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map(row => (
                    <tr key={row.id} className="border-t border-border hover:bg-accent/20">
                      <td className="px-4 py-3 font-mono text-xs">
                        <div>{row.repo}</div>
                        <div className="text-muted-foreground">{row.path}</div>
                      </td>
                      <td className="px-4 py-3 text-xs">{row.scriptName || '—'}</td>
                      <td className="px-4 py-3 text-xs font-medium">{row.score}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {row.sizeBytes ? `${Math.round(row.sizeBytes / 1024)}KB` : '—'}
                      </td>
                      <td className="max-w-[22rem] px-4 py-3 text-xs text-muted-foreground">{row.reason || '还没抓正文'}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end">
                          <button
                            onClick={() => handleDismiss(row.id)}
                            disabled={row.state === 'stale'}
                            title="从候选里剔除"
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

          <p className="mt-4 text-xs text-muted-foreground">
            候选表里只有元数据（地址、内容哈希、打分、判定），脚本正文既不落库也不留在服务器上；
            真要导入时会按地址重新下载并复验，那是下一期的事。
          </p>
        </>
      )}
    </div>
  )
}
