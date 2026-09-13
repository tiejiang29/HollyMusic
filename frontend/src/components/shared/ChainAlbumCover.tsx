import { useEffect, useState } from 'react'

/**
 * 链专辑封面（两级降级，kw/mg 通用）：
 * 1. 卡片自带直链 img（正常情况 0 服务端成本）
 * 2. 服务端解析代理端点（proxySrc，跨源降级链在前端不可见）
 * 3. 都失败 → 返回 null，露出容器内的渐变+图标占位
 * 容器（渐变底+图标）由调用方提供，本组件只负责 img 层。
 */
export function ChainAlbumCover({
  img,
  proxySrc,
  alt,
  className,
}: {
  /** 卡片自带直链（可空：无图直接走服务端解析） */
  img?: string | null
  /** 服务端封面解析端点完整 URL（如 /api/album/kw/cover?albumid=...） */
  proxySrc: string
  alt: string
  className?: string
}) {
  const [stage, setStage] = useState<'direct' | 'proxy' | 'dead'>(img ? 'direct' : 'proxy')
  useEffect(() => {
    setStage(img ? 'direct' : 'proxy')
  }, [proxySrc, img])

  if (stage === 'dead') return null
  return (
    <img
      src={stage === 'direct' && img ? img : proxySrc}
      alt={alt}
      loading="lazy"
      className={className}
      onError={() => setStage(prev => (prev === 'direct' ? 'proxy' : 'dead'))}
    />
  )
}
