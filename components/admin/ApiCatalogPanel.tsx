import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, FlaskConical, Loader2, Network, RefreshCw, Save } from 'lucide-react'
import {
  getApiCatalog,
  getApiProbeSamples,
  probeApiInterface,
  saveApiCatalog,
  type ApiCatalogInterface,
  type ApiCatalogView,
  type ApiInterfaceProbeResult,
} from '@/lib/api/admin-api-catalog'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import type { MusicInfo } from '@/lib/types/music'

const PLATFORM_LABELS: Record<string, string> = {
  tx: '腾讯', wy: '网易', kw: '酷我', kg: '酷狗', mg: '咪咕', unknown: '未知平台',
}

export function filterApiInterfaces(
  items: ApiCatalogInterface[],
  filters: { platform: string; source: string; query: string },
): ApiCatalogInterface[] {
  const query = filters.query.trim().toLowerCase()
  return items.filter(item => {
    if (filters.platform !== 'all' && item.platform !== filters.platform) return false
    if (filters.source !== 'all' && !item.sources.includes(filters.source)) return false
    if (!query) return true
    return [item.endpoint, item.id, item.method, item.lastCode, item.lastMsg, ...item.sources]
      .some(value => String(value || '').toLowerCase().includes(query))
  })
}

export function apiCatalogUpdates(items: ApiCatalogInterface[], draft: Record<string, boolean>) {
  return items
    .filter(item => draft[item.id] !== undefined && draft[item.id] !== item.enabled)
    .map(item => ({ id: item.id, enabled: draft[item.id] }))
}

export function disableDuplicateExtras(view: Pick<ApiCatalogView, 'duplicateGroups'>, draft: Record<string, boolean>) {
  const next = { ...draft }
  for (const group of view.duplicateGroups) {
    if (group.interfaceIds[0]) next[group.interfaceIds[0]] = true
    for (const id of group.interfaceIds.slice(1)) next[id] = false
  }
  return next
}

function draftFrom(view: ApiCatalogView): Record<string, boolean> {
  return Object.fromEntries(view.interfaces.map(item => [item.id, item.enabled]))
}

function percent(ok: number, total: number): string {
  return total > 0 ? `${Math.round(ok / total * 100)}%` : '—'
}

