
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Link2, Music, RefreshCw, X } from 'lucide-react'
import { getPlaylistTags, getRecommendedPlaylists } from '@/lib/api/discovery'
import type { DiscoveryPlaylist, DiscoveryPlaylistSort, DiscoverySource, PlaylistTagsResult } from '@/lib/services/discovery-service'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { RemoteCoverImage } from '@/components/shared/RemoteCoverImage'

const SOURCES: { value: DiscoverySource; label: string }[] = [
  { value: 'tx', label: 'QQ' },
  { value: 'wy', label: '网易' },
  { value: 'kw', label: '酷我' },
  { value: 'kg', label: '酷狗' },
  { value: 'mg', label: '咪咕' },
]

/** 各源支持的排序（与洛雪 sortList 对齐：kg/mg 上游只有最热/最新两档） */
const SORTS: Partial<Record<DiscoverySource, { value: DiscoveryPlaylistSort; label: string }[]>> = {
  tx: [
    { value: 'hot', label: '最热' },
    { value: 'new', label: '最新' },
  ],
  wy: [
    { value: 'hot', label: '最热' },
    { value: 'new', label: '最新' },
  ],
  kw: [
    { value: 'hot', label: '最热' },
    { value: 'new', label: '最新' },
  ],
  kg: [
    { value: 'recommend', label: '推荐' },
    { value: 'hot', label: '最热' },
    { value: 'new', label: '最新' },
    { value: 'collect', label: '热藏' },
    { value: 'soar', label: '飙升' },
  ],
  mg: [
    { value: 'recommend', label: '推荐' },
    { value: 'hot', label: '最热' },
    { value: 'new', label: '最新' },
  ],
}

function formatPlayCount(n: number): string {
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(n)
}

/** 推荐页 = 歌单广场（样式与交互对齐 lx-music-desktop 歌单列表页）。
 *  原本地随机推荐入口保留在首页。 */
