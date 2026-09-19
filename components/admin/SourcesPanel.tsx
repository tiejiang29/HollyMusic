
/**
 * 音源管理面板（admin Tab 子组件）。
 * 从 app/admin/sources/page.tsx 抽取，逻辑不变，去掉页面壳与鉴权重定向。
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import {
  listSources,
  createSource,
  updateSource,
  deleteSource,
  importSourceSubscription,
  uploadScript,
  updateSourceSubscription,
  startSourceProbe,
  type AdminSource,
  type ProbeStatus,
} from '@/lib/api/admin-sources'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import type { SourceHealthView } from '@/lib/server/source-health'
import type { SourceProbeVerdict } from '@/lib/services/source-manager-service'
import { Plus, Pencil, Trash2, Music, X, Loader2, Upload, AlertCircle, CheckCircle2, FileWarning, RefreshCw, Rss, Radar } from 'lucide-react'

const PLATFORMS = ['tx', 'wy', 'kw', 'kg', 'mg'] as const
const PLATFORM_LABELS: Record<string, string> = {
  tx: '腾讯',
  wy: '网易',
  kw: '酷我',
  kg: '酷狗',
  mg: '咪咕',
}

/** 运行实测健康分档（band 来自内存账本，进程重启即清零） */
const HEALTH_BAND_LABEL: Record<SourceHealthView['band'], string> = {
  healthy: '正常',
  degraded: '波动',
  cooling: '冷却中',
  'no-data': '样本少',
}
const HEALTH_BAND_CLASS: Record<SourceHealthView['band'], string> = {
  healthy: 'bg-green-500/15 text-green-600',
  degraded: 'bg-amber-500/15 text-amber-600',
  cooling: 'bg-red-500/15 text-red-600',
  'no-data': 'bg-muted text-muted-foreground',
}

/**
 * 「健康」列单元格。导出以便单测直接渲染（整页面板要 mock 异步接口，反而不如这个准）。
 * 三个容易误读的点，都在这里分开：
 * - 无实测：这个平台上还没走过取址（瀑布通常第一个源就出货，排在后面的天然没样本）
 * - 不测：pt 白名单不含该平台，压根不会向它取址——不是坏
 * - 冷却中：3c 正在跳过它，附剩余秒数；到期后放一次半开探测（标「试探」）
 */
export function healthLabel(v: SourceHealthView): string {
  if (v.band === 'cooling') {
    if (v.probing) return `${HEALTH_BAND_LABEL.cooling}·试探`
    const sec = Math.max(1, Math.ceil(v.retryAfterMs / 1000))
    return `${HEALTH_BAND_LABEL.cooling} ${sec}s`
  }
  return HEALTH_BAND_LABEL[v.band]
}

function healthTitle(v: SourceHealthView): string {
  return (
    `${PLATFORM_LABELS[v.platform] || v.platform}｜窗口 ${v.samples} 次：出货 ${v.resolveOk}、坏 ${v.bad}、无地址 ${v.noMatch}` +
    `｜延迟 p50 ${v.latencyP50Ms ?? '-'}ms / p90 ${v.latencyP90Ms ?? '-'}ms` +
    (v.lastBadReason ? `｜最近一次坏：${v.lastBadReason}` : '') +
    (v.band === 'cooling' ? `｜3c 已跳过该源${v.probing ? '，正在半开试探' : `，${Math.ceil(v.retryAfterMs / 1000)}s 后放一次探测`}（已连续翻倍 ${v.backoffs} 次）` : '')
  )
}

export function HealthCell({ health, pt }: { health?: SourceHealthView[]; pt?: string[] }) {
  const list = health || []
  const scoped = pt && pt.length ? PLATFORMS.filter(p => pt.includes(p)) : [...PLATFORMS]
  const outOfScope = PLATFORMS.filter(p => !scoped.includes(p))
  const byPlatform = new Map(list.map(v => [v.platform, v]))

  // 无实测 ≠ 这个源坏了
  if (list.length === 0) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title={outOfScope.length ? `pt 不含：${outOfScope.map(p => PLATFORM_LABELS[p] || p).join('、')}` : undefined}
      >
        无实测
      </span>
    )
  }
  return (
    <div className="flex flex-wrap gap-1">
      {scoped.map(p => {
        const v = byPlatform.get(p)
        if (!v) {
          return (
            <span
              key={p}
              title="这个平台上还没有实测样本"
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${HEALTH_BAND_CLASS['no-data']}`}
            >
              {PLATFORM_LABELS[p] || p} 无实测
            </span>
          )
        }
        return (
          <span key={p} title={healthTitle(v)} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${HEALTH_BAND_CLASS[v.band]}`}>
            {PLATFORM_LABELS[p] || p} {healthLabel(v)}
          </span>
        )
      })}
      {outOfScope.map(p => (
        <span
          key={p}
          title="pt 未包含该平台，不会向它取址（不是坏）"
          className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground/60 line-through"
        >
          {PLATFORM_LABELS[p] || p} 不测
        </span>
      ))}
    </div>
  )
}

