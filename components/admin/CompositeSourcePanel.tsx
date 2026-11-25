import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Layers, Loader2, Save, Square } from 'lucide-react'
import {
  getCompositeSource,
  saveCompositeSource,
  type CompositeMember,
  type CompositeSettings,
  type CompositeLaneStat,
} from '@/lib/api/admin-composite-source'
import type { AdminSource } from '@/lib/api/admin-sources'
import type { SourceType } from '@/lib/types/music'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'

const PLATFORMS: SourceType[] = ['tx', 'wy', 'kw', 'kg', 'mg']
const PLATFORM_LABELS: Record<SourceType, string> = {
  tx: '腾讯',
  wy: '网易',
  kw: '酷我',
  kg: '酷狗',
  mg: '咪咕',
}

export function compositeMemberKey(member: Pick<CompositeMember, 'sourceName' | 'platform'>): string {
  return `${member.sourceName}\u0000${member.platform}`
}

export function toggleCompositeMember(
  members: CompositeMember[],
  sourceName: string,
  platform: SourceType,
): CompositeMember[] {
  const key = compositeMemberKey({ sourceName, platform })
  return members.some(member => compositeMemberKey(member) === key)
    ? members.filter(member => compositeMemberKey(member) !== key)
    : [...members, { sourceName, platform }]
}

export function compositeSourcePlatforms(source: AdminSource): SourceType[] {
  const declared = source.supportedPlatforms?.length ? source.supportedPlatforms : PLATFORMS
  const allowed = source.pt?.length ? source.pt : declared
  return PLATFORMS.filter(platform => declared.includes(platform) && allowed.includes(platform))
}

function rateText(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}

