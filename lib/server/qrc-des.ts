/**
 * QQ 云端 QRC 歌词的解密原语。
 *
 * 这不是标准 DES：S 盒的索引位序被重排、IP/FP/PC/E/P 用位运算展开且字节序被打乱、
 * key schedule 轮移位后掐掉低 4 位。**用任何标准 DES/3DES 库都解不出 QRC**
 * （我们踩过这个坑：密钥是公开的 `!@#)(*$%123ZXC!@!@#)(NHL`，顺序也对，
 * 但 55 份真载荷在标准 3DES 下零命中，见 my/qrc-private-des-try.cjs 的实测）。
 *
 * 算法逐字移植自 songloft-org/songloft-plugin-karaoke-lyric 的 src/crypto/qrc_des.ts
 * （其注释自称 faithful 移植自 music-lib/lyrics/qrc_des.go），该项目为 Apache-2.0。
 *
 * 用法：`zlib.inflateSync(qrcDecryptHex(hex))` → UTF-8 文本，外面还包着一层
 * `<QrcInfos><Lyric_1 LyricContent="…">`，取 LyricContent 并做实体反转义才是歌词。
 */

/** S 盒内容与 FIPS 46-3 相同，但每盒 64 格按 QQ 的位序线性排布，配 sBoxBit 使用 */
const QRC_SBOX: number[][] = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
]

const ENCRYPT = 1
const DECRYPT = 0

/** 三段密钥的原料（24 字节）：[16:] 解、[8:] 加、[0:] 解 */
const QRC_KEY = Uint8Array.from('!@#)(*$%123ZXC!@!@#)(NHL', c => c.charCodeAt(0))

/** 取字节数组第 b 位（QQ 侧的字节序是从每 4 字节的尾部往前数），结果左移 c 位 */
function bitNum(a: Uint8Array, b: number, c: number): number {
  const idx = ((b / 32) | 0) * 4 + 3 - (((b % 32) / 8) | 0)
  return ((((a[idx] >>> (7 - (b % 8))) & 1) << c) >>> 0)
}

function bitNumIntr(a: number, b: number, c: number): number {
  return ((((a >>> (31 - b)) & 1) << c) >>> 0)
}

function bitNumIntl(a: number, b: number, c: number): number {
  return (((((a << b) >>> 0) & 0x80000000) >>> c) >>> 0)
}

/** 把 6 位输入重排成 S 盒的 0~63 索引（行/列的位序就是被打乱的地方） */
function sBoxBit(a: number): number {
  return ((a & 32) | ((a & 31) >> 1) | ((a & 1) << 4)) & 0xff
}

function initialPermutation(input: Uint8Array): [number, number] {
  const s0 = (
    bitNum(input, 57, 31) | bitNum(input, 49, 30) | bitNum(input, 41, 29) | bitNum(input, 33, 28) |
    bitNum(input, 25, 27) | bitNum(input, 17, 26) | bitNum(input, 9, 25) | bitNum(input, 1, 24) |
    bitNum(input, 59, 23) | bitNum(input, 51, 22) | bitNum(input, 43, 21) | bitNum(input, 35, 20) |
    bitNum(input, 27, 19) | bitNum(input, 19, 18) | bitNum(input, 11, 17) | bitNum(input, 3, 16) |
    bitNum(input, 61, 15) | bitNum(input, 53, 14) | bitNum(input, 45, 13) | bitNum(input, 37, 12) |
    bitNum(input, 29, 11) | bitNum(input, 21, 10) | bitNum(input, 13, 9) | bitNum(input, 5, 8) |
    bitNum(input, 63, 7) | bitNum(input, 55, 6) | bitNum(input, 47, 5) | bitNum(input, 39, 4) |
    bitNum(input, 31, 3) | bitNum(input, 23, 2) | bitNum(input, 15, 1) | bitNum(input, 7, 0)) >>> 0
  const s1 = (
    bitNum(input, 56, 31) | bitNum(input, 48, 30) | bitNum(input, 40, 29) | bitNum(input, 32, 28) |
    bitNum(input, 24, 27) | bitNum(input, 16, 26) | bitNum(input, 8, 25) | bitNum(input, 0, 24) |
    bitNum(input, 58, 23) | bitNum(input, 50, 22) | bitNum(input, 42, 21) | bitNum(input, 34, 20) |
    bitNum(input, 26, 19) | bitNum(input, 18, 18) | bitNum(input, 10, 17) | bitNum(input, 2, 16) |
    bitNum(input, 60, 15) | bitNum(input, 52, 14) | bitNum(input, 44, 13) | bitNum(input, 36, 12) |
    bitNum(input, 28, 11) | bitNum(input, 20, 10) | bitNum(input, 12, 9) | bitNum(input, 4, 8) |
    bitNum(input, 62, 7) | bitNum(input, 54, 6) | bitNum(input, 46, 5) | bitNum(input, 38, 4) |
    bitNum(input, 30, 3) | bitNum(input, 22, 2) | bitNum(input, 14, 1) | bitNum(input, 6, 0)) >>> 0
  return [s0, s1]
}