/** 周测结论标签：口径与「健康」列不同——这里是主动探测说的，不是真实用户身上发生的 */
const PROBE_OUTCOME_LABEL: Record<string, string> = {
  ok: '出货',
  'no-address': '无地址',
  timeout: '挂起',
  error: '报错',
  ssrf: '私网地址',
  fake: '假地址',
  'http-error': 'HTTP错',
  'head-error': '取不到字节',
  unverified: '认不出',
  unsupported: '不适用',
}
const PROBE_BAD = new Set(['timeout', 'error', 'ssrf', 'fake', 'http-error', 'head-error'])

function formatAgo(ms: number): string {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000))
  if (min < 60) return `${min} 分钟前`
  const hour = Math.round(min / 60)
  if (hour < 48) return `${hour} 小时前`
  return `${Math.round(hour / 24)} 天前`
}

export function ProbeCell({ probe }: { probe?: SourceProbeVerdict[] }) {
  // 从没测过 ≠ 坏：周测可以手动关（SOURCE_PROBE_ENABLED=0），也可以只是还没到第一轮
  if (!probe || probe.length === 0) {
    return <span className="text-xs text-muted-foreground">未测过</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {probe.map(v => (
        <span
          key={v.platform}
          title={
            `${PLATFORM_LABELS[v.platform] || v.platform}｜周测（${formatAgo(v.runAt)}）结局 ${PROBE_OUTCOME_LABEL[v.outcome] || v.outcome}` +
            `｜取址 ${v.latencyMs ?? '-'}ms` +
            (v.reason ? `｜${v.reason}` : '')
          }
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            v.outcome === 'ok'
              ? 'bg-green-500/15 text-green-600'
              : PROBE_BAD.has(v.outcome)
                ? 'bg-red-500/15 text-red-600'
                : 'bg-muted text-muted-foreground'
          }`}
        >
          {PLATFORM_LABELS[v.platform] || v.platform} {PROBE_OUTCOME_LABEL[v.outcome] || v.outcome}
        </span>
      ))}
    </div>
  )
}

type DialogMode =
  | { kind: 'create' }
  | { kind: 'edit'; source: AdminSource }
  | null

export function SourcesPanel() {
  const [sources, setSources] = useState<AdminSource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogMode>(null)
  const [uploading, setUploading] = useState(false)
  const [subscriptionDialogOpen, setSubscriptionDialogOpen] = useState(false)
  const [subscribing, setSubscribing] = useState(false)
  const [updatingSubscriptionPath, setUpdatingSubscriptionPath] = useState<string | null>(null)
  const [uploadMsg, setUploadMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [probe, setProbe] = useState<ProbeStatus | null>(null)
  const [startingProbe, setStartingProbe] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(async (opts: { quiet?: boolean } = {}) => {
    // quiet：轮询用。不关掉 loading 的话每 5 秒整张表闪一次骨架屏
    if (!opts.quiet) {
      setLoading(true)
      setError(null)
    }
    try {
      const { list, probe: probeStatus } = await listSources()
      setSources(list)
      if (probeStatus) setProbe(probeStatus)
    } catch (e) {
      if (!opts.quiet) setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      if (!opts.quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  // 一批周测要跑几分钟（全矩阵串行 + 每格拉一次首块），运行中每 5 秒轻量刷一次，跑完自动停
  const probeRunning = !!probe?.running
  useEffect(() => {
    if (!probeRunning) return
    const timer = setInterval(() => { void reload({ quiet: true }) }, 5_000)
    return () => clearInterval(timer)
  }, [probeRunning, reload])

  const handleProbe = async () => {
    setStartingProbe(true)
    try {
      await startSourceProbe()
      setUploadMsg({ kind: 'success', text: '周测已启动（全矩阵串行探测，一般 1-2 分钟），跑完这一列会自动刷新' })
      await reload({ quiet: true })
    } catch (e) {
      setUploadMsg({ kind: 'error', text: e instanceof Error ? e.message : '启动周测失败' })
    } finally {
      setStartingProbe(false)
    }
  }

  const handleUpload = async (file: File) => {
    setUploading(true)
    setUploadMsg(null)
    try {
      await uploadScript(file)
      setUploadMsg({ kind: 'success', text: `脚本「${file.name}」上传成功，已自动注册` })
      await reload()
    } catch (e) {
      setUploadMsg({ kind: 'error', text: e instanceof Error ? e.message : '上传失败' })
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleSubscriptionImport = async (url: string) => {
    setSubscribing(true)
    setUploadMsg(null)
    try {
      await importSourceSubscription(url)
      setSubscriptionDialogOpen(false)
      setUploadMsg({ kind: 'success', text: '订阅导入成功，后续可在列表中手动更新' })
      await reload()
    } catch (e) {
      setUploadMsg({ kind: 'error', text: e instanceof Error ? e.message : '导入订阅失败' })
    } finally {
      setSubscribing(false)
    }
  }

  const handleSubscriptionUpdate = async (source: AdminSource) => {
    setUpdatingSubscriptionPath(source.path)
    setUploadMsg(null)
    try {
      await updateSourceSubscription(source.path)
      setUploadMsg({ kind: 'success', text: `订阅「${source.name || source.path}」已更新` })
      await reload()
    } catch (e) {
      setUploadMsg({ kind: 'error', text: e instanceof Error ? e.message : '更新订阅失败' })
    } finally {
      setUpdatingSubscriptionPath(null)
    }
  }

  const handleCreated = async (opts: {
    path: string
    name?: string
    description?: string
    priority?: number
    timeout?: number
    enabled?: boolean
    pt?: string[]
  }) => {
    await createSource(opts)
    setDialog(null)
    await reload()
  }

  const handleUpdated = async (
    sourcePath: string,
    opts: Parameters<typeof updateSource>[1]
  ) => {
    await updateSource(sourcePath, opts)
    setDialog(null)
    await reload()
  }

  const handleDelete = async (s: AdminSource) => {
    if (!confirm(`确定删除音源「${s.name || s.path}」？关联的脚本文件也会被删除。`)) return
    try {
      await deleteSource(s.path)
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : '删除失败')
    }
  }

  const toggleEnabled = async (s: AdminSource) => {
    try {
      await updateSource(s.path, { enabled: !s.enabled })
      await reload()
    } catch (e) {
      alert(e instanceof Error ? e.message : '操作失败')
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <Music className="h-5 w-5 text-primary" />
            音源管理
          </h2>
          <p className="text-sm text-muted-foreground">管理自定义音源脚本与配置</p>
          {probe?.last && (
            <p className="mt-1 text-xs text-muted-foreground">
              上次周测：{formatAgo(new Date(probe.last.startedAt).getTime())} ·
              出货 {probe.last.okCount}/{probe.last.probed} · 坏 {probe.last.badCount}
              {probe.last.status === 'failed' && ` · 本批失败：${probe.last.detail || '未知原因'}`}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleProbe}
            disabled={startingProbe || probeRunning || !!probe?.disabled}
            title={
              probe?.disabled
                ? '周测已被 SOURCE_PROBE_ENABLED=0 关闭'
                : '主动跑一遍「源 × 平台」全矩阵：逐源取址 + 拉首块验真伪，结果落库，并作为进程重启后 3c 的先验'
            }
            className="flex items-center gap-1 rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
          >
            {startingProbe || probeRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
            {probeRunning ? '周测中…' : '立即周测'}
          </button>
          <button
            onClick={() => setSubscriptionDialogOpen(true)}
            className="flex items-center gap-1 rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            <Rss className="h-4 w-4" /> 添加订阅
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".js"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) handleUpload(f)
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {uploading ? '上传中…' : '上传脚本'}
          </button>
          <button
            onClick={() => setDialog({ kind: 'create' })}
            className="flex items-center gap-1 rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            <Plus className="h-4 w-4" /> 手动添加
          </button>
        </div>
      </div>

      {uploadMsg && (
        <div
          className={`mb-4 flex items-center gap-2 rounded-md px-4 py-2 text-sm ${
            uploadMsg.kind === 'success'
              ? 'bg-green-500/10 text-green-600'
              : 'bg-destructive/10 text-destructive'
          }`}
        >
          {uploadMsg.kind === 'success' ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          <span className="flex-1 break-all">{uploadMsg.text}</span>
          <button onClick={() => setUploadMsg(null)} className="text-current/70 hover:text-current">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {loading ? (
        <LoadingSkeleton count={5} />
      ) : error ? (
        <EmptyState icon={Music} title="加载失败" description={error} />
      ) : sources.length === 0 ? (
        <EmptyState icon={Music} title="暂无音源" description="上传脚本或手动添加音源配置" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-accent/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">名称</th>
                <th className="px-4 py-3 font-medium">状态</th>
                <th
                  className="px-4 py-3 font-medium"
                  title="运行实测健康度（按平台分别）：来自真实取址与字节校验，存在内存里、重启清零。显示「无实测」只说明它没被轮到，不代表这个源坏了"
                >
                  健康
                </th>
                <th
                  className="px-4 py-3 font-medium"
                  title="最近一次周测（主动全矩阵探测）的结论：落库、跨重启，进程刚起来时 3c 就是靠它知道该跳过谁。与「健康」列口径不同，别混着读"
                >
                  周测
                </th>
                <th className="px-4 py-3 font-medium">优先级</th>
                <th className="px-4 py-3 font-medium">平台</th>
                <th className="px-4 py-3 font-medium">脚本路径</th>
                <th className="px-4 py-3 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {sources.map(s => (
                <tr key={s.path} className="border-t border-border hover:bg-accent/20">
                  <td className="px-4 py-3 font-medium">
                    {s.name || s.path}
                    {s.subscription && (
                      <span className="ml-2 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-600">
                        订阅
                      </span>
                    )}
                    {s.description && (
                      <span className="ml-2 text-xs text-muted-foreground">{s.description}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleEnabled(s)}
                      className={`rounded px-2 py-0.5 text-[10px] font-medium transition ${
                        s.enabled
                          ? 'bg-green-500/20 text-green-600'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {s.enabled ? '启用' : '停用'}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <HealthCell health={s.health} pt={s.pt} />
                  </td>
                  <td className="px-4 py-3">
                    <ProbeCell probe={s.probe} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{s.priority}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(s.pt || []).map(p => (
                        <span
                          key={p}
                          className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] text-primary"
                        >
                          {PLATFORM_LABELS[p] || p}
                        </span>
                      ))}
                      {(!s.pt || s.pt.length === 0) && (
                        <span className="text-xs text-muted-foreground">全部</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      {s.scriptExists ? (
                        <CheckCircle2 className="h-3 w-3 shrink-0 text-green-500" />
                      ) : (
                        <FileWarning className="h-3 w-3 shrink-0 text-amber-500" />
                      )}
                      <span className="max-w-[200px] truncate" title={s.path}>{s.path}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      {s.subscription && (
                        <button
                          onClick={() => handleSubscriptionUpdate(s)}
                          disabled={updatingSubscriptionPath === s.path}
                          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                          title="手动更新订阅"
                        >
                          <RefreshCw className={`h-4 w-4 ${updatingSubscriptionPath === s.path ? 'animate-spin' : ''}`} />
                        </button>
                      )}
                      <button
                        onClick={() => setDialog({ kind: 'edit', source: s })}
                        className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        title="编辑"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(s)}
                        className="rounded p-1.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                        title="删除"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog && (
        <SourceDialog
          mode={dialog}
          onClose={() => setDialog(null)}
          onCreated={handleCreated}
          onUpdated={handleUpdated}
        />
      )}
      {subscriptionDialogOpen && (
        <SubscriptionDialog
          submitting={subscribing}
          onClose={() => setSubscriptionDialogOpen(false)}
          onSubmit={handleSubscriptionImport}
        />
      )}
    </div>
  )
}

