
import { useEffect, useState } from 'react'
import { buildCoverUrl } from '@/lib/api/music'
import { Music2 } from 'lucide-react'

interface CoverImageProps {
  uid: string
  cacheKey?: string | null
  className?: string
}

export function CoverImage({ uid, cacheKey, className = '' }: CoverImageProps) {
  const [error, setError] = useState(false)

  useEffect(() => {
    setError(false)
  }, [uid, cacheKey])

  if (error || !uid) {
    return (
      <div className={`flex items-center justify-center rounded bg-muted text-muted-foreground ${className}`}>
        <Music2 className="h-1/2 w-1/2" />
      </div>
    )
  }

  // cacheKey 是 MusicInfo.img：如果有 CDN 直链，直接用它（最快最稳）
  // 否则走 /api/cover/ 代理（按需从平台拉取）
  const src = cacheKey && cacheKey.startsWith('http')
    ? cacheKey
    : buildCoverUrl(uid, cacheKey)

  return (
    <img
      src={src}
      onError={() => setError(true)}
      alt=""
      loading="lazy"
      className={`rounded object-cover ${className}`}
    />
  )
}
