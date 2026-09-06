import { useEffect, useRef, useState } from 'react'
import { useSearch } from '@/hooks/useSearch'
import { SongList } from '@/components/shared/SongList'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { Search, Music, X, CloudOff, ChevronDown, User, Disc3 } from 'lucide-react'
import { toTrack } from '@/lib/types/player'
import type { SourceType } from '@/lib/types/music'
import { apiGet } from '@/lib/api/client'

interface SuggestItem {
  text: string
  type: 'song' | 'singer' | 'album'
}

const SOURCES: { value: SourceType | 'all' | 'local'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'tx', label: 'QQ' },
  { value: 'wy', label: '网易' },
  { value: 'kw', label: '酷我' },
  { value: 'kg', label: '酷狗' },
  { value: 'mg', label: '咪咕' },
  { value: 'local', label: '本地' },
]

export function SearchPage() {
  // keyword/source/results/loading 全部来自 search-store（外部状态）：
  // 离开搜索页再回来时输入框与结果都保留。
  const { results, localList, loading, error, keyword, lastKeyword, source, setKeyword, setSource, run } = useSearch()
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    run(keyword, source)
  }

  // 与 lx-music 搜索页一致：已有搜索词时切换源自动重搜，否则仅切换选中态
  const handleSourceChange = (next: SourceType | 'all' | 'local') => {
    setSource(next)
    if (keyword.trim()) run(keyword, next)
  }

  const clearKeyword = () => {
    setKeyword('')
    inputRef.current?.focus()
  }

  // ---------- 搜索联想 ----------
  // 输入防抖 250ms 请求 /api/search/suggest（网易 + 本地音乐库，服务端 1.2s 截断）；
  // 点击/回车联想项 → 回填关键词并立即搜索；↑↓ 导航、Esc 关闭、失焦延迟关闭（让点击先落地）
  const [suggestions, setSuggestions] = useState<SuggestItem[]>([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const suggestReqId = useRef(0)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 已应用的联想词：对其本身不再触发新一轮联想（避免回填后下拉重开） */
  const appliedSuggest = useRef<string | null>(null)

  useEffect(() => {
    const kw = keyword.trim()
    if (!kw) {
      setSuggestions([])
      setSuggestOpen(false)
      appliedSuggest.current = null
      return
    }
    if (appliedSuggest.current === kw) return
    if (appliedSuggest.current !== null) appliedSuggest.current = null
    const timer = setTimeout(() => {
      const reqId = ++suggestReqId.current
      apiGet<SuggestItem[]>(`search/suggest?keyword=${encodeURIComponent(kw)}`)
        .then(items => {
          if (reqId !== suggestReqId.current) return
          setSuggestions(items)
          setSuggestOpen(items.length > 0)
          setActiveIndex(-1)
        })
        .catch(() => {})
    }, 250)
    return () => clearTimeout(timer)
  }, [keyword])

  const closeSuggest = () => {
    setSuggestOpen(false)
    setActiveIndex(-1)
  }

  const applySuggestion = (text: string) => {
    appliedSuggest.current = text
    setKeyword(text)
    closeSuggest()
    run(text, source)
  }

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!suggestOpen || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => (i + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => (i <= 0 ? suggestions.length - 1 : i - 1))
    } else if (e.key === 'Escape') {
      closeSuggest()
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      applySuggestion(suggestions[activeIndex].text)
    }
  }

  const onInputBlur = () => {
    // 延迟关闭，确保下拉项的 click 先于 blur 收尾
    blurTimer.current = setTimeout(closeSuggest, 150)
  }
  const onInputFocus = () => {
    if (blurTimer.current) clearTimeout(blurTimer.current)
    if (suggestions.length > 0) setSuggestOpen(true)
  }

  const tracks = results.map(s => toTrack({ uid: s.uid, musicInfo: s }))

  // ---------- 客户端增量分页 ----------
  // "全部"源一次拼接 5 平台 ~150+ 行，一次性挂载的大组件树在（真实点击导航
  // 场景下）会触发数秒级提交延迟；30 行/批增量渲染把挂载树控制在安全量级，
  // 移动端长列表体验也更优。播放队列仍传完整列表。
  const PAGE_SIZE = 30
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [results])
  const visibleTracks = tracks.slice(0, visibleCount)
  const remaining = tracks.length - visibleTracks.length

  return (
    <div className="p-6">
      {/* 小屏下 MobileHeader 已显示页面标题，页内大标题仅桌面保留 */}
      <h1 className="mb-4 hidden text-2xl font-bold md:block">搜索</h1>
      <form onSubmit={submit} className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={onInputKeyDown}
            onBlur={onInputBlur}
            onFocus={onInputFocus}
            placeholder="搜索歌曲、歌手..."
            enterKeyHint="search"
            autoComplete="off"
            role="combobox"
            aria-expanded={suggestOpen}
            aria-autocomplete="list"
            className="w-full rounded-full bg-card py-2 pl-10 pr-9 text-sm outline-none ring-1 ring-border focus:ring-primary"
          />
          {keyword && (
            <button
              type="button"
              aria-label="清空搜索词"
              onClick={clearKeyword}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {suggestOpen && suggestions.length > 0 && (
            <ul
              role="listbox"
              aria-label="搜索联想"
              className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
            >
              {suggestions.map((s, i) => {
                const Icon = s.type === 'singer' ? User : s.type === 'album' ? Disc3 : Music
                const typeLabel = s.type === 'singer' ? '歌手' : s.type === 'album' ? '专辑' : '歌曲'
                return (
                  <li key={`${s.text}-${i}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === activeIndex}
                      onMouseEnter={() => setActiveIndex(i)}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => applySuggestion(s.text)}
                      className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                        i === activeIndex ? 'bg-accent text-foreground' : 'text-foreground/85 hover:bg-accent/60'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{s.text}</span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{typeLabel}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <button
          type="submit"
          className="shrink-0 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          搜索
        </button>
      </form>

      <div
        role="tablist"
        aria-label="音源"
        className="mb-6 flex gap-2 overflow-x-auto pb-1"
      >
        {SOURCES.map(s => (
          <button
            key={s.value}
            role="tab"
            aria-selected={source === s.value}
            onClick={() => handleSourceChange(s.value)}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm transition-colors ${
              source === s.value
                ? 'bg-primary text-primary-foreground'
                : 'bg-card text-muted-foreground ring-1 ring-border hover:text-foreground'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* 本地匹配区：非"本地"源搜索时，服务端附带的前几条音乐库命中置顶展示 */}
      {!loading && !error && source !== 'local' && localList.length > 0 && (
        <div className="mb-4">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">
            本地匹配 <span className="text-primary">（音乐库 {localList.length} 首，播放不耗流量）</span>
          </div>
          <SongList tracks={localList.map(s => toTrack({ uid: s.uid, musicInfo: s }))} />
        </div>
      )}

      {loading ? (
        <LoadingSkeleton />
      ) : error ? (
        <EmptyState icon={CloudOff} title="搜索服务不可用" description={error} />
      ) : visibleTracks.length > 0 ? (
        <>
          {source !== 'local' && visibleTracks.length > 0 && (
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">{source === 'all' ? '平台搜索结果' : `${SOURCES.find(s => s.value === source)?.label || ''}搜索结果`}</div>
          )}
          <SongList tracks={visibleTracks} />
          {remaining > 0 && (
            <button
              onClick={() => setVisibleCount(n => n + PAGE_SIZE)}
              className="mx-auto mt-4 flex items-center gap-1 rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <ChevronDown className="h-4 w-4" /> 加载更多（剩余 {remaining} 首）
            </button>
          )}
        </>
      ) : lastKeyword ? (
        // 用 lastKeyword（最近一次搜索的词）而非输入框实时文本：
        // 输入过程中/清空再输入时不应显示"未找到结果"
        <EmptyState icon={Search} title="未找到结果" description={`没有找到与“${lastKeyword}”相关的内容`} />
      ) : (
        <EmptyState icon={Music} title="开始搜索" description="输入歌曲名或歌手名开始探索" />
      )}
    </div>
  )
}