function SubscriptionDialog({
  submitting,
  onClose,
  onSubmit,
}: {
  submitting: boolean
  onClose: () => void
  onSubmit: (url: string) => Promise<void>
}) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!url.trim()) {
      setError('请输入洛雪在线脚本链接')
      return
    }
    setError(null)
    await onSubmit(url.trim())
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-xl" onClick={event => event.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-semibold"><Rss className="h-5 w-5 text-primary" />添加订阅</h3>
          <button onClick={onClose} disabled={submitting} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">洛雪在线脚本链接</span>
            <input
              autoFocus
              type="url"
              value={url}
              onChange={event => setUrl(event.target.value)}
              placeholder="https://example.com/lx-music-source.js"
              className="w-full rounded-md bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-primary"
            />
            <span className="mt-1 block text-[10px] text-muted-foreground">导入后会校验脚本，并在列表中提供手动更新按钮。</span>
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={submitting} className="rounded-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground">取消</button>
            <button type="submit" disabled={submitting} className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />} 导入
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

interface DialogProps {
  mode: Exclude<DialogMode, null>
  onClose: () => void
  onCreated: (opts: {
    path: string
    name?: string
    description?: string
    priority?: number
    timeout?: number
    enabled?: boolean
    pt?: string[]
  }) => Promise<void>
  onUpdated: (
    sourcePath: string,
    opts: {
      name?: string
      description?: string
      priority?: number
      timeout?: number
      enabled?: boolean
      pt?: string[]
    }
  ) => Promise<void>
}

