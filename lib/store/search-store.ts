/**
 * 搜索状态（zustand）
 *
 * 状态放在组件外部 store：离开搜索页再回来时不会丢失数据，输入框/源/结果都保留。
 * - run(keyword, source)：歌曲搜索，过期请求会被丢弃（reqId 自增）
 * - runAlbum(keyword, source)：专辑搜索（mode=album 时使用，音源仅 wy/kw/mg/all）
 * - setKeyword / setSource / setMode：仅更新输入态，不触发请求
 * - reset：清空（注销或切换用户时调用）
 *
 * 参考实现：lib/store/discover-store.ts
 */

import { create } from 'zustand'
import { search } from '@/lib/api/search'
import { searchAlbums } from '@/lib/api/album'
import type { AlbumSource, AlbumSummary } from '@/lib/api/album'
import type { Song, SourceType } from '@/lib/types/music'

/** 搜索结果类型：歌曲 | 专辑 */
export type SearchMode = 'song' | 'album'

/** 专辑搜索可用音源（一期 wy/kw/mg） */
const ALBUM_SOURCE_VALUES: AlbumSource[] = ['wy', 'kw', 'mg']

export function isAlbumSearchSource(s: SourceType | 'all' | 'local'): s is AlbumSource | 'all' {
  return s === 'all' || ALBUM_SOURCE_VALUES.includes(s as AlbumSource)
}

interface SearchStore {
  /** 当前输入框文本 */
  keyword: string
  /** 当前选择的音源 */
  source: SourceType | 'all' | 'local'
  /** 结果类型：歌曲 | 专辑 */
  mode: SearchMode
  /** 最近一次成功搜索使用的关键词（用于区分"未搜索"与"搜索无结果"） */
  lastKeyword: string
  /** 最近一次搜索使用的音源 */
  lastSource: SourceType | 'all' | 'local'
  /** 歌曲搜索结果 */
  results: Song[]
  /** 平台搜索附带的本地音乐库匹配（顶部"本地匹配"区；source=local 时为空） */
  localList: Song[]
  /** 专辑搜索结果（mode=album） */
  albums: AlbumSummary[]
  /** 专辑搜索失败的源（all 模式下部分源失败时提示） */
  albumFailedSources: AlbumSource[]
  loading: boolean
  error: string | null
  /** 请求序号，自增用于丢弃过期请求 */
  reqId: number

  setKeyword: (kw: string) => void
  setSource: (s: SourceType | 'all' | 'local') => void
  setMode: (m: SearchMode) => void
  run: (kw: string, source: SourceType | 'all' | 'local') => Promise<void>
  runAlbum: (kw: string, source: AlbumSource | 'all') => Promise<void>
  reset: () => void
}

/** fetch/JSON 解析等网络层报错对用户无意义，归一为友好文案；后端业务错误（中文 message）透出 */
function toFriendlyError(e: unknown): string {
  const raw = e instanceof Error ? e.message : ''
  return !raw || /Failed to execute|Network Error|fetch|JSON|ECONN/i.test(raw)
    ? '网络异常或服务不可用，请稍后重试'
    : raw
}

export const useSearchStore = create<SearchStore>((set, get) => ({
  keyword: '',
  source: 'all',
  mode: 'song',
  lastKeyword: '',
  lastSource: 'all',
  results: [],
  localList: [],
  albums: [],
  albumFailedSources: [],
  loading: false,
  error: null,
  reqId: 0,

  setKeyword: kw => set({ keyword: kw }),

  setSource: s => set({ source: s }),

  setMode: m => set({ mode: m }),

  run: async (kw, source) => {
    const trimmed = kw.trim()
    if (!trimmed) {
      set({ results: [], localList: [], loading: false, error: null, lastKeyword: '', lastSource: source })
      return
    }
    const reqId = get().reqId + 1
    set({ loading: true, error: null, reqId })

    try {
      // 单次请求：source=all 由服务端五源汇聚（顺序拼接 + 失败源跳过 + 整体缓存）
      const r = await search(source, trimmed, 1, 30)
      // 过期请求丢弃
      if (reqId !== get().reqId) return
      set({
        results: r.list,
        localList: r.localList || [],
        loading: false,
        error: null,
        lastKeyword: trimmed,
        lastSource: source,
      })
    } catch (e) {
      if (reqId !== get().reqId) return
      // 全部源失败（all）或单源失败：不能伪装成"未找到结果"，用户需要知道是服务/网络问题
      set({
        results: [],
        localList: [],
        loading: false,
        error: toFriendlyError(e),
        lastKeyword: trimmed,
        lastSource: source,
      })
    }
  },

  runAlbum: async (kw, source) => {
    const trimmed = kw.trim()
    if (!trimmed) {
      set({ albums: [], albumFailedSources: [], loading: false, error: null, lastKeyword: '', lastSource: source })
      return
    }
    const reqId = get().reqId + 1
    set({ loading: true, error: null, reqId })

    try {
      const r = await searchAlbums(source, trimmed, 1, 30)
      if (reqId !== get().reqId) return
      set({
        albums: r.list,
        albumFailedSources: r.failedSources || [],
        loading: false,
        error: null,
        lastKeyword: trimmed,
        lastSource: source,
      })
    } catch (e) {
      if (reqId !== get().reqId) return
      set({
        albums: [],
        albumFailedSources: [],
        loading: false,
        error: toFriendlyError(e),
        lastKeyword: trimmed,
        lastSource: source,
      })
    }
  },

  reset: () =>
    set({
      keyword: '',
      source: 'all',
      mode: 'song',
      lastKeyword: '',
      lastSource: 'all',
      results: [],
      localList: [],
      albums: [],
      albumFailedSources: [],
      loading: false,
      error: null,
      reqId: 0,
    }),
}))
