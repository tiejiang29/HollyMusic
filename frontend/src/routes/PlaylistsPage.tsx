import { useRef, useState } from 'react'
import { usePlaylists } from '@/hooks/usePlaylists'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { CreatePlaylistDialog } from '@@/components/playlists/CreatePlaylistDialog'
import { PlaylistGrid } from '@@/components/playlists/PlaylistGrid'
import { ListMusic, Plus, Sparkles, Upload, Link2, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { importPlaylist, importPlaylistFromLink } from '@/lib/api/playlists'

/** 从导入文件中提取歌曲数组，兼容常见格式 */
function extractSongs(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  // 洛雪桌面版导出：{ type: 'playList', data: [...] }
  if (Array.isArray(obj.data)) return obj.data
  // 本站导入格式
  if (Array.isArray(obj.songs)) return obj.songs
  // 洛雪移动端备份：{ type: 'playList', data: { default: { info: { list: [...] } }, ... } }
  if (obj.data && typeof obj.data === 'object') {
    const lists = []
    for (const v of Object.values(obj.data as Record<string, unknown>)) {
      const info = (v as { info?: { list?: unknown[] } })?.info
      if (Array.isArray(info?.list)) lists.push(...info.list)
    }
    if (lists.length > 0) return lists
  }
  return null
}

const PLATFORM_OPTIONS = [
  { value: 'wy', label: '网易云' },
  { value: 'tx', label: 'QQ 音乐' },
  { value: 'kw', label: '酷我' },
  { value: 'kg', label: '酷狗' },
  { value: 'mg', label: '咪咕' },
]

function LinkImportDialog({ onClose, onImported }: {
  onClose: () => void
  onImported: () => void
}) {
  const [input, setInput] = useState('')
  const [source, setSource] = useState('wy')
  const [name, setName] = useState('')
  const [cookie, setCookie] = useState('')
  const [busy, setBusy] = useState(false)
  const isUrl = /^https?:\/\//i.test(input.trim())

  const submit = async () => {
    if (!input.trim() || busy) return
    setBusy(true)
    try {
      const result = await importPlaylistFromLink(
        input.trim(),
        isUrl ? undefined : source,
        name.trim() || undefined,
        cookie.trim() || undefined,
      )
      alert(`导入成功：「${result.name}」${result.imported} 首`)
      onImported()
      onClose()
    } catch (err) {
      alert(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-card p-5 shadow-lg" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">从平台链接导入</h2>
          <button onClick={onClose} className="rounded-full p-1 text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          粘贴公开歌单分享链接（自动识别平台），或直接填歌单 ID 并选择平台
        </p>
        <input
          autoFocus
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && void submit()}
          placeholder="https://music.163.com/playlist?id=..."
          className="mb-2 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
        />
        {!isUrl && (
          <div className="mb-2 flex gap-2">
            {PLATFORM_OPTIONS.map(p => (
              <button
                key={p.value}
                onClick={() => setSource(p.value)}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-xs transition ${source === p.value ? 'border-primary bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="歌单名称（可选，默认用原歌单名）"
          className="mb-2 w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
        />
        <details className="mb-3">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground">
            私有歌单？可选填平台登录 Cookie（目前支持 网易云 / QQ 音乐）
          </summary>
          <input
            type="password"
            value={cookie}
            onChange={e => setCookie(e.target.value)}
            placeholder="如 MUSIC_U=xxx（网易云）或 uin=..; qm_keyst=..（QQ）"
            className="mt-2 w-full rounded-lg border bg-background px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            获取：电脑浏览器登录平台网页版 → F12 → 网络/Network → 任选一个请求 → 复制请求头里的 Cookie 值。
            Cookie 仅本次导入使用，不会保存。
          </p>
        </details>
        <button
          disabled={!input.trim() || busy}
          onClick={() => void submit()}
          className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? '正在拉取歌单…' : '导入'}
        </button>
      </div>
    </div>
  )
}

export function PlaylistsPage() {
  const { playlists, loading, create, reload } = usePlaylists()
  const [showCreate, setShowCreate] = useState(false)
  const [showLinkImport, setShowLinkImport] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  const handleImportFile = async (file: File) => {
    setImporting(true)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      const songs = extractSongs(parsed)
      if (!songs || songs.length === 0) {
        alert('未能从文件中识别出歌曲列表\n支持：洛雪导出的歌单 JSON 或歌曲数组')
        return
      }
      const name = file.name.replace(/\.json$/i, '') || '导入歌单'
      const result = await importPlaylist(name, songs)
      alert(`导入完成：${result.imported} 首${result.skipped > 0 ? `（跳过 ${result.skipped} 首无效歌曲）` : ''}`)
      await reload()
    } catch (err) {
      alert(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="hidden text-2xl font-bold md:block">我的歌单</h1>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) void handleImportFile(f)
            }}
          />
          <button
            disabled={importing}
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1 rounded-full bg-primary/15 px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/25 disabled:opacity-50"
            title="从洛雪导出的 JSON 文件导入"
          >
            <Upload className="h-4 w-4" /> {importing ? '导入中…' : '导入文件'}
          </button>
          <button
            onClick={() => setShowLinkImport(true)}
            className="flex items-center gap-1 rounded-full bg-primary/15 px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/25"
            title="从网易云/QQ/酷我/酷狗/咪咕的歌单链接导入"
          >
            <Link2 className="h-4 w-4" /> 链接导入
          </button>
          <button
            onClick={() => navigate('/playlists/ai-create')}
            className="flex items-center gap-1 rounded-full bg-primary/15 px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/25"
          >
            <Sparkles className="h-4 w-4" /> AI 建歌单
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> 新建
          </button>
        </div>
      </div>

      {loading ? (
        <LoadingSkeleton count={4} />
      ) : playlists.length > 0 ? (
        <PlaylistGrid playlists={playlists} />
      ) : (
        <EmptyState icon={ListMusic} title="还没有歌单" description="新建、从洛雪导入，或粘贴平台歌单链接" />
      )}

      {showCreate && (
        <CreatePlaylistDialog
          onClose={() => setShowCreate(false)}
          onCreate={async name => {
            await create(name)
            setShowCreate(false)
          }}
        />
      )}
      {showLinkImport && (
        <LinkImportDialog
          onClose={() => setShowLinkImport(false)}
          onImported={() => void reload()}
        />
      )}
    </div>
  )
}
