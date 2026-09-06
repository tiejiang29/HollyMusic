import { useEffect, useMemo, useRef, useState } from 'react'
import { Library as LibraryIcon, Music, Play, RefreshCw, Search, Trash2, X, Heart, ListPlus, ListMusic, Download, Check, CheckSquare } from 'lucide-react'
import { EmptyState } from '@/components/shared/EmptyState'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { SourceBadge } from '@/components/shared/SourceBadge'
import { CoverImage } from '@/components/shared/CoverImage'
import { useFavoritesStore } from '@/lib/store/favorites-store'
import { AddToPlaylistDialog } from '../components/playlists/AddToPlaylistDialog'
import { apiGet } from '@/lib/api/client'
import { deleteLibrarySong, getLibraryList, rebuildLibraryIndex } from '@/lib/api/library'
import { toast } from '@/lib/toast'
import { usePlayerStore } from '@/lib/store/player-store'
import { useDownload } from '@/hooks/useDownload'
import { QUALITY_LABEL } from '@/lib/quality-options'
import { toTrack } from '@/lib/types/player'
import type { LibrarySongItem, LibraryStats } from '@/lib/api/library'
import type { MusicInfo } from '@/lib/types/music'

/** 歌手聚合与拼音首字母由服务端下发（singerGroups.initials），
 *  前端不再本地拆分/转换，避免引入拼音库增加包体。 */

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
  const [singerGroups, setSingerGroups] = useState<Array<{ singer: string; count: number; initials: string }>>([])
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [activeSinger, setActiveSinger] = useState('')
  const [page, setPage] = useState(1)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const requestId = useRef(0)
  const pageSize = 100
  const playTrack = usePlayerStore(s => s.playTrack)
  const addToQueue = usePlayerStore(s => s.addToQueue)
  const quality = usePlayerStore(s => s.quality)
  const { download, downloadBatch } = useDownload()
  const favoritesIds = useFavoritesStore(s => s.ids)
  const toggleFav = useFavoritesStore(s => s.toggle)
  const [playlistUid, setPlaylistUid] = useState<string | null>(null)
  // 批量下载（勾选模式，仅当前页可选）
  const [selecting, setSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  // 歌手栏独立搜索（客户端过滤）
  const [artistQuery, setArtistQuery] = useState('')

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

  // 歌手视图：服务端已拆分聚合（多歌手曲目计入每个参与歌手）+ 按字母/拼音排序
  // + 附带拼音首字母（initials），前端不再本地拆分/转换
  const artistView = useMemo(() => singerGroups, [singerGroups])

  // 左栏先按歌手搜索框过滤（名字或拼音首字母），再截断展示
  const MAX_ARTISTS_SHOWN = 100
  const artistKeyword = artistQuery.trim().toLowerCase()
  const filteredArtists = artistKeyword
    ? artistView.filter(a => a.singer.toLowerCase().includes(artistKeyword) || a.initials.includes(artistKeyword))
    : artistView
  const shownArtists = filteredArtists.slice(0, MAX_ARTISTS_SHOWN)

  // ---------- 批量下载 ----------
  const selectableItems = list.filter(i => i.uid)
  const allSelected = selectableItems.length > 0 && selectableItems.every(i => selectedIds.has(i.id))
  const toggleSelect = (item: LibrarySongItem) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
  }
  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(selectableItems.map(i => i.id)))
  }
  const exitSelecting = () => {
    setSelecting(false)
    setSelectedIds(new Set())
  }
  const handleBatchDownload = () => {
    const uids = selectableItems.filter(i => selectedIds.has(i.id)).map(i => i.uid)
    if (uids.length === 0) return
    if (!confirm(`打包下载选中的 ${uids.length} 首（音质偏好：${QUALITY_LABEL[quality]}）？`)) return
    downloadBatch(uids, quality)
    exitSelecting()
  }

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

  /** 手动导入条目（uid 空）不可点播/入队/下载 */
  const fetchTrack = async (item: LibrarySongItem) => {
    const result = await apiGet<{ musicInfo: MusicInfo }>(`track?uid=${encodeURIComponent(item.uid)}`)
    return toTrack({ uid: item.uid, musicInfo: result.musicInfo })
  }

  const handlePlay = async (item: LibrarySongItem) => {
    if (!item.uid) {
      toast.error('该条目为手动导入，缺少来源信息，暂不支持点播')
      return
    }
    try {
      const track = await fetchTrack(item)
      playTrack(track, [track])
    } catch (err) {
      toast.error(`点播失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleAddQueue = async (item: LibrarySongItem) => {
    if (!item.uid) {
      toast.error('该条目为手动导入，缺少来源信息')
      return
    }
    try {
      const track = await fetchTrack(item)
      addToQueue(track)
      toast.info(`已加入播放队列：${item.name}`)
    } catch (err) {
      toast.error(`加入队列失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleDownload = (item: LibrarySongItem) => {
    if (!item.uid) {
      toast.error('该条目为手动导入，缺少来源信息')
      return
    }
    // 音质传当前偏好；后端音乐库命中时直接发本地文件（秒下）
    download({ uid: item.uid, quality: usePlayerStore.getState().quality })
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

  const selectableHint = stats?.count ?? 0
  const usedPct = stats && stats.quotaBytes > 0 ? Math.min(100, (stats.totalBytes / stats.quotaBytes) * 100) : 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const songRows = (
    <>
      {list.map(item => {
        const canPlay = Boolean(item.uid)
        const isFav = canPlay && favoritesIds.has(item.uid)
        return (
          <div key={item.id} className={`group flex items-center gap-3 rounded-md px-2 py-2 ${selecting && canPlay ? 'cursor-pointer' : ''} hover:bg-accent/30`}>
            {selecting && canPlay && (
              <button
                type="button"
                role="checkbox"
                aria-checked={selectedIds.has(item.id)}
                aria-label={`选择 ${item.name}`}
                onClick={() => toggleSelect(item)}
                className="-m-2 shrink-0 rounded p-2 transition hover:bg-accent/50 pointer-coarse:-m-1 pointer-coarse:p-1.5"
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded border transition ${
                    selectedIds.has(item.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50'
                  }`}
                >
                  {selectedIds.has(item.id) && <Check className="h-3.5 w-3.5" />}
                </span>
              </button>
            )}
            {/* 封面前置（与全局歌曲行一致；手动导入条目无封面走占位） */}
            <button
              onClick={() => canPlay && (selecting ? toggleSelect(item) : void handlePlay(item))}
              disabled={!canPlay}
              className="shrink-0 disabled:cursor-default"
              aria-label={`播放 ${item.name}`}
              title={canPlay ? '播放' : '手动导入条目，无来源信息'}
            >
              <CoverImage uid={item.uid} cacheKey={item.img} className="h-10 w-10" />
            </button>
            <button
              onClick={() => canPlay && (selecting ? toggleSelect(item) : void handlePlay(item))}
              disabled={!canPlay}
              className="min-w-0 flex-1 text-left disabled:cursor-default"
              title={canPlay ? (selecting ? '勾选/取消' : '单击播放') : '手动导入条目，无来源信息'}
            >
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
                {item.album && <span className="truncate md:hidden">· {item.album}</span>}
              </div>
            </button>
            <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground md:block" title={item.album || ''}>
              {item.album || '—'}
            </span>
            <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{formatDuration(item.durationSec)}</span>
            <span className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:inline">{formatBytes(item.fileSize)}</span>

            {/* 尾部操作：收藏 / 加入歌单 / 播放 / 删除（桌面 hover 显现，移动端常显） */}
            {canPlay && (
              <button
                onClick={() => void toggleFav(item.uid).catch(() => {})}
                className={`shrink-0 rounded-md p-1.5 transition hover:bg-accent focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-coarse:p-3 pointer-coarse:-m-1.5 ${
                  isFav ? 'text-primary opacity-100 pointer-fine:opacity-100' : 'text-muted-foreground opacity-70 hover:text-foreground'
                }`}
                aria-label={isFav ? `取消收藏 ${item.name}` : `收藏 ${item.name}`}
                title={isFav ? '取消收藏' : '收藏'}
              >
                <Heart className={`h-4 w-4 ${isFav ? 'fill-current' : ''}`} />
              </button>
            )}
            {canPlay && (
              <button
                onClick={() => setPlaylistUid(item.uid)}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-70 transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-coarse:p-3 pointer-coarse:-m-1.5"
                aria-label={`加入歌单 ${item.name}`}
                title="加入歌单"
              >
                <ListMusic className="h-4 w-4" />
              </button>
            )}
            {canPlay && (
              <button
                onClick={() => void handleAddQueue(item)}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-70 transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-coarse:p-3 pointer-coarse:-m-1.5"
                aria-label={`加入播放队列 ${item.name}`}
                title="加入播放队列"
              >
                <ListPlus className="h-4 w-4" />
              </button>
            )}
            {canPlay && (
              <button
                onClick={() => handleDownload(item)}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-70 transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-coarse:p-3 pointer-coarse:-m-1.5"
                aria-label={`下载 ${item.name}`}
                title="下载（优先本地库文件）"
              >
                <Download className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={() => canPlay && void handlePlay(item)}
              disabled={!canPlay}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-70 transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:opacity-40 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-coarse:p-3 pointer-coarse:-m-1.5"
              aria-label={`播放 ${item.name}`}
              title={canPlay ? '播放' : '无来源信息'}
            >
              <Play className="h-4 w-4 fill-current" />
            </button>
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
        )
      })}
    </>
  )

  return (
    <div className="flex flex-col p-6 pb-24 md:h-full md:pb-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="hidden md:block">
          <h1 className="text-2xl font-bold">音乐库</h1>
          <p className="text-sm text-muted-foreground">边听边下的服务器持久化音乐（{stats?.count ?? '…'} 首）</p>
        </div>
        <div className="relative min-w-0 flex-1 basis-48 md:ml-auto md:max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={keyword}
            onChange={e => { setKeyword(e.target.value); setPage(1) }}
            placeholder="搜索歌名 / 歌手 / 专辑 / 首字母..."
            className="w-full rounded-full bg-card py-2 pl-10 pr-9 text-sm outline-none ring-1 ring-border focus:ring-primary"
          />
          {keyword && (
            <button onClick={() => setKeyword('')} aria-label="清空" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <button
          onClick={() => (selecting ? exitSelecting() : setSelecting(true))}
          disabled={selectableHint === 0 && !selecting}
          className={`flex shrink-0 items-center gap-1 rounded-full px-3 py-2 text-sm transition disabled:opacity-50 ${
            selecting ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground hover:text-foreground'
          }`}
        >
          <Download className="h-4 w-4" /> {selecting ? '取消选择' : '批量下载'}
        </button>
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

      <div className="flex min-h-0 flex-1 gap-6">
        {/* 左栏：歌手聚合（移动端隐藏，改用筛选标签） */}
        <aside className="hidden w-56 shrink-0 flex-col pr-1 md:flex">
          <div className="relative mb-2">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={artistQuery}
              onChange={e => setArtistQuery(e.target.value)}
              placeholder="搜索歌手 / 首字母..."
              className="w-full rounded-full bg-card py-1.5 pl-8 pr-7 text-xs outline-none ring-1 ring-border focus:ring-primary"
            />
            {artistQuery && (
              <button onClick={() => setArtistQuery('')} aria-label="清空歌手搜索" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
          <button
            onClick={() => { setActiveSinger(''); setPage(1) }}
            className={`mb-1 flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm transition ${
              !activeSinger ? 'bg-accent font-semibold' : 'text-foreground/80 hover:bg-accent/50'
            }`}
          >
            <span className="flex items-center gap-2"><LibraryIcon className="h-4 w-4" /> 全部歌手</span>
            <span className="text-xs text-muted-foreground">{stats?.count ?? ''}</span>
          </button>
          {shownArtists.map(a => (
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
          {(filteredArtists.length > MAX_ARTISTS_SHOWN || (artistKeyword && artistView.length > 0 && filteredArtists.length === 0)) && (
            <p className="px-2 pt-2 text-xs text-muted-foreground">
              {filteredArtists.length === 0
                ? '没有匹配的歌手'
                : `仅显示前 ${MAX_ARTISTS_SHOWN} 位（共 ${filteredArtists.length}）`}
            </p>
          )}
          </div>
        </aside>

        {/* 右栏：歌曲列表 */}
        <main className="min-w-0 flex-1 md:overflow-y-auto md:pr-1">
          {/* 批量下载工具条 */}
          {selecting && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-card px-3 py-2 ring-1 ring-border">
              <button onClick={toggleSelectAll} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                <CheckSquare className={`h-4 w-4 ${allSelected ? 'text-primary' : ''}`} />
                {allSelected ? '取消全选' : '全选'}
              </button>
              <span className="text-sm text-muted-foreground">已选 {selectedIds.size} 首</span>
              <div className="flex-1" />
              <button
                onClick={handleBatchDownload}
                disabled={selectedIds.size === 0}
                className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                <Download className="h-4 w-4" /> 下载选中
              </button>
            </div>
          )}
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

      {playlistUid && <AddToPlaylistDialog uid={playlistUid} onClose={() => setPlaylistUid(null)} />}
    </div>
  )
}
