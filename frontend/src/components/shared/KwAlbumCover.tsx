import { useEffect, useState } from 'react'

/**
 * 酷我专辑封面（两级降级）：
 * 1. kw 直链 img（正常情况 0 服务端成本）
 * 2. /api/album/kw/cover 服务端解析（kw 专辑/搜索 pic → Apple 按名 → 字节代理）
 * 3. 都失败 → 返回 null，露出容器内的渐变+图标占位
 * 容器（渐变底+图标）由调用方提供，本组件只负责 img 层。
 */
export function KwAlbumCover({
  albumId,
  name,
  singer,
  img,
  className,
}: {
  albumId: string
  name: string
  singer?: string
  /** kw 卡片自带直链（可空：无图直接走服务端解析） */
  img?: string | null
  className?: string
}) {
  const [stage, setStage] = useState<'direct' | 'proxy' | 'dead'>(img ? 'direct' : 'proxy')
  useEffect(() => {
    setStage(img ? 'direct' : 'proxy')
  }, [albumId, img])

  if (stage === 'dead') return null
  const src = stage === 'direct' && img
    ? img
    : `/api/album/kw/cover?albumid=${encodeURIComponent(albumId)}&name=${encodeURIComponent(name)}${singer ? `&singer=${encodeURIComponent(singer)}` : ''}`
  return (
    <img
      src={src}
      alt={name}
      loading="lazy"
      className={className}
      onError={() => setStage(prev => (prev === 'direct' ? 'proxy' : 'dead'))}
    />
  )
}