function SourceDialog({ mode, onClose, onCreated, onUpdated }: DialogProps) {
  const isEdit = mode.kind === 'edit'
  const existing = isEdit ? mode.source : null

  const [path, setPath] = useState(existing?.path || '')
  const [name, setName] = useState(existing?.name || '')
  const [description, setDescription] = useState(existing?.description || '')
  const [priority, setPriority] = useState(String(existing?.priority ?? 1))
  const [timeout, setTimeout] = useState(String(existing?.timeout ?? ''))
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [pt, setPt] = useState<string[]>(existing?.pt || [])

  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null)
    setSubmitting(true)
    try {
      const priorityNum = parseInt(priority, 10)
      const timeoutNum = timeout.trim() ? parseInt(timeout, 10) : undefined

      const opts = {
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        priority: Number.isFinite(priorityNum) ? priorityNum : undefined,
        timeout: timeoutNum && Number.isFinite(timeoutNum) ? timeoutNum : undefined,
        enabled,
        pt,
      }

      if (isEdit && existing) {
        await onUpdated(existing.path, opts)
      } else {
        if (!path.trim()) throw new Error('脚本路径不能为空')
        await onCreated({ ...opts, path: path.trim() })
      }
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : '操作失败')
    } finally {
      setSubmitting(false)
    }
  }

  const togglePlatform = (p: string) => {
    setPt(prev => (prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg bg-card p-6 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{isEdit ? '编辑音源' : '添加音源'}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          {!isEdit && (
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">脚本路径 *</span>
              <input
                autoFocus
                value={path}
                onChange={e => setPath(e.target.value)}
                placeholder="custom-sources/xxx.js"
                className="w-full rounded-md bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-primary"
              />
              <span className="mt-1 block text-[10px] text-muted-foreground">
                相对项目根目录的路径，推荐放 custom-sources/ 下
              </span>
            </label>
          )}

          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">名称</span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="音源显示名称"
              className="w-full rounded-md bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-primary"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">描述</span>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="可选"
              className="w-full rounded-md bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-primary"
            />
          </label>

          <div className="flex gap-3">
            <label className="flex-1">
              <span className="mb-1 block text-xs text-muted-foreground">优先级</span>
              <input
                type="number"
                value={priority}
                onChange={e => setPriority(e.target.value)}
                className="w-full rounded-md bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-primary"
              />
            </label>
            <label className="flex-1">
              <span className="mb-1 block text-xs text-muted-foreground">超时(ms)</span>
              <input
                type="number"
                value={timeout}
                onChange={e => setTimeout(e.target.value)}
                placeholder="默认"
                className="w-full rounded-md bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-primary"
              />
            </label>
          </div>

          <div>
            <span className="mb-1 block text-xs text-muted-foreground">支持平台</span>
            <div className="flex flex-wrap gap-2">
              {PLATFORMS.map(p => (
                <button
                  key={p}
                  type="button"
                  onClick={() => togglePlatform(p)}
                  className={`rounded px-3 py-1 text-xs font-medium transition ${
                    pt.includes(p)
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {PLATFORM_LABELS[p]}
                </button>
              ))}
            </div>
            <span className="mt-1 block text-[10px] text-muted-foreground">
              不选则跟随脚本声明，限定后仅对勾选平台生效
            </span>
          </div>

          <label className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded accent-primary"
            />
            <span className="text-sm">启用此音源</span>
          </label>

          {err && <p className="text-xs text-destructive">{err}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              确定
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
