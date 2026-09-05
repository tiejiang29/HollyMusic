import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ListMusic, Loader2, Music, Play, RefreshCw, Search, Trophy, X } from 'lucide-react'
import { EmptyState } from '@/components/shared/EmptyState'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { RemoteCoverImage } from '@/components/shared/RemoteCoverImage'
import { SongList } from '@/components/shared/SongList'
import { getToplistDetail, getToplists } from '@/lib/api/discovery'
import { addSongsToPlaylist, createPlaylist } from '@/lib/api/playlists'
import { toast } from '@/lib/toast'
import { usePlayerStore } from '@/lib/store/player-store'
import { toTrack } from '@/lib/types/player'
import type { DiscoveryCollectionDetail, DiscoverySource, DiscoveryToplist } from '@/lib/services/discovery-service'

const CHANNELS: Array<{ value: DiscoverySource; label: string }> = [
  { value: 'tx', label: 'QQ' },
  { value: 'wy', label: '网易' },
  { value: 'kw', label: '酷我' },
  { value: 'kg', label: '酷狗' },
  { value: 'mg', label: '咪咕' },
]

const LAST_KEY = 'leaderboard:last'

function parseSource(value: string | null): DiscoverySource {
  return value === 'wy' || value === 'kw' || value === 'kg' || value === 'mg' ? value : 'tx'
}

/**
 * 排行榜独立页（桌面双栏：左源+榜单列表，右榜单详情；移动端榜单列表收进弹窗）。
 * 全量榜单来自 /api/discover/toplists?scope=full（数据源 lx-music-desktop），
 * 上次浏览位置持久化到 localStorage 并同步到 URL query（可分享/刷新保持）。
 */
