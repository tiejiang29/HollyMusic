/**
 * 小爱音箱网关面板（admin Tab 子组件，G0：扫码登录 + 设备列表）。
 *
 * 三条纪律：
 * 1. 这里**一个字的凭据都不显示**：账号只显示尾号、票只显示 `…xxxx`（服务端已脱敏，别想在这儿拼回来）；
 * 2. 扫码是"服务端长轮询只等 8 秒 + 前端隔 3 秒再问一次"，不能写成 while 循环把浏览器挂死；
 *    切走页签/组件卸载都要停得下来（`useEffect` 的清理函数负责）。
 * 3. 取消一张没人扫的码只需要丢掉本地这份：轮询要同时带 sessionId 和一次性 `loginToken`，
 *    而 `loginToken` 只在这次响应里出现过、没进任何存储 —— 别人拿着 id 也轮不动，服务端的
 *    会话 5 分钟后自己作废。所以这里**不调 logout**（那会把已登录的状态一起清掉）。
 */

import { useCallback, useEffect, useState } from 'react'
import {
  getSpeaker, startSpeakerQr, pollSpeakerQr, refreshSpeakerDevices,
  setSpeakerManaged, setSpeakerEnabled, speakerLogout,
  type QrStartResult, type SpeakerView,
} from '@/lib/api/admin-speaker'
import { LoadingSkeleton } from '@/components/shared/LoadingSkeleton'
import { EmptyState } from '@/components/shared/EmptyState'
import { Speaker, QrCode, RefreshCw, LogOut, Loader2, TriangleAlert } from 'lucide-react'

