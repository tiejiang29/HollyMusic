import { describe, it, expect } from 'vitest'

// tx-sign.js 是 CommonJS（音乐源子进程里只能 require），这里走打包器的 CJS 互操作
import { ENDPOINT, SUB_KEY, zzcSign, txSearchId, txSearchRequest, pickTxSongs } from '@/lib/music-core/tx-sign'
const txSign = { ENDPOINT, SUB_KEY, zzcSign, txSearchId, txSearchRequest, pickTxSongs } as {
  ENDPOINT: string
  SUB_KEY: string
  zzcSign: (t: string) => string
  txSearchId: () => string
  txSearchRequest: (q: string, page?: number, limit?: number) => { url: string; text: string }
  pickTxSongs: (j: unknown) => { code: number | undefined; items: unknown[]; sum: number }
}

describe('zzcSign', () => {
  // 黄金值来自对上游实现（lx-music-desktop tx/utils/crypto.js，Apache-2.0）的一份独立转写，
  // 常量表或取位顺序被改动时这几条会先失配——签名错在上游只是"不给结果"，很难从报错看出来
  it.each([
    ['{}', 'zzcf8e26805gyafigxmxjehoe02mvsjjgtwzw6f1a05f9'],
    ['{"a":1}', 'zzc7746109xq501htmv4ipz7c8owlxfpihjm1fd695c7'],
    ['稻香', 'zzcb3eb1ddjefleslmmihstsabpx70fqyzy14cad328'],
    ['{"query":"红玫瑰"}', 'zzcbaaf74ekii2mhswzltgcrqgxskamhrhog7b9fe2c5'],
  ])('固定输入 %s 出固定签名', (input, expected) => {
    expect(txSign.zzcSign(input)).toBe(expected)
  })

  it('形状：zzc 前缀、全小写、不含 + / = 这些要进 URL 查询串的字符', () => {
    const sign = txSign.zzcSign('anything')
    expect(sign.startsWith('zzc')).toBe(true)
    expect(sign).toBe(sign.toLowerCase())
    expect(sign).toMatch(/^zzc[a-z0-9]+$/)
  })

  it('一个字不同签名就不同（它锁的是载荷字节，不是关键词）', () => {
    expect(txSign.zzcSign('{"query":"稻香"}')).not.toBe(txSign.zzcSign('{"query":"稻香 "}'))
  })
})

describe('txSearchId', () => {
  it('37 字符 = 32 位大写十六进制 + 5 位补零随机', () => {
    const id = txSign.txSearchId()
    expect(id).toHaveLength(37)
    expect(id).toMatch(/^[0-9A-F]{32}\d{5}$/)
  })

  it('两次调用不重复（服务端把它当会话号）', () => {
    expect(txSign.txSearchId()).not.toBe(txSign.txSearchId())
  })
})

describe('txSearchRequest', () => {
  it('走 musics.fcg 而不是 musicu.fcg（老域名带签名也不给结果）', () => {
    const { url } = txSign.txSearchRequest('稻香', 1, 20)
    expect(url).toContain('https://u.y.qq.com/cgi-bin/musics.fcg?sign=zzc')
    expect(url).not.toContain('musicu')
  })

  it('签名与要发出去的那串字节严格一致', () => {
    const { url, text } = txSign.txSearchRequest('稻香', 1, 20)
    expect(txSign.zzcSign(text)).toBe(new URL(url).searchParams.get('sign'))
  })

  it('body 里参数落位，且 PC 那套 comm 身份齐全（ct=19 一族字段名带下划线）', () => {
    const { text } = txSign.txSearchRequest('红玫瑰', 3, 15)
    const data = JSON.parse(text)
    const sub = data[txSign.SUB_KEY]
    expect(sub.method).toBe('DoSearchForQQMusicDesktop')
    expect(sub.param).toMatchObject({ query: '红玫瑰', page_num: 3, num_per_page: 15, search_type: 0, grp: 1 })
    expect(data.comm.ct).toBe('19')
    expect(data.comm.tmeAppID).toBe('qqmusic')
    // 这些空位是身份的一部分，删掉会让上游认错客户端
    expect(data.comm).toHaveProperty('psrf_qqaccess_token', '')
    expect(data.comm).toHaveProperty('wid')
  })
})

describe('pickTxSongs', () => {
  it('新版结果在 song.list，分页总数取 meta.sum', () => {
    const r = txSign.pickTxSongs({
      [txSign.SUB_KEY]: { code: 0, data: { body: { song: { list: [{ mid: 'A' }, { mid: 'B' }] } }, meta: { sum: 1009 } } },
    })
    expect(r.code).toBe(0)
    expect(r.items).toHaveLength(2)
    expect(r.sum).toBe(1009)
  })

  it('老的 item_song 形状与 req 子包键也认（别把换接口变成只能读一种）', () => {
    const r = txSign.pickTxSongs({ req: { code: 0, data: { body: { item_song: [{ mid: 'A' }] }, meta: {} } } })
    expect(r.items).toHaveLength(1)
    expect(r.sum).toBe(0)
  })

  it('上游拒绝时把 code 原样交出去，别让调用方只能猜', () => {
    expect(txSign.pickTxSongs({ [txSign.SUB_KEY]: { code: 2001, data: {} } }).code).toBe(2001)
    expect(txSign.pickTxSongs({}).code).toBeUndefined()
    expect(txSign.pickTxSongs(null).items).toEqual([])
  })

  it('列表不是数组时收成空表而不是抛错', () => {
    const r = txSign.pickTxSongs({ [txSign.SUB_KEY]: { code: 0, data: { body: { song: { list: null } } } } })
    expect(r.items).toEqual([])
  })
})