function inversePermutation(s0: number, s1: number): Uint8Array {
  const data = new Uint8Array(8)
  data[3] = (bitNumIntr(s1, 7, 7) | bitNumIntr(s0, 7, 6) | bitNumIntr(s1, 15, 5) | bitNumIntr(s0, 15, 4) | bitNumIntr(s1, 23, 3) | bitNumIntr(s0, 23, 2) | bitNumIntr(s1, 31, 1) | bitNumIntr(s0, 31, 0)) & 0xff
  data[2] = (bitNumIntr(s1, 6, 7) | bitNumIntr(s0, 6, 6) | bitNumIntr(s1, 14, 5) | bitNumIntr(s0, 14, 4) | bitNumIntr(s1, 22, 3) | bitNumIntr(s0, 22, 2) | bitNumIntr(s1, 30, 1) | bitNumIntr(s0, 30, 0)) & 0xff
  data[1] = (bitNumIntr(s1, 5, 7) | bitNumIntr(s0, 5, 6) | bitNumIntr(s1, 13, 5) | bitNumIntr(s0, 13, 4) | bitNumIntr(s1, 21, 3) | bitNumIntr(s0, 21, 2) | bitNumIntr(s1, 29, 1) | bitNumIntr(s0, 29, 0)) & 0xff
  data[0] = (bitNumIntr(s1, 4, 7) | bitNumIntr(s0, 4, 6) | bitNumIntr(s1, 12, 5) | bitNumIntr(s0, 12, 4) | bitNumIntr(s1, 20, 3) | bitNumIntr(s0, 20, 2) | bitNumIntr(s1, 28, 1) | bitNumIntr(s0, 28, 0)) & 0xff
  data[7] = (bitNumIntr(s1, 3, 7) | bitNumIntr(s0, 3, 6) | bitNumIntr(s1, 11, 5) | bitNumIntr(s0, 11, 4) | bitNumIntr(s1, 19, 3) | bitNumIntr(s0, 19, 2) | bitNumIntr(s1, 27, 1) | bitNumIntr(s0, 27, 0)) & 0xff
  data[6] = (bitNumIntr(s1, 2, 7) | bitNumIntr(s0, 2, 6) | bitNumIntr(s1, 10, 5) | bitNumIntr(s0, 10, 4) | bitNumIntr(s1, 18, 3) | bitNumIntr(s0, 18, 2) | bitNumIntr(s1, 26, 1) | bitNumIntr(s0, 26, 0)) & 0xff
  data[5] = (bitNumIntr(s1, 1, 7) | bitNumIntr(s0, 1, 6) | bitNumIntr(s1, 9, 5) | bitNumIntr(s0, 9, 4) | bitNumIntr(s1, 17, 3) | bitNumIntr(s0, 17, 2) | bitNumIntr(s1, 25, 1) | bitNumIntr(s0, 25, 0)) & 0xff
  data[4] = (bitNumIntr(s1, 0, 7) | bitNumIntr(s0, 0, 6) | bitNumIntr(s1, 8, 5) | bitNumIntr(s0, 8, 4) | bitNumIntr(s1, 16, 3) | bitNumIntr(s0, 16, 2) | bitNumIntr(s1, 24, 1) | bitNumIntr(s0, 24, 0)) & 0xff
  return data
}

