import { useEffect, useMemo, useRef, useState } from 'react'
import { Library as LibraryIcon, Music, Play, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { EmptyState } from '@/components/shared/EmptyState'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { SourceBadge } from '@/components/shared/SourceBadge'
import { apiGet } from '@/lib/api/client'
import { deleteLibrarySong, getLibraryList, rebuildLibraryIndex } from '@/lib/api/library'
import { toast } from '@/lib/toast'
import { usePlayerStore } from '@/lib/store/player-store'
import { toTrack } from '@/lib/types/player'
import type { LibrarySongItem, LibraryStats } from '@/lib/api/library'
import type { MusicInfo } from '@/lib/types/music'

/** 主歌手：完整歌手串按分隔符取第一个（与后端入库目录规则一致）。
 *  不能用懒惰正则 + $ 锚定——合并串会整体匹配失败回退成完整串。 */
function primarySinger(singer: string): string {
  const first = (singer || '')
    .split(/[、,，/／&\uFF06;；]/)[0]
    .replace(/\s*(?:feat|ft)\..*$/i, '')
    .trim()
  return first || '未知歌手'
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return '--:--'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * 音乐库浏览页：边听边下的持久化正本（library/歌手/专辑/文件）。
 * 左栏主歌手聚合（多歌手串在前端拆分聚合），右栏歌曲表 + 播放/删除；
 * 顶部容量条（配额满提示）；管理员可重建索引。
 */
export function LibraryPage() {
  const [list, setList] = useState<LibrarySongItem[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [singerGroups, setSingerGroups] = useState<Array<{ singer: string; count: number }>>([])
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [activeSinger, setActiveSinger] = useState('')
  const [page, setPage] = useState(1)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const requestId = useRef(0)
  const pageSize = 100
  const playTrack = usePlayerStore(s => s.playTrack)

  const load = async () => {
    const id = ++requestId.current
    setLoading(true)
    try {
      const result = await getLibraryList({
        keyword: keyword.trim() || undefined,
        singer: activeSinger || undefined,
        page,
        pageSize,
      })
      if (id === requestId.current) {
        setList(result.list)
        setTotal(result.total)
        setStats(result.stats)
        setSingerGroups(result.singerGroups)
      }
    } catch (err) {
      if (id === requestId.current) toast.error(`加载失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, activeSinger, page])

  // 歌手聚合：DB 按完整串 groupBy，前端拆成主歌手视图（多歌手曲目计入每个主歌手）
  const artistView = useMemo(() => {
    const map = new Map<string, number>()
    for (const g of singerGroups) {
      const key = primarySinger(g.singer)
      map.set(key, (map.get(key) || 0) + g.count)
    }
    return [...map.entries()]
      .map(([singer, count]) => ({ singer, count }))
      .sort((a, b) => b.count - a.count || a.singer.localeCompare(b.singer, 'zh'))
  }, [singerGroups])

  const handleDelete = async (item: LibrarySongItem) => {
    if (!confirm(`删除「${item.name}」？文件将从服务器移除。`)) return
    setDeletingId(item.id)
    try {
      await deleteLibrarySong(item.id)
      toast.success(`已删除「${item.name}」`)
      void load()
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDeletingId(null)
    }
  }

  const handlePlay = async (item: LibrarySongItem) => {
    if (!item.uid) {
      toast.error('该条目为手动导入，缺少来源信息，暂不支持点播')
      return
    }
    try {
      const result = await apiGet<{ musicInfo: MusicInfo }>(`track?uid=${encodeURIComponent(item.uid)}`)
      const track = toTrack({ uid: item.uid, musicInfo: result.musicInfo })
      playTrack(track, [track])
    } catch (err) {
      toast.error(`点播失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleRebuild = async () => {
    if (!confirm('重建索引将扫描库目录补全登记表（不删除任何文件），继续？')) return
    setRebuilding(true)
    try {
      const result = await rebuildLibraryIndex()
      toast.success(`扫描 ${result.scanned} 个文件，新增登记 ${result.added} 条`)
      void load()
    } catch (err) {
      toast.error(`重建失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRebuilding(false)
    }
  }

  const usedPct = stats && stats.quotaBytes > 0 ? Math.min(100, (stats.totalBytes / stats.quotaBytes) * 100) : 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const songRows = (
    <>
      {list.map(item => (
        <div key={item.id} className="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/30">
          <button
            onClick={() => void handlePlay(item)}
            disabled={!item.uid}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground transition hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
            aria-label={`播放 ${item.name}`}
            title={item.uid ? '播放' : '手动导入条目，无来源信息'}
          >
            <Play className="h-4 w-4 fill-current" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{item.name}</span>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                item.quality.startsWith('flac') ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
              }`}>
                {item.quality === 'flac24bit' ? 'Hi-Res' : item.quality === 'flac' ? 'FLAC' : item.quality.toUpperCase()}
              </span>
              {item.uid && <SourceBadge source={item.uid.split('-')[0] as never} />}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">{item.singer}</span>
              {item.album && <span className="truncate">· {item.album}</span>}
            </div>
          </div>
          <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{formatDuration(item.durationSec)}</span>
          <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{formatBytes(item.fileSize)}</span>
          <button
            onClick={() => void handleDelete(item)}
            disabled={deletingId === item.id}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-70 transition hover:bg-accent hover:text-destructive focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-coarse:p-3 pointer-coarse:-m-1.5"
            aria-label={`删除 ${item.name}`}
            title="从音乐库删除文件"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
    </>
  )

  return (
    <div className="flex flex-col p-6 pb-24 md:h-full md:pb-6">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div className="hidden md:block">
          <h1 className="text-2xl font-bold">音乐库</h1>
          <p className="text-sm text-muted-foreground">边听边下的服务器持久化音乐（{stats?.count ?? '…'} 首）</p>
        </div>
        <button
          onClick={() => void handleRebuild()}
          disabled={rebuilding}
          className="flex shrink-0 items-center gap-1 rounded-full border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${rebuilding ? 'animate-spin' : ''}`} /> 重建索引
        </button>
      </div>

      {/* 容量条 */}
      {stats && (
        <div className="mb-4 rounded-lg bg-card px-4 py-3 ring-1 ring-border">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {formatBytes(stats.totalBytes)} / {formatBytes(stats.quotaBytes)}
            </span>
            {stats.full && <span className="font-medium text-destructive">库已满，新歌不再入库（播放不受影响）</span>}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-all ${stats.full ? 'bg-destructive' : 'bg-primary'}`}
              style={{ width: `${usedPct}%` }}
            />
          </div>
        </div>
      )}

      {/* 搜索 */}
      <div className="relative mb-4 md:max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={keyword}
          onChange={e => { setKeyword(e.target.value); setPage(1) }}
          placeholder="搜索歌名 / 歌手 / 专辑..."
          className="w-full rounded-full bg-card py-2 pl-10 pr-9 text-sm outline-none ring-1 ring-border focus:ring-primary"
        />
        {keyword && (
          <button onClick={() => setKeyword('')} aria-label="清空" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 gap-6">
        {/* 左栏：歌手聚合（移动端隐藏，改用筛选标签） */}
        <aside className="hidden w-56 shrink-0 overflow-y-auto pr-1 md:block">
          <button
            onClick={() => { setActiveSinger(''); setPage(1) }}
            className={`mb-1 flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm transition ${
              !activeSinger ? 'bg-accent font-semibold' : 'text-foreground/80 hover:bg-accent/50'
            }`}
          >
            <span className="flex items-center gap-2"><LibraryIcon className="h-4 w-4" /> 全部歌手</span>
            <span className="text-xs text-muted-foreground">{stats?.count ?? ''}</span>
          </button>
          {artistView.map(a => (
            <button
              key={a.singer}
              onClick={() => { setActiveSinger(a.singer); setPage(1) }}
              className={`mb-0.5 flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm transition ${
                activeSinger === a.singer ? 'bg-accent font-semibold' : 'text-foreground/80 hover:bg-accent/50'
              }`}
            >
              <span className="truncate">{a.singer}</span>
              <span className="ml-2 shrink-0 text-xs text-muted-foreground">{a.count}</span>
            </button>
          ))}
        </aside>

        {/* 右栏：歌曲列表 */}
        <main className="min-w-0 flex-1 md:overflow-y-auto md:pr-1">
          {/* 移动端歌手筛选 chips */}
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1 md:hidden">
            <button
              onClick={() => { setActiveSinger(''); setPage(1) }}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${!activeSinger ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground'}`}
            >
              全部
            </button>
            {artistView.slice(0, 20).map(a => (
              <button
                key={a.singer}
                onClick={() => { setActiveSinger(a.singer); setPage(1) }}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${activeSinger === a.singer ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground'}`}
              >
                {a.singer} {a.count}
              </button>
            ))}
          </div>

          {loading ? (
            <LoadingSkeleton count={8} />
          ) : list.length === 0 ? (
            <EmptyState
              icon={Music}
              title="音乐库还是空的"
              description="播放或下载过的歌曲会自动保存到服务器（按歌手/专辑归档）"
            />
          ) : (
            <div className="flex flex-col">{songRows}</div>
          )}

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1 || loading}
                className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
              >
                上一页
              </button>
              <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages || loading}
                className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
              >
                下一页
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