export function LeaderboardPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const source = parseSource(searchParams.get('source'))
  const boardId = searchParams.get('id') || ''

  const [boards, setBoards] = useState<DiscoveryToplist[]>([])
  const [boardsLoading, setBoardsLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [detail, setDetail] = useState<DiscoveryCollectionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [collectOpen, setCollectOpen] = useState(false)
  const [collecting, setCollecting] = useState(false)

  const playTrack = usePlayerStore(s => s.playTrack)
  const detailRequestId = useRef(0)

  // ---------- 榜单列表（随源切换） ----------
  useEffect(() => {
    let cancelled = false
    setBoardsLoading(true)
    getToplists(source, 'full')
      .then(list => { if (!cancelled) setBoards(list) })
      .catch(() => { if (!cancelled) setBoards([]) })
      .finally(() => { if (!cancelled) setBoardsLoading(false) })
    return () => { cancelled = true }
  }, [source])

  // ---------- 无 id 时回填默认榜单（上次浏览 > 首个常用） ----------
  useEffect(() => {
    if (boardId || boardsLoading || boards.length === 0) return
    const last = (() => {
      try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null') } catch { return null }
    })()
    const fallback =
      (last && last.source === source && boards.find(b => b.id === last.id)?.id) ||
      boards.find(b => b.common)?.id ||
      boards[0].id
    selectBoard(fallback)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardsLoading, boards, boardId, source])

  // ---------- 榜单详情（随 源+榜单 变化） ----------
  useEffect(() => {
    if (!boardId) return
    const requestId = ++detailRequestId.current
    setDetailLoading(true)
    setDetailError(null)
    setDetail(null)
    getToplistDetail(source, boardId)
      .then(result => { if (requestId === detailRequestId.current) setDetail(result) })
      .catch(err => { if (requestId === detailRequestId.current) setDetailError(err instanceof Error ? err.message : '加载失败') })
      .finally(() => { if (requestId === detailRequestId.current) setDetailLoading(false) })
    localStorage.setItem(LAST_KEY, JSON.stringify({ source, id: boardId }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, boardId])

  const selectBoard = (id: string) => {
    setSearchParams({ source, id }, { replace: true })
  }

  const switchSource = (next: DiscoverySource) => {
    if (next === source) return
    // 同步清空旧列表：URL 更新后的首个 render 里，回填 effect 会先于榜单加载完成执行，
    // 若残留旧源列表会按旧源的常用榜选错 id（跨源 id 撞号）
    setBoards([])
    setBoardsLoading(true)
    // 清空 id：避免旧 id 以新源请求详情并污染 localStorage，让回填逻辑选中新源首个常用榜
    setSearchParams({ source: next, id: '' }, { replace: true })
  }

  const tracks = useMemo(() => (detail?.tracks ?? []).map(song => toTrack({ uid: song.uid, musicInfo: song })), [detail])

  const keyword = filter.trim().toLowerCase()
  const filtered = keyword ? boards.filter(b => b.name.toLowerCase().includes(keyword)) : boards
  const commonBoards = filtered.filter(b => b.common)
  const otherBoards = filtered.filter(b => !b.common)
  const currentBoard = boards.find(b => b.id === boardId)

  const loadDetail = () => {
    if (!boardId) return
    setDetailLoading(true)
    setDetailError(null)
    getToplistDetail(source, boardId)
      .then(setDetail)
      .catch(err => setDetailError(err instanceof Error ? err.message : '加载失败'))
      .finally(() => setDetailLoading(false))
  }

  /** 收藏榜单：把当前榜单歌曲快照存为我的歌单 */
  const collectBoard = async (name: string) => {
    if (tracks.length === 0) return
    setCollecting(true)
    try {
      const playlist = await createPlaylist(name)
      await addSongsToPlaylist(playlist.id, tracks.map(t => t.uid))
      toast.success(`已收藏到歌单「${name}」（${tracks.length} 首）`)
      setCollectOpen(false)
    } catch (err) {
      toast.error(`收藏失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCollecting(false)
    }
  }

  const boardListUI = (
    <>
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="搜索榜单..."
          className="w-full rounded-full bg-card py-2 pl-10 pr-9 text-sm outline-none ring-1 ring-border focus:ring-primary"
        />
        {filter && (
          <button onClick={() => setFilter('')} aria-label="清空" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {boardsLoading ? (
        <LoadingSkeleton count={8} />
      ) : boards.length === 0 ? (
        <EmptyState icon={Trophy} title="榜单加载失败" description="请稍后重试" />
      ) : filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">没有匹配的榜单</p>
      ) : (
        <div className="space-y-4">
          {commonBoards.length > 0 && <BoardSection title="常用榜单" boards={commonBoards} boardId={boardId} onSelect={id => { selectBoard(id); setPickerOpen(false) }} />}
          {otherBoards.length > 0 && <BoardSection title="全部榜单" boards={otherBoards} boardId={boardId} onSelect={id => { selectBoard(id); setPickerOpen(false) }} />}
        </div>
      )}
    </>
  )

  return (
    <div className="flex flex-col p-6 pb-24 md:h-full md:pb-6">
      <div className="mb-4 hidden md:block">
        <h1 className="text-2xl font-bold">排行榜</h1>
        <p className="text-sm text-muted-foreground">各平台官方榜单，共 {boards.length || '…'} 个</p>
      </div>

      {/* 源切换 */}
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="音乐渠道">
        {CHANNELS.map(channel => (
          <button
            key={channel.value}
            onClick={() => switchSource(channel.value)}
            className={`rounded-full px-4 py-2 text-sm transition ${source === channel.value ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground hover:bg-accent hover:text-foreground'}`}
            role="tab"
            aria-selected={source === channel.value}
          >
            {channel.label}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 gap-6">
        {/* 左栏：榜单列表（桌面常驻，移动端收进弹窗） */}
        <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto pr-1 md:flex">{boardListUI}</aside>

        {/* 右栏：榜单详情（桌面独立滚动） */}
        <main className="min-w-0 flex-1 md:overflow-y-auto md:pr-1">
          {/* 移动端：当前榜单按钮，点开选择弹窗 */}
          <button
            onClick={() => setPickerOpen(true)}
            className="mb-3 flex w-full items-center justify-between rounded-lg bg-card px-4 py-3 text-left text-sm ring-1 ring-border md:hidden"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Trophy className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate font-medium">{currentBoard?.name ?? '选择榜单'}</span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">切换 ›</span>
          </button>

          {detailLoading ? (
            <LoadingSkeleton count={10} />
          ) : !boardId ? (
            <EmptyState icon={Trophy} title="选择一个榜单" description="左侧选择榜单后展示歌曲" />
          ) : detailError ? (
            <EmptyState icon={Music} title="榜单加载失败" description={detailError} />
          ) : detail ? (
            <>
              <div className="mb-5 flex items-end gap-4">
                {detail.cover ? (
                  <RemoteCoverImage src={detail.cover} alt="" className="h-28 w-28 shrink-0 rounded-lg object-cover shadow-lg" />
                ) : (
                  <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/50 to-primary/10 shadow-lg">
                    <ListMusic className="h-10 w-10 text-primary-foreground/80" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-2xl font-bold">{detail.name}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {detail.author}{detail.updateTime ? ` · 更新于 ${detail.updateTime}` : ''}{tracks.length > 0 ? ` · ${tracks.length} 首` : ''}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => tracks[0] && playTrack(tracks[0], tracks)}
                      disabled={tracks.length === 0}
                      className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      <Play className="h-4 w-4 fill-current" /> 播放全部
                    </button>
                    <button
                      onClick={() => setCollectOpen(true)}
                      disabled={tracks.length === 0}
                      className="flex items-center gap-1 rounded-full border border-border px-4 py-2 text-sm hover:bg-accent disabled:opacity-50"
                    >
                      <ListMusic className="h-4 w-4" /> 收藏榜单
                    </button>
                    <button onClick={loadDetail} className="rounded-full border border-border p-2 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="刷新">
                      <RefreshCw className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
              {tracks.length > 0 ? <SongList tracks={tracks} rankMode /> : <EmptyState icon={Music} title="暂无可播放歌曲" />}
            </>
          ) : null}
        </main>
      </div>

      {/* 移动端榜单选择弹窗 */}
      {pickerOpen && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/60 md:hidden" onClick={() => setPickerOpen(false)}>
          <div
            className="max-h-[80vh] w-full overflow-y-auto rounded-t-2xl bg-background p-4 pb-8 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold">选择榜单</h3>
              <button onClick={() => setPickerOpen(false)} aria-label="关闭" className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>
            {boardListUI}
          </div>
        </div>
      )}

      {/* 收藏榜单弹窗 */}
      {collectOpen && detail && (
        <CollectBoardDialog
          defaultName={detail.name}
          count={tracks.length}
          submitting={collecting}
          onClose={() => setCollectOpen(false)}
          onSubmit={collectBoard}
        />
      )}
    </div>
  )
}

function BoardSection({
  title,
  boards,
  boardId,
  onSelect,
}: {
  title: string
  boards: DiscoveryToplist[]
  boardId: string
  onSelect: (id: string) => void
}) {
  return (
    <section>
      <h3 className="mb-1.5 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul>
        {boards.map(board => {
          const active = board.id === boardId
          return (
            <li key={board.id}>
              <button
                onClick={() => onSelect(board.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition ${
                  active ? 'bg-accent font-semibold text-foreground' : 'text-foreground/80 hover:bg-accent/50'
                }`}
              >
                {active && <span className="h-4 w-1 shrink-0 rounded-full bg-primary" />}
                <span className="truncate">{board.name}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function CollectBoardDialog({
  defaultName,
  count,
  submitting,
  onClose,
  onSubmit,
}: {
  defaultName: string
  count: number
  submitting: boolean
  onClose: () => void
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState(defaultName)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-sm rounded-lg bg-card p-6 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">收藏榜单为歌单</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="关闭">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-3 text-sm text-muted-foreground">将当前榜单的 {count} 首歌快照保存为歌单（榜单每日更新，歌单保持不变）</p>
        <form
          onSubmit={e => {
            e.preventDefault()
            if (name.trim() && !submitting) onSubmit(name.trim())
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="歌单名称"
            className="mb-4 w-full rounded-md bg-background px-3 py-2 text-sm outline-none ring-1 ring-border focus:ring-primary"
          />
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
              取消
            </button>
            <button
              type="submit"
              disabled={!name.trim() || submitting}
              className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              收藏
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