function feistelF(state: number, key: Uint8Array): number {
  const t1 = (
    bitNumIntl(state, 31, 0) | ((state & 0xf0000000) >>> 1) | bitNumIntl(state, 4, 5) |
    bitNumIntl(state, 3, 6) | ((state & 0x0f000000) >>> 3) | bitNumIntl(state, 8, 11) |
    bitNumIntl(state, 7, 12) | ((state & 0x00f00000) >>> 5) | bitNumIntl(state, 12, 17) |
    bitNumIntl(state, 11, 18) | ((state & 0x000f0000) >>> 7) | bitNumIntl(state, 16, 23)) >>> 0
  const t2 = (
    bitNumIntl(state, 15, 0) | (((state & 0x0000f000) << 15) >>> 0) | bitNumIntl(state, 20, 5) |
    bitNumIntl(state, 19, 6) | (((state & 0x00000f00) << 13) >>> 0) | bitNumIntl(state, 24, 11) |
    bitNumIntl(state, 23, 12) | (((state & 0x000000f0) << 11) >>> 0) | bitNumIntl(state, 28, 17) |
    bitNumIntl(state, 27, 18) | (((state & 0x0000000f) << 9) >>> 0) | bitNumIntl(state, 0, 23)) >>> 0

  const lrg = new Uint8Array(6)
  lrg[0] = (t1 >>> 24) & 0xff
  lrg[1] = (t1 >>> 16) & 0xff
  lrg[2] = (t1 >>> 8) & 0xff
  lrg[3] = (t2 >>> 24) & 0xff
  lrg[4] = (t2 >>> 16) & 0xff
  lrg[5] = (t2 >>> 8) & 0xff
  for (let i = 0; i < 6; i++) lrg[i] ^= key[i]

  const s = (((QRC_SBOX[0][sBoxBit(lrg[0] >> 2)] << 28) >>> 0) |
    ((QRC_SBOX[1][sBoxBit((((lrg[0] & 0x03) << 4) | (lrg[1] >> 4)) & 0xff)] << 24) >>> 0) |
    ((QRC_SBOX[2][sBoxBit((((lrg[1] & 0x0f) << 2) | (lrg[2] >> 6)) & 0xff)] << 20) >>> 0) |
    ((QRC_SBOX[3][sBoxBit(lrg[2] & 0x3f)] << 16) >>> 0) |
    ((QRC_SBOX[4][sBoxBit(lrg[3] >> 2)] << 12) >>> 0) |
    ((QRC_SBOX[5][sBoxBit((((lrg[3] & 0x03) << 4) | (lrg[4] >> 4)) & 0xff)] << 8) >>> 0) |
    ((QRC_SBOX[6][sBoxBit((((lrg[4] & 0x0f) << 2) | (lrg[5] >> 6)) & 0xff)] << 4) >>> 0) |
    (QRC_SBOX[7][sBoxBit(lrg[5] & 0x3f)])) >>> 0

  return (
    bitNumIntl(s, 15, 0) | bitNumIntl(s, 6, 1) | bitNumIntl(s, 19, 2) | bitNumIntl(s, 20, 3) |
    bitNumIntl(s, 28, 4) | bitNumIntl(s, 11, 5) | bitNumIntl(s, 27, 6) | bitNumIntl(s, 16, 7) |
    bitNumIntl(s, 0, 8) | bitNumIntl(s, 14, 9) | bitNumIntl(s, 22, 10) | bitNumIntl(s, 25, 11) |
    bitNumIntl(s, 4, 12) | bitNumIntl(s, 17, 13) | bitNumIntl(s, 30, 14) | bitNumIntl(s, 9, 15) |
    bitNumIntl(s, 1, 16) | bitNumIntl(s, 7, 17) | bitNumIntl(s, 23, 18) | bitNumIntl(s, 13, 19) |
    bitNumIntl(s, 31, 20) | bitNumIntl(s, 26, 21) | bitNumIntl(s, 2, 22) | bitNumIntl(s, 8, 23) |
    bitNumIntl(s, 18, 24) | bitNumIntl(s, 12, 25) | bitNumIntl(s, 29, 26) | bitNumIntl(s, 5, 27) |
    bitNumIntl(s, 21, 28) | bitNumIntl(s, 10, 29) | bitNumIntl(s, 3, 30) | bitNumIntl(s, 24, 31)) >>> 0
}