export function ApiCatalogPanel() {
  const [catalog, setCatalog] = useState<ApiCatalogView | null>(null)
  const [draft, setDraft] = useState<Record<string, boolean>>({})
  const [platform, setPlatform] = useState('all')
  const [source, setSource] = useState('all')
  const [query, setQuery] = useState('')
  const [quality, setQuality] = useState('320k')
  const [samples, setSamples] = useState<Record<string, MusicInfo[]>>({})
  const [sampleKey, setSampleKey] = useState('')
  const [probingKey, setProbingKey] = useState<string | null>(null)
  const [probeResults, setProbeResults] = useState<Record<string, ApiInterfaceProbeResult>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const fetchData = useCallback(async () => {
    const [view, sampleView] = await Promise.all([getApiCatalog(), getApiProbeSamples()])
    return { view, samples: sampleView.samples || {} }
  }, [])

  const load = useCallback(async () => {
    try {
      const { view, samples: nextSamples } = await fetchData()
      setCatalog(view)
      setDraft(draftFrom(view))
      setProbeResults(view.latestProbes || {})
      setSamples(nextSamples)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载接口目录失败')
    } finally {
      setLoading(false)
    }
  }, [fetchData])

  const refresh = () => {
    setLoading(true)
    setError(null)
    void load()
  }

  useEffect(() => {
    let active = true
    void fetchData().then(({ view, samples: nextSamples }) => {
      if (!active) return
      setCatalog(view)
      setDraft(draftFrom(view))
      setProbeResults(view.latestProbes || {})
      setSamples(nextSamples)
    }).catch(e => {
      if (active) setError(e instanceof Error ? e.message : '加载接口目录失败')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [fetchData])

  const items = useMemo(() => catalog?.interfaces || [], [catalog])
  const platforms = [...new Set(items.map(item => item.platform))].sort()
  const sources = [...new Set(items.flatMap(item => item.sources))].sort((a, b) => a.localeCompare(b))
  const sampleOptions = Object.entries(samples).flatMap(([platform, list]) => list.map(musicInfo => ({
    key: `${platform}\u0000${musicInfo.songmid}`,
    platform,
    musicInfo,
  })))
  const filtered = useMemo(
    () => filterApiInterfaces(items, { platform, source, query }),
    [items, platform, source, query],
  )
  const updates = apiCatalogUpdates(items, draft)

  const setVisible = (enabled: boolean) => {
    setDraft(previous => {
      const next = { ...previous }
      for (const item of filtered) next[item.id] = enabled
      return next
    })
    setSaved(false)
  }

  const persist = async () => {
    if (updates.length === 0) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const view = await saveApiCatalog(updates)
      setCatalog(view)
      setDraft(draftFrom(view))
      setProbeResults(view.latestProbes || {})
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存接口选择失败')
    } finally {
      setSaving(false)
    }
  }

  const runProbe = async (item: ApiCatalogInterface, sourceName: string) => {
    const key = `${item.id}\u0000${sourceName}`
    setProbingKey(key)
    setError(null)
    setSaved(false)
    try {
      const selected = sampleOptions.find(option => option.key === sampleKey && option.platform === item.platform)
      const musicInfo = selected?.musicInfo || samples[item.platform]?.[0]
      const result = await probeApiInterface(item.id, sourceName, quality, musicInfo)
      setProbeResults(previous => ({ ...previous, [item.id]: result }))
      setCatalog(previous => previous ? { ...previous, latestProbes: { ...previous.latestProbes, [item.id]: result } } : previous)
    } catch (e) {
      setError(e instanceof Error ? e.message : '单接口测试失败')
    } finally {
      setProbingKey(null)
    }
  }

  if (loading && !catalog) return <LoadingSkeleton count={4} />

  return (
    <section className="mb-6 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Network className="h-4 w-4 text-primary" />运行时接口目录
          </h3>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            一行是一个实际接口身份，不是整个音源。地址已去掉查询参数，key 只保存哈希；HTTP 200 仍可能业务失败，
            “给出地址”只统计 2xx 且回包带播放地址的响应。停用会在出网前阻断，未观察到的接口默认放行。
            单测只放行目标身份；依赖前置登录/取 token 的接口会被阻断并如实记为 blocked，不代表接口本身失效。
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading || saving}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />刷新
        </button>
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />{error}
        </div>
      )}
      {saved && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-green-500/10 px-3 py-2 text-xs text-green-600">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />接口选择已保存
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted-foreground">
          平台
          <select value={platform} onChange={event => setPlatform(event.target.value)} className="mt-1 block rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground">
            <option value="all">全部平台</option>
            {platforms.map(value => <option key={value} value={value}>{PLATFORM_LABELS[value] || value}（{value}）</option>)}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          来源音源
          <select value={source} onChange={event => setSource(event.target.value)} className="mt-1 block max-w-56 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground">
            <option value="all">全部音源</option>
            {sources.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="min-w-48 flex-1 text-xs text-muted-foreground">
          搜索地址、来源或业务消息
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="例如 vkeys、503、杰翔" className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground" />
        </label>
        <label className="text-xs text-muted-foreground">
          单测音质
          <select value={quality} onChange={event => setQuality(event.target.value)} disabled={probingKey !== null} className="mt-1 block rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground">
            {['128k', '320k', 'flac', 'flac24bit'].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          单测样本
          <select value={sampleKey} onChange={event => setSampleKey(event.target.value)} disabled={probingKey !== null} className="mt-1 block max-w-64 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground">
            <option value="">按平台首选基准曲</option>
            {sampleOptions.map(option => (
              <option key={option.key} value={option.key}>{PLATFORM_LABELS[option.platform] || option.platform} · {option.musicInfo.name || option.musicInfo.songmid} · {option.musicInfo.singer || '未知歌手'}</option>
            ))}
          </select>
        </label>
        <div className="flex gap-1.5">
          <button type="button" onClick={() => setVisible(true)} disabled={filtered.length === 0 || saving} className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50">筛选全启用</button>
          <button type="button" onClick={() => setVisible(false)} disabled={filtered.length === 0 || saving} className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50">筛选全停用</button>
        </div>
        <button
          type="button"
          onClick={() => void persist()}
          disabled={saving || updates.length === 0}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存选择{updates.length > 0 ? `（${updates.length}）` : ''}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>接口身份 <strong className="text-foreground">{items.length}</strong></span>
        <span>重复组 <strong className="text-foreground">{catalog?.duplicateGroups.length || 0}</strong></span>
        <span>当前筛选 <strong className="text-foreground">{filtered.length}</strong></span>
        <span>待保存 <strong className="text-foreground">{updates.length}</strong></span>
      </div>

      {catalog && catalog.duplicateGroups.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <span>
            检测到 {catalog.duplicateGroups.length} 组同平台、同地址、同方法、同请求结构、同 keyHash 的接口。
            这是去重候选，不等于已经证明多个音源使用同一枚凭据。
          </span>
          <button
            type="button"
            disabled={saving}
            onClick={() => { setDraft(previous => disableDuplicateExtras(catalog, previous)); setSaved(false) }}
            className="shrink-0 rounded border border-amber-500/40 px-2 py-1 hover:bg-amber-500/10 disabled:opacity-50"
          >
            每组保留首条
          </button>
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="mt-4 rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          还没有符合条件的接口。播放一次后，真实调用链会把接口身份写入这里。
        </p>
      ) : (
        <div className="mt-3 max-h-[32rem] overflow-auto rounded-md border border-border">
          <table className="w-full min-w-[62rem] text-left text-[11px]">
            <thead className="sticky top-0 z-10 bg-accent/80 text-muted-foreground backdrop-blur">
              <tr>
                <th className="px-2 py-2 font-medium">启用</th>
                <th className="px-2 py-2 font-medium">平台 / 接口</th>
                <th className="px-2 py-2 font-medium">来源</th>
                <th className="px-2 py-2 font-medium">调用 / 网络</th>
                <th className="px-2 py-2 font-medium">HTTP / 地址</th>
                <th className="px-2 py-2 font-medium">最近业务回包</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(item => {
                const checked = draft[item.id] ?? item.enabled
                const probe = probeResults[item.id]
                return (
                  <tr key={item.id} className="border-t border-border align-top">
                    <td className="px-2 py-2">
                      <input type="checkbox" checked={checked} disabled={saving} onChange={event => {
                        setDraft(previous => ({ ...previous, [item.id]: event.target.checked }))
                        setSaved(false)
                      }} aria-label={`${checked ? '停用' : '启用'} ${item.endpoint}`} />
                    </td>
                    <td className="max-w-80 px-2 py-2">
                      <span className="mr-1.5 rounded bg-accent px-1.5 py-0.5 font-medium">{PLATFORM_LABELS[item.platform] || item.platform}</span>
                      <span className="text-muted-foreground">{item.method}</span>
                      <code className="mt-1 block break-all">{item.endpoint}</code>
                      <span className="mt-1 block break-all text-muted-foreground">id {item.id} · shape {item.requestShapeHash}</span>
                      {item.keyHash && <span className="block break-all text-muted-foreground">keyHash {item.keyHash}</span>}
                    </td>
                    <td className="max-w-48 px-2 py-2">
                      {item.sources.length > 0 ? item.sources.map(value => (
                        <div key={value} className="flex items-start justify-between gap-2">
                          <span className="break-all">{value}</span>
                          <button
                            type="button"
                            onClick={() => void runProbe(item, value)}
                            disabled={probingKey !== null || saving}
                            title="使用此平台基准样本，只放行当前接口身份"
                            className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent disabled:opacity-50"
                          >
                            {probingKey === `${item.id}\u0000${value}`
                              ? <Loader2 className="h-3 w-3 animate-spin" />
                              : <FlaskConical className="h-3 w-3" />}单测
                          </button>
                        </div>
                      )) : '未知'}
                    </td>
                    <td className="px-2 py-2">
                      {item.callCount} / {item.networkCount}
                      <span className="block text-muted-foreground">最近 {new Date(item.lastSeenAt).toLocaleString('zh-CN')}</span>
                    </td>
                    <td className="px-2 py-2">
                      {percent(item.httpOkCount, item.responseCount)}
                      <span className="block text-muted-foreground">{item.httpOkCount}/{item.responseCount} · 地址 {item.addressCount}</span>
                    </td>
                    <td className="max-w-64 px-2 py-2">
                      <span>HTTP {item.lastStatusCode ?? '—'} · code {item.lastCode ?? '—'}</span>
                      <span className="block break-all text-muted-foreground">{item.lastMsg || '无业务消息'}</span>
                      <span className="block text-muted-foreground">带地址：{item.lastUrlExists === true ? '是' : item.lastUrlExists === false ? '否' : '未知'}</span>
                      {probe && (
                        <span className="mt-1 block border-t border-border pt-1">
                          <strong>单测 {probe.outcome}</strong> · {probe.latencyMs ?? '—'}ms{probe.container ? ` · ${probe.container}` : ''}
                          <span className="block break-all text-muted-foreground">{probe.detail || probe.msg || '无补充说明'}</span>
                          <span className="block text-muted-foreground">{probe.source} · {probe.quality} · {probe.songmid}</span>
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
