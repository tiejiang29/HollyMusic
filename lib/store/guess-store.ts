/**
 * 猜你喜欢状态（zustand）
 *
 * 与 discover-store 同思路：状态放组件外部，离开首页再回来不丢数据、不重复请求。
 * 区别于随机推荐的 TTL 缓存：榜单本身按天稳定（服务端种子 = 用户名+日期），
 * 「换一批」走 page 翻页，翻到末页后回到第 1 页。
 */

import { create } from 'zustand'
import { getGuessYouLike } from '@/lib/api/guess'
import type { GuessSong } from '@/lib/api/guess'

/** 每页展示数，与服务端分页切片一致 */
const PAGE_SIZE = 12
/** 服务端 page 上限为 10，保持一致 */
const MAX_PAGE = 10

interface GuessStore {
  songs: GuessSong[]
  page: number
  /** false = 冷启动随机兜底（前端据此换文案） */
  personalized: boolean
  loading: boolean
  /** 拉取失败（含未登录 401）：首页据此隐藏整个区块 */
  failed: boolean

  fetch: (page?: number) => Promise<void>
  /** 「换一批」：下一页，翻完回头一页 */
  next: () => Promise<void>
  /** 首次挂载调用：已有数据则跳过 */
  ensure: () => void
}

export const useGuessStore = create<GuessStore>((set, get) => ({
  songs: [],
  page: 1,
  personalized: false,
  loading: false,
  failed: false,

  fetch: async (page = 1) => {
    if (get().loading) return
    set({ loading: true, failed: false })
    try {
      const data = await getGuessYouLike(PAGE_SIZE, page)
      // 翻到空页说明榜单已翻完，回到第 1 页
      if (data.list.length === 0 && page > 1) {
        set({ loading: false })
        return get().fetch(1)
      }
      set({ songs: data.list, page: data.page, personalized: data.personalized, loading: false })
    } catch {
      set({ loading: false, failed: true })
    }
  },

  next: async () => {
    const nextPage = get().page >= MAX_PAGE ? 1 : get().page + 1
    await get().fetch(nextPage)
  },

  ensure: () => {
    if (get().songs.length === 0 && !get().loading) {
      void get().fetch(1)
    }
  },
}))