function desCrypt(input: Uint8Array, key: Uint8Array[]): Uint8Array {
  let [s0, s1] = initialPermutation(input)
  for (let i = 0; i < 15; i++) {
    const prev = s1
    s1 = (feistelF(s1, key[i]) ^ s0) >>> 0
    s0 = prev
  }
  s0 = (feistelF(s1, key[15]) ^ s0) >>> 0
  return inversePermutation(s0, s1)
}

const KEY_RND_SHIFT = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]
const KEY_PERM_C = [56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35]
const KEY_PERM_D = [62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3]
const KEY_COMPRESSION = [13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1, 40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31]

function keySchedule(key: Uint8Array, mode: number): Uint8Array[] {
  const schedule: Uint8Array[] = []
  for (let i = 0; i < 16; i++) schedule.push(new Uint8Array(6))

  let c = 0
  let d = 0
  for (let i = 0; i < 28; i++) {
    c = (c + bitNum(key, KEY_PERM_C[i], 31 - i)) >>> 0
    d = (d + bitNum(key, KEY_PERM_D[i], 31 - i)) >>> 0
  }

  for (let i = 0; i < 16; i++) {
    const shift = KEY_RND_SHIFT[i]
    // 轮移位后掐掉低 4 位：标准 DES 没有这一步，这也是"必须 28 位寄存器"的近似写法
    c = ((((c << shift) >>> 0) | (c >>> (28 - shift))) & 0xfffffff0) >>> 0
    d = ((((d << shift) >>> 0) | (d >>> (28 - shift))) & 0xfffffff0) >>> 0
    const toGen = mode === DECRYPT ? 15 - i : i
    for (let j = 0; j < 24; j++) {
      schedule[toGen][(j / 8) | 0] |= bitNumIntr(c, KEY_COMPRESSION[j], 7 - (j % 8)) & 0xff
    }
    for (let j = 24; j < 48; j++) {
      schedule[toGen][(j / 8) | 0] |= bitNumIntr(d, KEY_COMPRESSION[j] - 27, 7 - (j % 8)) & 0xff
    }
  }
  return schedule
}

const TRIPLE_KEYS: Uint8Array[][] = [
  keySchedule(QRC_KEY.subarray(16), DECRYPT),
  keySchedule(QRC_KEY.subarray(8), ENCRYPT),
  keySchedule(QRC_KEY.subarray(0), DECRYPT),
]

function tripleDESDecryptBlock(block: Uint8Array): Uint8Array {
  let data = block
  for (let i = 0; i < 3; i++) data = desCrypt(data, TRIPLE_KEYS[i])
  return data
}

/**
 * 加密 hex（偶数长度，逐字节）→ 解密后的字节。长度不是 8 的倍数时丢掉尾部不足一块的字节
 * （与参考实现一致：QQ 的载荷本就按 8 字节对齐）。
 */
export function qrcDecryptHex(encryptedHex: string): Uint8Array {
  const hex = encryptedHex.trim()
  if (!/^[0-9A-Fa-f]*$/.test(hex) || hex.length < 16) return new Uint8Array(0)
  const total = (hex.length / 2) | 0
  const encrypted = new Uint8Array(total)
  for (let i = 0; i < total; i++) encrypted[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)

  const out = new Uint8Array(total - (total % 8))
  for (let i = 0; i + 8 <= total; i += 8) out.set(tripleDESDecryptBlock(encrypted.subarray(i, i + 8)), i)
  return out
}
