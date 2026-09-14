/**
 * 识曲指纹子进程 worker（不被 Next 打包，spawn 时以绝对路径运行）
 * 协议：stdin = JSON {pcmFile, sampleRate, fromSec, lenSec} → stdout = 末行 JSON {ok, encoded|error}
 * PCM 走临时文件（Windows 管道写大 payload 会截断）
 */
const fs = require('fs')
const NeteaseUtils = require('./sandbox.bundle.cjs')

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => { input += d })
process.stdin.on('end', async () => {
  let out
  try {
    const { pcmFile, sampleRate, fromSec, lenSec } = JSON.parse(input)
    const pcm = fs.readFileSync(pcmFile)
    fs.unlink(pcmFile, () => {})
    const samples = pcm.length / 2
    const f32 = new Float32Array(samples)
    for (let i = 0; i < samples; i++) f32[i] = pcm.readInt16LE(i * 2) / 32768
    const fake = { sampleRate, length: samples, numberOfChannels: 1, getChannelData: () => f32 }
    const encoded = await NeteaseUtils.Encode(fake, fromSec, lenSec, 0)
    out = { ok: true, encoded }
  } catch (e) {
    out = { ok: false, error: e && e.message ? e.message : String(e) }
  }
  process.stdout.write('\n' + JSON.stringify(out) + '\n')
  process.exit(0)
})