export function RecommendedMusicPage() {
  const navigate = useNavigate()
  const [source, setSource] = useState<DiscoverySource>('tx')
  const [sort, setSort] = useState<DiscoveryPlaylistSort>('hot')
  const [tag, setTag] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [playlists, setPlaylists] = useState<DiscoveryPlaylist[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tags, setTags] = useState<PlaylistTagsResult | null>(null)
  const [openListOpen, setOpenListOpen] = useState(false)
  const reqId = useRef(0)

  const load = useCallback(async (src: DiscoverySource, s: DiscoveryPlaylistSort, t: string | null, p: number) => {
    const id = ++reqId.current
    setLoading(true)
    setError(null)
    try {
      const list = await getRecommendedPlaylists(src, 24, p, { sort: s, tag: t || undefined })
      if (id !== reqId.current) return
      setPlaylists(list)
    } catch (err) {
      if (id !== reqId.current) return
      setPlaylists([])
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      if (id === reqId.current) setLoading(false)
    }
  }, [])

  // 源切换：重置排序/标签/页码并拉新；标签排序变化只重置页码
  useEffect(() => {
    void load(source, sort, tag, page)
  }, [source, sort, tag, page, load])

  // 标签列表按源拉取（失败静默：没有标签也能用广场）
  useEffect(() => {
    let alive = true
    setTags(null)
    getPlaylistTags(source)
      .then(r => { if (alive) setTags(r) })
      .catch(() => {})
    return () => { alive = false }
  }, [source])

  const switchSource = (next: DiscoverySource) => {
    if (next === source) return
    setSort((SORTS[next] || [])[0]?.value ?? 'hot')
    setTag(null)
    setPage(1)
    setSource(next)
  }
  const chooseTag = (id: string | null) => {
    if (id === tag) return
    setTag(id)
    setPage(1)
  }

  return (
    <div className="p-4 md:p-6">
      {/* 顶栏：源选择 + 打开歌单（对齐洛雪：顶部一行源下拉 + 操作按钮） */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-2 hidden text-2xl font-bold md:block">推荐</h1>
        <div role="tablist" aria-label="音源" className="flex gap-1 rounded-full bg-card p-1 ring-1 ring-border">
          {SOURCES.map(s => (
            <button
              key={s.value}
              role="tab"
              aria-selected={source === s.value}
              onClick={() => switchSource(s.value)}
              className={`rounded-full px-3 py-1.5 text-sm transition-colors ${source === s.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => void load(source, sort, tag, page)}
            className="flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-sm hover:bg-accent"
            aria-label="刷新"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            onClick={() => setOpenListOpen(true)}
            className="flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-sm hover:bg-accent"
          >
            <Link2 className="h-4 w-4" /> 打开歌单
          </button>
        </div>
      </div>

      {/* 热门标签横排（可横滑，对齐洛雪 tag-list） */}
      {tags && tags.hotTag.length > 0 && (
        <div className="mb-3 flex items-center gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => chooseTag(null)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs transition-colors ${tag === null ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground ring-1 ring-border hover:text-foreground'}`}
          >
            全部
          </button>
          {tags.hotTag.map(t => (
            <button
              key={t.id}
              onClick={() => chooseTag(t.id)}
              className={`shrink-0 rounded-full px-3 py-1 text-xs transition-colors ${tag === t.id ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground ring-1 ring-border hover:text-foreground'}`}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      {/* 排序（对齐洛雪 sort-tab） */}
      {(SORTS[source] || []).length > 1 && (
        <div className="mb-4 flex gap-4 border-b border-border pb-2">
          {(SORTS[source] || []).map(s => (
            <button
              key={s.value}
              onClick={() => { if (sort !== s.value) { setSort(s.value); setPage(1) } }}
              className={`text-sm transition-colors ${sort === s.value ? 'font-medium text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {/* 歌单卡片网格 */}
      {loading ? (
        <LoadingSkeleton count={8} />
      ) : error ? (
        <EmptyState icon={Music} title="加载失败" description={error} />
      ) : playlists.length === 0 ? (
        <EmptyState icon={Music} title="暂无歌单" description="该分类下没有更多歌单了" />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {playlists.map(pl => (
            <button
              key={`${pl.source}-${pl.id}`}
              onClick={() => navigate(`/discover/playlists/${encodeURIComponent(pl.id)}?source=${pl.source}`)}
              className="group flex flex-col gap-1.5 rounded-lg p-1.5 text-left transition-colors hover:bg-accent/40"
            >
              <RemoteCoverImage src={pl.cover} alt={pl.name} className="aspect-square w-full rounded-md object-cover" />
              <div className="truncate text-sm font-medium" title={pl.name}>{pl.name}</div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="truncate">{pl.author}</span>
                {pl.playCount > 0 && <span className="shrink-0">{formatPlayCount(pl.playCount)}次</span>}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 分页（对齐洛雪：上一页/页码/下一页） */}
      {!loading && playlists.length > 0 && (
        <div className="mt-6 flex items-center justify-center gap-4">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded-full border border-border p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            aria-label="上一页"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm text-muted-foreground">第 {page} 页</span>
          <button
            onClick={() => setPage(p => (playlists.length < 24 ? p : p + 1))}
            disabled={playlists.length < 24}
            className="rounded-full border border-border p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            aria-label="下一页"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 打开歌单弹窗（对齐洛雪 open-list-modal：粘贴分享链接/ID 直达详情） */}
      {openListOpen && (
        <OpenListModal
          source={source}
          onClose={() => setOpenListOpen(false)}
          onOpen={(id, src) => navigate(`/discover/playlists/${encodeURIComponent(id)}?source=${src}`)}
        />
      )}
    </div>
  )
}

/** 从分享链接/ID 解析歌单：/playlist/(\d+)、id=(\d+)、tid=、纯数字/字母数字混合 ID */
function parseListId(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  const m = text.match(/(?:\/playlist\/|playlist\/|id=|tid=|listid=)([A-Za-z0-9]+)/) || text.match(/^([A-Za-z0-9]{6,32})$/)
  return m ? m[1] : null
}

function OpenListModal({ source, onClose, onOpen }: { source: DiscoverySource; onClose: () => void; onOpen: (id: string, source: DiscoverySource) => void }) {
  const [value, setValue] = useState('')
  const [pickedSource, setPickedSource] = useState<DiscoverySource>(source)
  const id = parseListId(value)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-card p-5 shadow-xl ring-1 ring-border" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">打开歌单</h2>
          <button onClick={onClose} className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">粘贴各平台歌单分享链接或直接输入歌单 ID</p>
        <textarea
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="例如：https://y.qq.com/n/ryqq/playlist/7217720898"
          rows={3}
          className="mb-3 w-full resize-none rounded-lg bg-background p-3 text-sm outline-none ring-1 ring-border focus:ring-primary"
        />
        <div className="mb-4 flex flex-wrap gap-1">
          {SOURCES.map(s => (
            <button
              key={s.value}
              onClick={() => setPickedSource(s.value)}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${pickedSource === s.value ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground ring-1 ring-border hover:text-foreground'}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => { if (id) { onOpen(id, pickedSource); onClose() } }}
          disabled={!id}
          className="w-full rounded-full bg-primary py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          打开{id ? `（ID: ${id}）` : ''}
        </button>
      </div>
    </div>
  )
}