/** 剩余时间说人话：不足 1 小时只报分（导出给测试，与面板同一份口径） */
export function humanRemaining(ms: number): string {
  const totalMin = Math.floor(Math.max(0, ms) / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`
}

export function clockText(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—'
}

export function SpeakerPanel() {
  const [view, setView] = useState<SpeakerView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [qr, setQr] = useState<QrStartResult | null>(null)
  const [qrNote, setQrNote] = useState('')
  const [qrMsLeft, setQrMsLeft] = useState(0)
  const [busyDevices, setBusyDevices] = useState(false)
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setView(await getSpeaker())
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  // 拿到二维码就开始问"扫了没"：单次请求最长 8 秒（服务端那侧的长轮询切片），
  // 收到 waiting 再隔 3 秒问一次；signedIn / expired / failed 都终止循环。
  useEffect(() => {
    if (!qr) return undefined
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const ask = async () => {
      try {
        const r = await pollSpeakerQr(qr.sessionId, qr.loginToken)
        if (cancelled) return
        if (r.state === 'signedIn') {
          setQr(null)
          setQrNote('')
          setView(r.view)
          // 扫完就顺手拉一次设备列表，管理员不用再点一下
          try {
            const d = await refreshSpeakerDevices()
            if (!cancelled) setView(d.view)
          } catch (e) {
            setError(`已登录，但设备列表没拉下来：${e instanceof Error ? e.message : '未知原因'}`)
          }
          return
        }
        if (r.state === 'expired' || r.state === 'failed') {
          setQr(null)
          setQrNote(r.message)
          return
        }
        setQrNote('等待扫码…（在手机上点确认后才算登录）')
        timer = setTimeout(ask, 3000)
      } catch (e) {
        if (cancelled) return
        setQr(null)
        setQrNote(e instanceof Error ? e.message : '扫码状态查询失败，请重新获取二维码')
      }
    }

    timer = setTimeout(ask, 1200)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [qr])

  // 二维码倒计时只用于显示：真正的过期判据在服务端（它才知道会话是哪一秒建的）
  useEffect(() => {
    if (!qr) return undefined
    const counter = setInterval(() => setQrMsLeft(v => Math.max(0, v - 1000)), 1000)
    return () => clearInterval(counter)
  }, [qr])

  const handleStartQr = async () => {
    setError(null)
    setQrNote('')
    try {
      const r = await startSpeakerQr()
      setQr(r)
      setQrMsLeft(r.expiresInMs)
      setQrNote('正在等待扫码…（用「米家」或「小爱音箱」App 扫一扫）')
    } catch (e) {
      setQrNote(e instanceof Error ? e.message : '二维码获取失败')
    }
  }

  const handleCancelQr = () => {
    setQr(null)
    setQrNote('已取消这张二维码')
  }

  const handleDevices = async () => {
    setBusyDevices(true)
    setError(null)
    try {
      const r = await refreshSpeakerDevices()
      setView(r.view)
    } catch (e) {
      setError(e instanceof Error ? e.message : '设备列表刷新失败')
    } finally {
      setBusyDevices(false)
    }
  }

  const handleManaged = async (deviceID: string, managed: boolean) => {
    setBusyDeviceId(deviceID)
    try {
      setView(await setSpeakerManaged(deviceID, managed))
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusyDeviceId(null)
    }
  }

  const handleEnabled = async (enabled: boolean) => {
    try {
      setView(await setSpeakerEnabled(enabled))
    } catch (e) {
      setError(e instanceof Error ? e.message : '开关切换失败')
    }
  }

  const handleLogout = async () => {
    if (!confirm('退出小爱登录会清掉存着的凭据和这台账号的设备表，确定？')) return
    try {
      setQr(null)
      setView(await speakerLogout())
    } catch (e) {
      setError(e instanceof Error ? e.message : '退出失败')
    }
  }

  const minutes = Math.floor(Math.max(0, qrMsLeft) / 60000)
  const seconds = Math.floor(Math.max(0, qrMsLeft) / 1000) % 60

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <Speaker className="h-5 w-5 text-primary" />
            小爱音箱网关
          </h2>
          <p className="text-sm text-muted-foreground">
            扫码登录小米账号（管理员不用填密码），列出账号下的音箱并标记纳管；推歌与语音接管在后续期次
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={reload}
            title="只重新读一遍面板状态（不出网、不会续票）；要拉音箱列表或触发续期请点下面设备区右上角的「刷新设备列表」"
            className="flex items-center gap-1 rounded-full px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="h-4 w-4" /> 重新读取状态
          </button>
          {view?.loggedIn ? (
            <button
              onClick={handleLogout}
              className="flex items-center gap-1 rounded-full bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90"
            >
              <LogOut className="h-4 w-4" /> 退出登录
            </button>
          ) : (
            <button
              onClick={handleStartQr}
              className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              <QrCode className="h-4 w-4" /> 获取登录二维码
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <LoadingSkeleton count={3} />
      ) : error && !view ? (
        <EmptyState icon={Speaker} title="加载失败" description={error} />
      ) : !view ? (
        <EmptyState icon={Speaker} title="暂无状态" description="点右上角「刷新」重试" />
      ) : (
        <div className="space-y-6">
          {error ? (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
              <TriangleAlert className="h-4 w-4 shrink-0" /> {error}
            </div>
          ) : null}

          <div className="rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                {view.loggedIn ? (
                  <span className="font-medium">
                    已登录：账号尾号 <span className="font-mono">{view.accountTail || '—'}</span>
                    <span className="text-muted-foreground">（票尾 </span>
                    <span className="font-mono text-muted-foreground">{view.tokenTail || '—'}</span>
                    <span className="text-muted-foreground">）</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">未登录：扫码后这里会显示账号尾号与到期时间</span>
                )}
              </div>
              <label className={`flex items-center gap-2 text-sm ${view.loggedIn ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded accent-primary"
                  checked={view.enabled}
                  disabled={!view.loggedIn}
                  onChange={e => handleEnabled(e.target.checked)}
                />
                启用网关
              </label>
            </div>

            {view.loggedIn ? (
              <div className="mt-3 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-3">
                <div>票到期时间：<span className="text-foreground">{clockText(view.expiresAt)}</span></div>
                <div>
                  还剩{' '}
                  <span className={view.msToExpiry !== null && view.msToExpiry <= 0 ? 'text-destructive' : 'text-foreground'}>
                    {view.msToExpiry === null ? '—' : view.msToExpiry <= 0 ? '已过期' : humanRemaining(view.msToExpiry)}
                  </span>
                </div>
                <div>设备列表更新时间：<span className="text-foreground">{clockText(view.lastSyncAt)}</span></div>
                {view.needsRefresh ? (
                  <div className="sm:col-span-2 lg:col-span-3">
                    {view.msToExpiry !== null && view.msToExpiry <= 0
                      ? '票已过期：点下面设备区的「刷新设备列表」会用库里的 passToken 自动续一张，不需要重新扫码'
                      : '有效期快到了：点下面设备区的「刷新设备列表」会自动用 passToken 静默续期，不需要重新扫码（右上角「重新读取状态」只读，不出网）'}
                  </div>
                ) : null}
              </div>
            ) : null}

            {view.lastError ? (
              <div className="mt-3 flex items-start gap-2 rounded bg-accent/50 px-3 py-2 text-xs">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                <span className="min-w-0 flex-1 break-words">{view.lastError}</span>
              </div>
            ) : null}
          </div>

          {!view.loggedIn || qr ? (
            <div className="rounded-lg border border-border p-4">
              {qr ? (
                <div className="flex flex-wrap items-start gap-5">
                  <img
                    src={`data:image/png;base64,${qr.qrPngBase64}`}
                    alt="小米登录二维码"
                    className="h-60 w-60 rounded border border-border bg-white object-contain p-2"
                  />
                  <div className="min-w-[14rem] flex-1 text-sm">
                    <div className="font-medium">用「米家」或「小爱音箱」App 扫一扫</div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      扫完记得在手机上点「确认登录」。这张码还剩 {minutes} 分 {seconds} 秒
                      （超过 5 分钟没扫就重新要一张）
                    </p>
                    {qrNote ? <p className="mt-3 text-xs">{qrNote}</p> : null}
                    <button
                      onClick={handleCancelQr}
                      className="mt-4 rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      取消这张码
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-4">
                  <button
                    onClick={handleStartQr}
                    className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                  >
                    <QrCode className="h-4 w-4" /> 获取登录二维码
                  </button>
                  {qrNote ? <span className="text-sm text-muted-foreground">{qrNote}</span> : null}
                </div>
              )}
            </div>
          ) : null}

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium">账号下的音箱（{view.devices.length}）</h3>
              <button
                onClick={handleDevices}
                disabled={!view.loggedIn || busyDevices}
                className="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busyDevices ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                刷新设备列表
              </button>
            </div>
            {!view.loggedIn ? (
              <p className="text-sm text-muted-foreground">登录后才能拉设备列表</p>
            ) : view.devices.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有设备记录，点上面「刷新设备列表」拉一次</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-accent/40 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">音箱名称</th>
                      <th className="w-[9rem] px-4 py-3 font-medium">型号（hardware）</th>
                      <th className="w-[7rem] px-4 py-3 font-medium">在线</th>
                      <th className="w-[7rem] px-4 py-3 font-medium">纳管</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.devices.map(d => (
                      <tr key={d.deviceID} className="border-t border-border hover:bg-accent/20">
                        <td className="px-4 py-3">
                          <div className="min-w-0 break-words">{d.name}</div>
                          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground/70">{d.deviceID}</div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs" title={`miotDID：${d.miotDID || '（没给）'}`}>
                          {d.hardware || '—'}
                          {d.model && d.model !== d.hardware ? <div className="text-muted-foreground/70">{d.model}</div> : null}
                        </td>
                        <td className="px-4 py-3">
                          <span className={d.presence === 'online' ? 'text-foreground' : 'text-muted-foreground'}>
                            {d.presence === 'online' ? '在线' : d.presence}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {busyDeviceId === d.deviceID ? (
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          ) : (
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded accent-primary"
                              checked={d.managed}
                              onChange={e => handleManaged(d.deviceID, e.target.checked)}
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              型号决定这台将来走哪条推歌接口，所以即使现在还没有推歌能力也要先把它存下来、看得见
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
