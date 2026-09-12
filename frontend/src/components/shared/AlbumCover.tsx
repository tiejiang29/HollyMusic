import { useEffect, useRef, useState } from 'react'
import { Disc3 } from 'lucide-react'
import { getAlbumCover } from '@/lib/api/album'

/**
 * 专辑封面（三级降级）：
 * 1. MusicBrainz Cover Art Archive（按 gid 直链，权威封面；部分网络较慢/不可达）
 * 2. 加载失败或超时(10s) → 服务端探测封面（首曲目搜曲推导 QQ 专辑直链，24h 缓存）
 * 3. 仍失败 → 唱片占位图
 */
const CAA_TIMEOUT_MS = 10_000

export function AlbumCover({ gid, alt, className }: { gid: string; alt?: string; className?: string }) {
  const [stage, setStage] = useState<'caa' | 'probe' | 'placeholder'>('caa')
  const [probeSrc, setProbeSrc] = useState<string | null>(null)
  const loadedRef = useRef(false)

  useEffect(() => {
    // gid 变化重置降级链
    setStage('caa')
    setProbeSrc(null)
    loadedRef.current = false
  }, [gid])

  useEffect(() => {
    if (stage !== 'caa' || loadedRef.current) return
    // CAA 超时保护：挂起（而非 404）时 onError 不触发，需定时降级
    const timer = setTimeout(() => {
      if (!loadedRef.current) setStage('probe')
    }, CAA_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [stage, gid])

  useEffect(() => {
    if (stage !== 'probe') return
    let cancelled = false
    getAlbumCover(gid)
      .then(({ img }) => {
        if (cancelled) return
        if (img) setProbeSrc(img)
        else setStage('placeholder')
      })
      .catch(() => { if (!cancelled) setStage('placeholder') })
    return () => { cancelled = true }
  }, [stage, gid])

  if (stage === 'placeholder') {
    return (
      <div className={`flex items-center justify-center bg-gradient-to-br from-primary/30 to-primary/10 ${className || ''}`}>
        <Disc3 className="h-10 w-10 text-primary/70" />
      </div>
    )
  }

  const src = stage === 'caa'
    ? `https://coverartarchive.org/release-group/${gid}/front-250`
    : probeSrc

  if (!src) {
    return (
      <div className={`flex items-center justify-center bg-gradient-to-br from-primary/30 to-primary/10 ${className || ''}`}>
        <Disc3 className="h-10 w-10 animate-pulse text-primary/70" />
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={alt || ''}
      loading="lazy"
      className={`object-cover ${className || ''}`}
      onLoad={() => { loadedRef.current = true }}
      onError={() => {
        if (stage === 'caa') setStage('probe')
        else setStage('placeholder')
      }}
    />
  )
}
