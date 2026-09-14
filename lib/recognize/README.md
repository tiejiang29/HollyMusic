# 网易识曲指纹器

- `sandbox.bundle.cjs` + `afp.wasm`：提取自 npm 包 `ncm-audio-recognize@1.4.0`
  （github.com/akinazuki/NeteaseCloudMusic-Audio-Recgonize，源自网易官方 Chrome 识曲扩展）
- 输入：48kHz AudioBuffer（`Encode(buffer, fromSec, lenSec, channel)`）
- 输出：指纹串，POST x-www-form-urlencoded 到
  `interface.music.163.com/api/music/audio/match`
  （sessionId / algorithmCode=shazam_v2 / duration=秒 / rawdata=指纹 / times=2 / decrypt=1）
- 仅服务端使用（Node fs 加载 wasm）
