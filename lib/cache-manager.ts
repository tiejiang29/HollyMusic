/**
 * 缓存管理器
 * 使用内存缓存，支持不同的过期时间
 *
 * 淘汰顺序是 **LRU**：get 命中与 set 都会把键挪到队尾，溢出时从队头（最久未用）删。
 * 早先是按插入序 FIFO，那会让"首页一直在看的那批封面"因为插入最早而最先被踢，
 * 反而留下只加载过一次的新图。
 */

import type { CacheEntry } from './types/music'

/** 默认条目上限（防匿名/半公开接口无限制造缓存键打满内存） */
const DEFAULT_MAX_ENTRIES = 2000

export interface CacheManagerOptions<T> {
  /** 条目上限，默认 2000 */
  maxEntries?: number
  /** 总字节上限；需配合 sizeOf。不配则只按条数淘汰 */
  maxBytes?: number
  /** 估算单条目占用字节数；不配则不计字节 */
  sizeOf?: (data: T) => number
}

export class CacheManager<T = unknown> {
  private cache: Map<string, CacheEntry<T>>
  private hits: number = 0
  private misses: number = 0
  private readonly maxEntries: number
  private readonly maxBytes?: number
  private readonly sizeOf?: (data: T) => number
  /** 当前累计字节；只有配了 sizeOf 才有意义 */
  private bytes = 0

  constructor(opts: CacheManagerOptions<T> = {}) {
    this.cache = new Map()
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxBytes = opts.maxBytes
    this.sizeOf = opts.sizeOf
    // 每5分钟清理一次过期缓存
    setInterval(() => this.cleanExpired(), 5 * 60 * 1000)
  }

  /**
   * 获取缓存
   */
  get(key: string): T | null {
    const entry = this.cache.get(key)
    
    if (!entry) {
      this.misses++
      return null
    }

    // 检查是否过期
    if (Date.now() > entry.expireAt) {
      this.remove(key)
      this.misses++
      return null
    }

    // LRU：命中就把它挪到队尾，淘汰时最后才轮到它
    this.cache.delete(key)
    this.cache.set(key, entry)
    this.hits++
    return entry.data
  }

  /**
   * 设置缓存
   * @param key 缓存键
   * @param data 缓存数据
   * @param ttl 过期时间（毫秒）
   */
  set(key: string, data: T, ttl: number): void {
    const size = this.sizeOf?.(data) ?? 0
    // 单条目就超预算的存下去也会立刻把自己挤出去，等于白占一次上游请求——直接不缓存
    if (this.maxBytes !== undefined && size > this.maxBytes) return

    const prev = this.cache.get(key)
    if (prev) this.bytes -= this.sizeOf?.(prev.data) ?? 0
    this.cache.delete(key)
    this.cache.set(key, { data, expireAt: Date.now() + ttl })
    this.bytes += size

    this.trim()
  }

  /**
   * 删除缓存
   */
  delete(key: string): boolean {
    return this.remove(key)
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.cache.clear()
    this.bytes = 0
    this.hits = 0
    this.misses = 0
  }

  /**
   * 清理过期缓存
   */
  private cleanExpired(): void {
    const now = Date.now()
    let cleaned = 0

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expireAt) {
        this.remove(key)
        cleaned++
      }
    }

    if (cleaned > 0) {
      console.log(`[Cache] 清理了 ${cleaned} 个过期缓存项`)
    }
  }

  /** 从队头（最久未用）淘汰，直到条数与字节都达标 */
  private trim(): void {
    while (this.cache.size > this.maxEntries) this.evictHead()
    if (this.maxBytes !== undefined) {
      while (this.bytes > this.maxBytes && this.cache.size > 0) this.evictHead()
    }
  }

  private evictHead(): void {
    const first = this.cache.keys().next()
    if (first.done) return
    this.remove(first.value)
  }

  private remove(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false
    this.bytes -= this.sizeOf?.(entry.data) ?? 0
    return this.cache.delete(key)
  }

  /**
   * 获取缓存统计信息
   */
  getStats() {
    const total = this.hits + this.misses
    const hitRate = total > 0 ? (this.hits / total * 100).toFixed(2) : '0.00'

    return {
      size: this.cache.size,
      bytes: Math.max(0, Math.round(this.bytes)),
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes ?? null,
      hits: this.hits,
      misses: this.misses,
      hitRate: `${hitRate}%`,
    }
  }
}

/** 图片代理缓存的条目形状 */
export interface ImageCacheEntry {
  bytes: Uint8Array<ArrayBuffer>
  contentType: string
}

// 创建不同类型的缓存实例
export const searchCache = new CacheManager()
export const urlCache = new CacheManager()
/** 歌词取词结果：一次播放会有底栏/全屏页/播放记录多个入口同要一首，没有它就重复打上游 */
export const lyricCache = new CacheManager()
/**
 * 封面/图片字节缓存。
 * 单张中位 64KB、均值约 121KB（2026-10-02 实测 228 张），所以这里按"条数 + 总字节"双上限：
 * 500 条、24MB，且单张 >1MB 的（实测仅 1.3%，却主导字节数）直接不缓存、只透传。
 * 不复用 searchCache：图片条目大，和搜索结果抢同一个 2000 额度会互相把对方挤光。
 */
export const imageCache = new CacheManager<ImageCacheEntry>({
  maxEntries: 500,
  maxBytes: 24 * 1024 * 1024,
  sizeOf: v => v.bytes.byteLength,
})
