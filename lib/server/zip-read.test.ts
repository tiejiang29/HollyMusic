/**
 * 内存内 zip 读取器的测试。夹具全部自造（不引入任何真实音源内容），
 * 但形状是**照真包抄的**：真包实测 `flag=0x808`（UTF-8 名 + bit 3 数据描述符、local 头大小为 0），
 * 而另一个真包的条目名根本没置 UTF-8 位、其实是 GBK —— 那两种形状都在下面钉住。
 */
import { describe, expect, it } from 'vitest'
import zlib from 'node:zlib'
import { listZipEntries, extractZipEntry, ZipFormatError, type ZipLimits } from './zip-read'

const LIMITS: ZipLimits = { maxEntryBytes: 100_000, maxTotalBytes: 400_000, maxEntries: 500 }

interface FileSpec {
  name?: string
  /** 直接给名字字节（用来造 GBK / 没置 UTF-8 位的形状） */
  nameBytes?: Buffer
  body?: string
  method?: number
  flag?: number
  /** 照真包：local 头里大小写 0，真大小只记在中央目录 */
  zeroLocalSizes?: boolean
  compOverride?: number
  uncompOverride?: number
  externalAttributes?: number
}

function buildZip(files: FileSpec[], overrides: { totalEntries?: number; cdOffset?: number } = {}): Buffer {
  const parts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const nameBuf = file.nameBytes ?? Buffer.from(file.name ?? '', 'utf8')
    const method = file.method ?? 8
    const flag = file.flag ?? ((file.nameBytes ? 0 : 0x800) | (file.zeroLocalSizes ? 0x08 : 0))
    const body = Buffer.from(file.body ?? '', 'utf8')
    const data = method === 8 ? zlib.deflateRawSync(body) : method === 0 ? body : Buffer.from(body)
    const compSize = file.compOverride ?? data.length
    const uncompSize = file.uncompOverride ?? body.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flag, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(file.zeroLocalSizes ? 0 : compSize, 18)
    local.writeUInt32LE(file.zeroLocalSizes ? 0 : uncompSize, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, nameBuf, data)
    let consumed = local.length + nameBuf.length + data.length
    if (file.zeroLocalSizes) {
      const descriptor = Buffer.alloc(16)
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(compSize, 8)
      descriptor.writeUInt32LE(uncompSize, 12)
      parts.push(descriptor)
      consumed += descriptor.length
    }

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flag, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(compSize, 20)
    central.writeUInt32LE(uncompSize, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(file.externalAttributes ?? 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)
    offset += consumed
  }

  const cd = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(overrides.totalEntries ?? files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(overrides.cdOffset ?? offset, 16)
  return Buffer.concat([...parts, cd, eocd])
}

describe('listZipEntries', () => {
  it('deflate 与 store 两种都能列出来，条目名按 UTF-8 位读', () => {
    const zip = buildZip([
      { name: '包/a.js', body: 'console.log(1)', method: 8 },
      { name: 'b.js', body: 'console.log(2)', method: 0 },
    ])
    const listing = listZipEntries(zip, LIMITS)
    expect(listing.entries.map(e => e.name)).toEqual(['包/a.js', 'b.js'])
    expect(listing.rejected).toEqual([])
  })

  it('真包形状（bit 3 描述符 + local 大小写 0）不影响列出与定位', () => {
    const zip = buildZip([{ name: 'V261003/x.js', body: 'lx.send(1)', zeroLocalSizes: true }])
    const listing = listZipEntries(zip, LIMITS)
    expect(listing.entries).toHaveLength(1)
    expect(listing.entries[0].uncompressedSize).toBe('lx.send(1)'.length)
    expect(extractZipEntry(zip, listing.entries[0], 1000).toString('utf8')).toBe('lx.send(1)')
  })

  it('目录条目不收、也不算被拒', () => {
    const zip = buildZip([{ name: 'V261003/', body: '' }, { name: 'V261003/a.js', body: 'x' }])
    const listing = listZipEntries(zip, LIMITS)
    expect(listing.directories).toBe(1)
    expect(listing.entries.map(e => e.name)).toEqual(['V261003/a.js'])
    expect(listing.rejected).toEqual([])
  })

  it('没置 UTF-8 位但内容是 UTF-8 的，仍然解对', () => {
    const zip = buildZip([{ nameBytes: Buffer.from('音源.js', 'utf8'), body: 'x' }])
    expect(listZipEntries(zip, LIMITS).entries[0].name).toBe('音源.js')
  })

  it('没置 UTF-8 位、其实是 GBK 的（真包就是这个形状），按 GBK 解而不是留一串乱码', () => {
    // [210,244,212,180] 实测 = GBK 的「音源」；直接按 UTF-8 读会得到 U+FFFD
    const nameBytes = Buffer.concat([Buffer.from([210, 244, 212, 180]), Buffer.from('.js', 'utf8')])
    const zip = buildZip([{ nameBytes, body: 'x' }])
    const name = listZipEntries(zip, LIMITS).entries[0].name
    expect(name).toBe('音源.js')
    expect(name.includes(String.fromCharCode(0xFFFD))).toBe(false)
  })

  it('加密条目与不支持的压缩方法各自给出能读的原因', () => {
    const zip = buildZip([
      { name: 'enc.js', body: 'x', flag: 0x801 },
      { name: 'lzma.js', body: 'x', method: 14 },
    ])
    const listing = listZipEntries(zip, LIMITS)
    expect(listing.entries).toEqual([])
    const reasons = listing.rejected.map(r => r.reason).join('，')
    expect(reasons).toContain('加密条目')
    expect(reasons).toContain('不支持的压缩方法 14')
  })

  it('单条目超限与整包超限是两个不同的原因（前者是包内一个巨文件，后者是解压炸弹口径）', () => {
    const big = buildZip([{ name: 'huge.js', body: 'x'.repeat(50_000) }, { name: 'ok.js', body: 'y'.repeat(50_000) }])
    const listing = listZipEntries(big, { ...LIMITS, maxEntryBytes: 60_000, maxTotalBytes: 60_000 })
    expect(listing.entries.map(e => e.name)).toEqual(['huge.js'])
    expect(listing.rejected.map(r => r.reason)).toEqual(['整包解压后超过上限'])

    const oneHuge = buildZip([{ name: 'huge.js', body: 'x'.repeat(120_000) }])
    expect(listZipEntries(oneHuge, LIMITS).rejected.map(r => r.reason)[0]).toContain('单条目解压后超过')
  })

  it('中央目录大小自相矛盾（有内容却压缩大小为 0）时不收 —— 边界猜不出来就不读', () => {
    const zip = buildZip([{ name: 'a.js', body: 'hello', compOverride: 0 }])
    const listing = listZipEntries(zip, LIMITS)
    expect(listing.entries).toEqual([])
    expect(listing.rejected[0].reason).toContain('无法定位数据')
  })

  it('ZIP64 直接拒，不去猜 32 位字段', () => {
    const zip = buildZip([{ name: 'a.js', body: 'x' }], { totalEntries: 0xffff })
    expect(() => listZipEntries(zip, LIMITS)).toThrow(/ZIP64/)
  })

  it('不是 zip、或者结尾被截断，都是 ZipFormatError 而不是半截结果', () => {
    expect(() => listZipEntries(Buffer.from('这不是 zip 文件内容'), LIMITS)).toThrow(ZipFormatError)
    expect(() => listZipEntries(Buffer.alloc(4), LIMITS)).toThrow(/文件太小/)
  })

  it('条目数超上限时报条目数，不会先读完几百条再失败', () => {
    const many = Array.from({ length: 12 }, (_unused, index) => ({ name: `f${index}.js`, body: 'x' }))
    expect(() => listZipEntries(buildZip(many), { ...LIMITS, maxEntries: 10 })).toThrow(/条目数 12 超过上限 10/)
  })

  it('名字里带 .. 就原样留着当标签：我们从不按它落地路径，所以不需要"清洗"', () => {
    const zip = buildZip([{ name: '../../evil.js', body: 'x' }])
    expect(listZipEntries(zip, LIMITS).entries[0].name).toBe('../../evil.js')
  })
})

describe('extractZipEntry', () => {
  it('取出的字节与写入的一致（store 与 deflate 各一条）', () => {
    const zip = buildZip([
      { name: 'a.js', body: 'lx.on(1)', method: 8 },
      { name: 'b.js', body: 'lx.send(2)', method: 0 },
    ])
    const listing = listZipEntries(zip, LIMITS)
    expect(extractZipEntry(zip, listing.entries[0], 1000).toString('utf8')).toBe('lx.on(1)')
    expect(extractZipEntry(zip, listing.entries[1], 1000).toString('utf8')).toBe('lx.send(2)')
  })

  it('声明很小、实际炸开很大 ⇒ 按 maxOutputLength 拦下，不是先把内存炸了再发现', () => {
    const body = 'A'.repeat(200_000)
    const zip = buildZip([{ name: 'bomb.js', body, uncompOverride: 10 }])
    const listing = listZipEntries(zip, { ...LIMITS, maxEntryBytes: 1_000 })
    expect(listing.entries).toHaveLength(1)
    expect(() => extractZipEntry(zip, listing.entries[0], 1000)).toThrow(/解压后超过 1000 字节上限/)
  })

  it('中央目录说的大小超出文件实际末尾（包残缺或撒谎）时报错，不返回半条脚本', () => {
    const zip = buildZip([{ name: 'a.js', body: 'console.log(1)', compOverride: 100_000 }])
    const listing = listZipEntries(zip, { ...LIMITS, maxEntryBytes: 1_000_000 })
    expect(listing.entries).toHaveLength(1)
    expect(() => extractZipEntry(zip, listing.entries[0], 1_000_000)).toThrow(/数据超出文件末尾/)
  })

  it('local 头自己标了加密 ⇒ 就算中央目录没标也拒', () => {
    const zip = buildZip([{ name: 'a.js', body: 'x', flag: 0x809 }])
    const listing = listZipEntries(zip, LIMITS)
    expect(listing.entries).toEqual([])
  })
})
