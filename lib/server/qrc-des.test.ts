/**
 * 私有 3DES 的已知答案与边界测试。
 *
 * 两组向量是从两份真机 QQ 云端载荷各取**首 8 字节**密文算的（整份载荷在 gitignored 的
 * D:/tmp，不入库）：正确的明文必然是 zlib 流，头两字节恒为 `78 9c`，所以"首块解出 789c…"
 * 就是表序与密钥顺序整体成立的硬证 —— 三家公开参考的固定三重 DES 在这两份载荷上解不出
 * 这个魔数（实测 55 份 × 660 组合零命中），本实现 55/55 命中。
 */
import { describe, expect, it } from 'vitest'
import { qrcDecryptHex } from './qrc-des'

const hexOf = (value: Uint8Array): string => Buffer.from(value).toString('hex')

describe('qrcDecryptHex', () => {
  it('真机载荷首块解出 zlib 魔数', () => {
    expect(hexOf(qrcDecryptHex('F7F1AF5DF5BD6179'))).toBe('789c4d5a4b8f9cd5')
    expect(hexOf(qrcDecryptHex('6523D74F97F58193'))).toBe('789c013d00c2ff5b')
  })

  it('大写、空白混进来都照收（上游有时带换行）', () => {
    expect(hexOf(qrcDecryptHex(' f7f1af5df5bd6179 \n'))).toBe('789c4d5a4b8f9cd5')
  })

  it('非十六进制与不足一块的输入返回空字节，不抛', () => {
    expect(qrcDecryptHex('不是十六进制ZZ')).toEqual(new Uint8Array(0))
    expect(qrcDecryptHex('')).toEqual(new Uint8Array(0))
    expect(qrcDecryptHex('F7F1AF5DF5BD61')).toEqual(new Uint8Array(0)) // 7 字节 < 一块
  })

  it('尾部不足 8 字节的残块整块丢掉（与参考实现一致，QQ 载荷本就按块对齐）', () => {
    const firstBlock = hexOf(qrcDecryptHex('F7F1AF5DF5BD6179'))
    expect(hexOf(qrcDecryptHex('F7F1AF5DF5BD6179AABBCCDD'))).toBe(firstBlock) // 12 字节 → 只出前 8
    expect(hexOf(qrcDecryptHex('F7F1AF5DF5BD6179AA'))).toBe(firstBlock)        // 9 字节 → 余 1 字节丢弃
  })
})