function LaneTable({ lanes }: { lanes: CompositeLaneStat[] }) {
  if (lanes.length === 0) {
    return <p className="text-xs text-muted-foreground">还没有 lane 实测；播放一次后这里会出现哈希与 HTTP 统计。</p>
  }
  return (
    <div className="max-h-64 overflow-auto rounded-md border border-border">
      <table className="w-full text-left text-[11px]">
        <thead className="sticky top-0 bg-accent/60 text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium">lane / 端点</th>
            <th className="px-2 py-1.5 font-medium">来源</th>
            <th className="px-2 py-1.5 font-medium">HTTP</th>
            <th className="px-2 py-1.5 font-medium">判坏</th>
            <th className="px-2 py-1.5 font-medium">状态</th>
          </tr>
        </thead>
        <tbody>
          {lanes.map(lane => (
            <tr key={lane.laneId} className="border-t border-border align-top">
              <td className="px-2 py-1.5">
                <code className="block break-all">{lane.laneId}</code>
                <span className="block break-all text-muted-foreground">{lane.endpoint}</span>
                {lane.keyHash && <span className="block text-muted-foreground">keyHash {lane.keyHash}</span>}
              </td>
              <td className="px-2 py-1.5">
                {lane.sourceName || '未知'}<br />
                <span className="text-muted-foreground">{lane.platform || '—'} / {lane.quality || '—'}</span>
              </td>
              <td className="px-2 py-1.5">{rateText(lane.successRate)}<br /><span className="text-muted-foreground">{lane.httpOk}/{lane.attempts}</span></td>
              <td className="px-2 py-1.5">{lane.payloadBad}</td>
              <td className="px-2 py-1.5">
                {lane.cooling
                  ? <span className="text-red-600">冷却 {Math.ceil(lane.retryAfterMs / 1000)}s</span>
                  : <span className="text-muted-foreground">可用</span>}
                {lane.lastError && <span className="block max-w-52 break-all text-muted-foreground">{lane.lastError}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function CompositeSourcePanel({ sources }: { sources: AdminSource[] }) {
  const [settings, setSettings] = useState<CompositeSettings | null>(null)
  const [lanes, setLanes] = useState<CompositeLaneStat[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const view = await getCompositeSource()
        if (!active) return
        setSettings(view.settings)
        setLanes(view.lanes)
      } catch (e) {
        if (!active) return
        setError(e instanceof Error ? e.message : '加载复合源配置失败')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [])

  const persist = async (next: CompositeSettings) => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const view = await saveCompositeSource(next)
      setSettings(view.settings)
      setLanes(view.lanes)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存复合源配置失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading && !settings) return <LoadingSkeleton count={3} />

  return (
    <section className="mb-6 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Layers className="h-4 w-4 text-primary" />
            复合音源（灰度）
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            同一首歌按音质并发竞选；波宽 1 用于串行对照，6 用于完整并发。关闭后立即回到旧瀑布。
          </p>
        </div>
        {settings && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.enabled}
              disabled={saving}
              onChange={event => setSettings({ ...settings, enabled: event.target.checked })}
            />
            {settings.enabled ? '已启用' : '未启用'}
          </label>
        )}
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />{error}
        </div>
      )}
      {saved && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-green-500/10 px-3 py-2 text-xs text-green-600">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />已保存并生效
        </div>
      )}

      {settings && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <label className="text-xs text-muted-foreground">
              波宽
              <select
                value={settings.width}
                disabled={saving}
                onChange={event => setSettings({ ...settings, width: Number(event.target.value) })}
                className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
              >
                {[1, 2, 3, 4, 5, 6].map(width => <option key={width} value={width}>{width}{width === 1 ? '（串行对照）' : width === 6 ? '（完整并发）' : ''}</option>)}
              </select>
            </label>
            {([
              ['holdMs', '低档兜底保留 (ms)'],
              ['resolveMs', '单源取址 (ms)'],
              ['headerMs', '首字节 (ms)'],
              ['chainMs', '整链 (ms)'],
            ] as const).map(([key, label]) => (
              <label key={key} className="text-xs text-muted-foreground">
                {label}
                <input
                  type="number"
                  min={key === 'holdMs' ? 0 : 500}
                  max={key === 'chainMs' ? 19_000 : key === 'holdMs' ? 5_000 : 15_000}
                  value={settings[key]}
                  disabled={saving}
                  onChange={event => setSettings({ ...settings, [key]: Number(event.target.value) })}
                  className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
                />
              </label>
            ))}
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">成员（音源 × 平台）</span>
              <span className="text-xs text-muted-foreground">已选 {settings.members.length}</span>
            </div>
            <div className="max-h-72 space-y-2 overflow-auto rounded-md border border-border p-2">
              {sources.length === 0 && <p className="text-xs text-muted-foreground">音源列表为空，先添加音源。</p>}
              {sources.map(source => {
                const sourceName = source.name || source.path
                const platforms = compositeSourcePlatforms(source)
                return (
                  <div key={source.path} className="rounded px-2 py-1.5 hover:bg-accent/30">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium">{sourceName}</span>
                      <span className={`text-[10px] ${source.enabled ? 'text-green-600' : 'text-muted-foreground'}`}>{source.enabled ? '启用' : '停用'}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {platforms.map(platform => {
                        const key = compositeMemberKey({ sourceName, platform })
                        const checked = settings.members.some(member => compositeMemberKey(member) === key)
                        return (
                          <label key={platform} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={saving}
                              onChange={() => setSettings({
                                ...settings,
                                members: toggleCompositeMember(settings.members, sourceName, platform),
                              })}
                            />
                            {PLATFORM_LABELS[platform]}
                          </label>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void persist(settings)}
              disabled={saving}
              className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              保存并生效
            </button>
            <button
              onClick={() => void persist({ ...settings, enabled: false })}
              disabled={saving || !settings.enabled}
              className="flex items-center gap-1 rounded-full border border-border px-3 py-2 text-xs font-medium hover:bg-accent disabled:opacity-50"
            >
              <Square className="h-3 w-3" />一键关闭复合源
            </button>
          </div>

          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-muted-foreground">lane 运行观测（哈希、HTTP 成功率、判坏冷却）</summary>
            <div className="mt-2"><LaneTable lanes={lanes} /></div>
          </details>
        </>
      )}
    </section>
  )
}
