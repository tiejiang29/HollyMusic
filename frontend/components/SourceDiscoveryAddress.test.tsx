/**
 * 「候选地址」这一格的测试（A 期：让发现出来的东西真能被拿去用）
 *
 * 两件事值得钉住，因为它们都不是"渲染出来就行"：
 * 1. 地址必须**以可选中的文本形式在 DOM 里** —— 面板在生产是明文 HTTP，浏览器不给剪贴板，
 *    这时候"能选中复制"是唯一可行的路径；
 * 2. 剪贴板的三种情况（没有 API / 写了 / 被拒）都要落到明确结果，按钮不能按了没反应。
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const { AddressCell } = await import('@/components/admin/SourceDiscoveryPanel')
const { copyAddress } = await import('@/lib/utils/clipboard')

const URL = 'https://raw.githubusercontent.com/pdone/lx-music-source/changqing/latest.js'

describe('AddressCell', () => {
  it('地址是可读可选中的文本，不只在 title 属性里', () => {
    const html = renderToStaticMarkup(createElement(AddressCell, { rawUrl: URL, copied: false, onCopy: () => {} }))
    expect(html).toContain(URL)
    expect(html).toContain('复制')
  })

  it('复制成功后标签变成「已复制」，让管理员知道不用再手动选', () => {
    const html = renderToStaticMarkup(createElement(AddressCell, { rawUrl: URL, copied: true, onCopy: () => {} }))
    expect(html).toContain('已复制')
  })
})

describe('copyAddress', () => {
  it('非 HTTPS 环境下 navigator.clipboard 不存在 ⇒ 返回 manual，而不是抛错', async () => {
    await expect(copyAddress(URL, undefined)).resolves.toBe('manual')
    await expect(copyAddress(URL, {})).resolves.toBe('manual')
  })

  it('能写就写，并且写的就是那条地址', async () => {
    const writeText = vi.fn(async () => {})
    await expect(copyAddress(URL, { writeText })).resolves.toBe('copied')
    expect(writeText).toHaveBeenCalledWith(URL)
  })

  it('用户拒授权（writeText reject）也走 manual，不能把异常冒到按钮上', async () => {
    const writeText = vi.fn(async () => { throw new Error('NotAllowedError') })
    await expect(copyAddress(URL, { writeText })).resolves.toBe('manual')
  })
})
