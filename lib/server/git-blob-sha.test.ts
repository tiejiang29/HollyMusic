/**
 * blob sha 的对照值来自命令 `git hash-object`（2026-10-05 现算），不是本文件的实现自己算出来的 ——
 * 拿同一段代码算两遍再断言相等，证明不了任何事。
 */
import { describe, expect, it } from 'vitest'
import { gitBlobSha } from './git-blob-sha'

describe('gitBlobSha', () => {
  it('与 `git hash-object` 的权威值对上（不是自己算完自证）', () => {
    // 对照值来自 git hash-object（内容就是 "hello git\n"）
    expect(gitBlobSha('hello git\n')).toBe('8d0e41234f24b6da002d962a26c2495ea16a425f')
  })

  it('长度按 UTF-8 字节算，不是字符数（脚本正文里有中文，头里的长度差一位就对不上）', () => {
    // 对照值同样来自 git hash-object，内容是 "音源\n"（3+3+1 字节）
    expect(gitBlobSha('音源\n')).toBe('33856ca451c2139b420b793f38a0227ef64596a8')
  })
})
