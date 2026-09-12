import { useEffect, useState } from 'react'
import { Disc3 } from 'lucide-react'

/**
 * 专辑封面（服务端中转）：
 * GET /api/album/local/cover?gid= 服务端解析最佳封面（Apple 高清 → gtimg 推导）
 * 并抓取字节转发——前端不直连图床；服务端字节缓存 24h + 浏览器 Cache-Control，
 * 重复访问毫秒级。加载失败显示唱片占位。
 */
export function AlbumCover({ gid, alt, className }: { gid: string; alt?: string; className?: string }) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [gid])

  if (failed || !gid) {
    return (
      <div className={`flex items-center justify-center bg-gradient-to-br from-primary/30 to-primary/10 ${className || ''}`}>
        <Disc3 className="h-10 w-10 text-primary/70" />
      </div>
    )
  }

  return (
    <img
      src={`/api/album/local/cover?gid=${encodeURIComponent(gid)}`}
      alt={alt || ''}
      loading="lazy"
      className={`object-cover ${className || ''}`}
      onError={() => setFailed(true)}
    />
  )
}
