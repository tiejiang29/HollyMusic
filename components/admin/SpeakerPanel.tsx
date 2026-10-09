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

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getSpeaker, startSpeakerQr, pollSpeakerQr, refreshSpeakerDevices,
  setSpeakerManaged, setSpeakerEnabled, speakerLogout,
  setSpeakerHost, setSpeakerQuality, controlSpeakerFromAdmin, setSpeakerVolumeFromAdmin, readSpeakerStatusFromAdmin,
  setSpeakerConversation, readConversationFeed,
  setSpeakerTakeover, readTakeoverLog, simulateAsk,
  type ConversationFeed, type QrStartResult, type SpeakerView, type SpeakerStreamStatus, type TakeoverLogRow,
} from '@/lib/api/admin-speaker'
import { formatControlRules } from '@/lib/services/xiaomi/voice-control'
import { volumeSendDelayMs } from '@/lib/cast-queue'
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

/**
 * `player_get_play_status` 的 status 码 → 人话。
 * `-1`（读不到）与 `0`（确实停了）必须分开显示：把"没报上来"写成"已停止"，
 * 管理员就会去查一个根本不存在的问题。
 */
export const STATUS_LABEL: Record<number, string> = {
  [-1]: '读不到状态',
  0: '已停止',
  1: '正在播',
  2: '已暂停',
}

/** 读不到当前音量时，音量条的起始档 */
const DEFAULT_VOLUME = 50

/**
 * 点开「音量」后弹出的竖向滚动条：拖动即调整，不需要再点提交。
 *
 * 为什么不做成浮层：设备表的外层是 `overflow-hidden`（圆角裁表头），浮层会被裁掉；
 * 放在格子里随行展开，视觉上同样是"点开才出来"，且窄屏不会飘出表格外。
 */
function VolumeSlider({ initial, onSend }: { initial: number; onSend: (v: number) => Promise<void> }) {
  const [value, setValue] = useState(initial)
  const [sending, setSending] = useState(false)
  /** 发送走最新那份回调；ref 的赋值放 effect 里（渲染期写 ref 会被 React 的规则拦掉） */
  const sendRef = useRef(onSend)
  useEffect(() => { sendRef.current = onSend })
  const lastSentAt = useRef(-Infinity)
  const timer = useRef<number | null>(null)
  /** 最后一次已经发出去的值：松手时只有它和当前值不一致才补发，避免同一值发两遍 */
  const sentValue = useRef(initial)

  const push = useCallback((v: number) => {
    sentValue.current = v
    lastSentAt.current = Date.now()
    setSending(true)
    void sendRef.current(v).finally(() => setSending(false))
  }, [])

  const handleChange = (v: number) => {
    setValue(v)
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const delay = volumeSendDelayMs(Date.now(), lastSentAt.current)
    if (delay === null) {
      push(v)
      return
    }
    timer.current = window.setTimeout(() => {
      timer.current = null
      push(v)
    }, delay)
  }

  /** 松手/键盘改完就把落点补发出去：中间被间隔吃掉的那些值无所谓，停在哪一档必须生效 */
  const commit = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (value !== sentValue.current) push(value)
  }

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])

  return (
    <div className="mt-2 flex items-end gap-2 rounded-md border border-border bg-accent/30 px-2 py-2">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={e => handleChange(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        aria-label="音箱音量"
        className="h-28 w-5 accent-primary"
        // 竖向且小端在下：新浏览器靠 writing-mode + rtl，旧 WebKit 认 appearance
        style={{ writingMode: 'vertical-lr', direction: 'rtl', WebkitAppearance: 'slider-vertical' }}
      />
      <div className="text-xs text-muted-foreground">
        <div className="font-mono text-base text-foreground">{value}</div>
        <div className="mt-1 flex items-center gap-1">
          {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {sending ? '发送中…' : '已发到音箱'}
        </div>
      </div>
    </div>
  )
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
  /** 「音箱拉流地址」输入框的草稿：null = 没改过（显示库里的值），只有点保存才落库 */
  const [hostDraft, setHostDraft] = useState<string | null>(null)
  const [busySetting, setBusySetting] = useState(false)
  /** 每台最近一次读到的播放状态（只在这台设备上，不写库、不进日志） */
  const [statusByDevice, setStatusByDevice] = useState<Record<string, SpeakerStreamStatus>>({})
  /** 打开的音量条：null = 没开。initial 来自点开时那一次状态回读，known=false 表示没读到、按默认档起调 */
  const [volPanel, setVolPanel] = useState<{ deviceID: string; initial: number; known: boolean } | null>(null)
  /** 对话回显（G0.5）：读到的行 + 监视器状态；草稿只在本机改，点保存才落库 */
  const [conv, setConv] = useState<ConversationFeed | null>(null)
  const [convPollDraft, setConvPollDraft] = useState<string | null>(null)
  const [convHintsDraft, setConvHintsDraft] = useState<string | null>(null)
  /** 语音接管（G3）：账目 + 各草稿 + 模拟口令的输入与结果 */
  const [askLog, setAskLog] = useState<TakeoverLogRow[]>([])
  const [askRulesDraft, setAskRulesDraft] = useState<string | null>(null)
  const [askSourcesDraft, setAskSourcesDraft] = useState<string | null>(null)
  const [askCutoffDraft, setAskCutoffDraft] = useState<string | null>(null)
  const [askStepDraft, setAskStepDraft] = useState<string | null>(null)
  const [askTriggersDraft, setAskTriggersDraft] = useState<string | null>(null)
  const [minTrackDraft, setMinTrackDraft] = useState<string | null>(null)
  const [simQuery, setSimQuery] = useState('')
  const [simAnswer, setSimAnswer] = useState('')
  const [simResult, setSimResult] = useState<TakeoverLogRow | null>(null)

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
    // 一进来就读一次回显：开着轮询时这一下会让服务端确保监视器在跑，
    // 也让"上次拉取 / 拉了几次 / 见过几条"立刻可见（不点开关也能看到账目）
    readConversationFeed().then(setConv).catch(() => {})
    readTakeoverLog().then(r => setAskLog(r.rows)).catch(() => {})
  }, [reload])

  // 接管开着时账目每 4 秒自己刷一次（关着就别白打接口）
  useEffect(() => {
    if (!view?.takeoverEnabled) return
    const timer = setInterval(() => {
      readTakeoverLog().then(r => setAskLog(r.rows)).catch(() => {})
      // 判定结果现在也回填到回显那一行（「处置」列），所以这一张表要跟着刷：
      // 只刷账目不刷回显，那列会一直显示"没进判据"，看着像坏了
      if (view.conversationEnabled) readConversationFeed().then(setConv).catch(() => {})
    }, 4000)
    return () => clearInterval(timer)
  }, [view?.takeoverEnabled, view?.conversationEnabled])

  const saveTakeover = async (patch: { enabled?: boolean }) => {
    try {
      const r = await setSpeakerTakeover({
        ...patch,
        ...(askRulesDraft !== null ? { controlRulesText: askRulesDraft } : {}),
        ...(askSourcesDraft !== null ? { sources: askSourcesDraft.split(/[,，\s]+/).filter(Boolean) } : {}),
        ...(askCutoffDraft !== null ? { cutoff: Number(askCutoffDraft) } : {}),
        ...(askStepDraft !== null ? { volumeStep: Number(askStepDraft) } : {}),
        ...(askTriggersDraft !== null ? { triggers: askTriggersDraft.split(/[,，\s]+/).filter(Boolean) } : {}),
        ...(minTrackDraft !== null ? { minTrackSec: Number(minTrackDraft) } : {}),
      })
      setView(r.view)
      setAskRulesDraft(null)
      setAskSourcesDraft(null)
      setAskCutoffDraft(null)
      setAskStepDraft(null)
      setAskTriggersDraft(null)
      setMinTrackDraft(null)
      setAskLog((await readTakeoverLog()).rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存接管设置失败')
    }
  }

  const runSimulate = async () => {
    if (!simQuery.trim()) return
    try {
      setSimResult(await simulateAsk(simQuery, simAnswer))
      setAskLog((await readTakeoverLog()).rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : '模拟口令失败')
    }
  }

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

  // ---- G1：拉流地址、音质、播控 ----

  const saveHost = async () => {
    setBusySetting(true)
    setError(null)
    try {
      setView(await setSpeakerHost(hostDraft ?? view?.serverHost ?? ''))
      // 存完把草稿交回给库里的值：这样"保存成功"与"输入框内容"不会各说一套
      setHostDraft(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存服务地址失败')
    } finally {
      setBusySetting(false)
    }
  }

  const saveQuality = async (quality: '320k' | '128k') => {
    try {
      setView(await setSpeakerQuality(quality))
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存音质失败')
    }
  }

  const runControl = async (op: 'play' | 'pause' | 'stop', deviceID: string) => {
    setBusyDeviceId(deviceID)
    setError(null)
    try {
      await controlSpeakerFromAdmin(op, deviceID)
    } catch (e) {
      setError(e instanceof Error ? e.message : `${op} 失败`)
    } finally {
      setBusyDeviceId(null)
    }
  }

  /** 音量条拖动中的发送：不占 busyDeviceId，否则一次拖动会把那台的按钮闪disable几十次 */
  const runVolume = async (volume: number, deviceID: string) => {
    try {
      await setSpeakerVolumeFromAdmin(volume, deviceID)
    } catch (e) {
      setError(e instanceof Error ? e.message : '音量设置失败')
    }
  }

  /**
   * 点开音量条：先读一次状态，把条上的起始值摆成音箱**现在**的音量。
   * 起始值乱猜是有代价的——音箱在 30，条子画在 50，人往下拖一格就跳到 45，听起来是"越调越响"。
   * 读不到（离线/不报）也照样开，只是标明这一档是默认值。
   */
  const openVolume = async (deviceID: string) => {
    if (volPanel?.deviceID === deviceID) {
      setVolPanel(null)
      return
    }
    setBusyDeviceId(deviceID)
    setError(null)
    try {
      const r = await readSpeakerStatusFromAdmin(deviceID)
      setStatusByDevice(prev => ({ ...prev, [deviceID]: r.status }))
      setVolPanel({ deviceID, initial: Math.max(0, r.status.volume), known: r.status.volume >= 0 })
    } catch (e) {
      setError(e instanceof Error ? e.message : '读状态失败')
      setVolPanel({ deviceID, initial: DEFAULT_VOLUME, known: false })
    } finally {
      setBusyDeviceId(null)
    }
  }

  const readStatus = async (deviceID: string) => {
    setBusyDeviceId(deviceID)
    setError(null)
    try {
      const r = await readSpeakerStatusFromAdmin(deviceID)
      setStatusByDevice(prev => ({ ...prev, [deviceID]: r.status }))
    } catch (e) {
      setError(e instanceof Error ? e.message : '读状态失败')
    } finally {
      setBusyDeviceId(null)
    }
  }

  // 轮询开着时每 3 秒问一次服务端 —— 这一下不打小米，读的是服务端那份缓存
  useEffect(() => {
    if (!conv?.state.running) return
    const timer = setInterval(() => {
      readConversationFeed().then(setConv).catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
  }, [conv?.state.running])

  const saveConversation = async (enabled: boolean, pollSec: number) => {
    const hints = (convHintsDraft ?? '').split(/[,，\n]/).map(x => x.trim()).filter(Boolean)
    try {
      const r = await setSpeakerConversation({
        enabled, pollSec,
        ...(convHintsDraft !== null ? { failedAnswerHints: hints } : {}),
      })
      setView(r.view)
      setConvHintsDraft(null)
      setConvPollDraft(null)
      setConv(await readConversationFeed())
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存对话轮询设置失败')
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

          {view.loggedIn ? (
            <div className="rounded-lg border border-border p-4">
              <h3 className="text-sm font-medium">推歌设置</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                音箱是**主动来拉流**的，所以这里必须填它够得着的局域网地址（回环、隧道地址、公网入口它多半打不开）
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  value={hostDraft ?? view.serverHost}
                  onChange={e => setHostDraft(e.target.value)}
                  placeholder="172.16.1.20:3000"
                  className="w-[20rem] rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
                <button
                  onClick={saveHost}
                  disabled={busySetting || (hostDraft ?? view.serverHost).trim() === view.serverHost}
                  className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busySetting ? '保存中…' : '保存地址'}
                </button>
              </div>
              {view.serverHost ? (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  音箱现在会去拉 <span className="font-mono">http://{view.serverHost}/api/speaker/stream?…</span>
                  ，可以先用同一台局域网设备（比如手机连家里 WiFi）打开这个地址试试能不能出声音
                </p>
              ) : (
                <p className="mt-2 text-[11px] text-destructive">没填地址时投歌会被直接拒绝（不会拼一个「看着能播」的 URL）</p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">投歌音质</span>
                {(['320k', '128k'] as const).map(q => (
                  <button
                    key={q}
                    onClick={() => saveQuality(q)}
                    className={`rounded-full px-3 py-1 font-medium ${
                      view.playQuality === q ? 'bg-primary text-primary-foreground' : 'bg-accent text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {q}
                  </button>
                ))}
                <span className="text-muted-foreground">音箱只听得懂 MP3，库里的 FLAC 要等转码那一期</span>
              </div>
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
                      <th className="w-[19rem] px-4 py-3 font-medium">播控</th>
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
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-1 text-xs">
                            <button
                              onClick={() => readStatus(d.deviceID)}
                              disabled={!d.managed || busyDeviceId === d.deviceID}
                              className="rounded-full px-2.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              读状态
                            </button>
                            <button
                              onClick={() => runControl('pause', d.deviceID)}
                              disabled={!d.managed || busyDeviceId === d.deviceID}
                              className="rounded-full px-2.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              暂停
                            </button>
                            <button
                              onClick={() => runControl('play', d.deviceID)}
                              disabled={!d.managed || busyDeviceId === d.deviceID}
                              title="继续：暂停之后从这里恢复（推的是我们那条流地址，音箱不记得上次播到哪）"
                              className="rounded-full px-2.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              继续
                            </button>
                            <button
                              onClick={() => runControl('stop', d.deviceID)}
                              disabled={!d.managed || busyDeviceId === d.deviceID}
                              className="rounded-full px-2.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              停止
                            </button>
                            <span className="ml-auto flex items-center gap-1">
                              <button
                                onClick={() => void openVolume(d.deviceID)}
                                disabled={!d.managed || busyDeviceId === d.deviceID}
                                title="音量：点开后拖动竖向滚动条即调，不用提交（打开时会先读一次音箱当前的音量）"
                                className="rounded-full px-2.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {volPanel?.deviceID === d.deviceID ? '收起音量' : '音量'}
                              </button>
                            </span>
                          </div>
                          {volPanel?.deviceID === d.deviceID ? (
                            <VolumeSlider
                              key={d.deviceID}
                              initial={volPanel.initial}
                              onSend={v => runVolume(v, d.deviceID)}
                            />
                          ) : null}
                          {volPanel?.deviceID === d.deviceID && !volPanel.known ? (
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              没读到这台现在的音量，条子从 {DEFAULT_VOLUME} 起；先拖一格就会发过去
                            </p>
                          ) : null}
                          {statusByDevice[d.deviceID] ? (
                            <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                              {STATUS_LABEL[statusByDevice[d.deviceID].status] ?? `状态码 ${statusByDevice[d.deviceID].status}`}
                              {' · '}位置 {statusByDevice[d.deviceID].position >= 0 ? `${Math.round(statusByDevice[d.deviceID].position / 1000)}s` : '没报'}
                              {' · '}时长 {statusByDevice[d.deviceID].duration > 0 ? `${Math.round(statusByDevice[d.deviceID].duration / 1000)}s` : '不报'}
                              {statusByDevice[d.deviceID].volume >= 0 ? ` · 音量 ${statusByDevice[d.deviceID].volume}` : ''}
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              型号决定这台走哪条推歌接口（在名单里的走 <span className="font-mono">player_play_music</span>，
              其余走 <span className="font-mono">player_play_url</span>）；投歌入口在播放页的「投到小爱」
            </p>
          </div>
        </div>
      )}

      {view?.loggedIn ? (
        <div className="mt-6 rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">对话回显（G0.5：只量时序，不动接管）</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            开着时每 {view.conversationPollSec} 秒拉一次小爱的对话记录，用来量两件事：一句话从说出口到看得见隔了几秒、
            以及哪些回答属于「没答上」。下面那份话术是我的初稿，请照真实回显改准了再信它。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                className="h-4 w-4 rounded accent-primary"
                checked={!!conv?.state.running}
                onChange={e => void saveConversation(e.target.checked, Number(convPollDraft ?? view.conversationPollSec))}
              />
              轮询对话
            </label>
            <input
              type="number"
              min={1}
              max={30}
              defaultValue={view.conversationPollSec}
              onChange={e => setConvPollDraft(e.target.value)}
              className="w-16 rounded border border-border bg-background px-2 py-1"
              title="轮询间隔（秒，1~30）"
            />
            <button
              onClick={() => void saveConversation(!!conv?.state.running, Number(convPollDraft ?? view.conversationPollSec))}
              className="rounded-full px-2.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              保存
            </button>
            {conv?.state.lastPollAt ? (
              <span className="text-muted-foreground">
                上次拉取 {clockText(new Date(conv.state.lastPollAt).toISOString())}
                {' · '}
                {conv.rows.filter(r => !r.fromBaseline).length} 条新话
                {' · '}
                {conv.state.devices.map(d => `${d.name || d.deviceID}：拉 ${d.polls} 次/见 ${d.seen} 条${d.primed ? '' : '/基线未建'}`).join(' ')}
              </span>
            ) : null}
          </div>
          <textarea
            defaultValue={view.failedAnswerHints.join(', ')}
            onChange={e => setConvHintsDraft(e.target.value)}
            rows={2}
            className="mt-2 w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px]"
            title="疑似「没答上」的话术片段，逗号分隔；留空=任何回答都算没答上"
          />
          {conv?.state.lastError ? (
            <p className="mt-2 flex items-center gap-1 text-xs text-destructive">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              {conv.state.lastError}
            </p>
          ) : null}
          {conv?.state.clockSkewMs ? (
            <p className="mt-2 text-xs text-destructive">
              平台最新一条记录的时间戳比本机此刻还晚 {Math.round(conv.state.clockSkewMs / 60000)} 分钟 ⇒
              <b> 本机时钟慢了 </b>（或那台音箱的时钟快）。基线用的一直是平台时间戳，所以这条
              <b>不影响判据</b>，只是「隔了几秒才看得见」那一列会被算歪，看到它就先去核对系统时间。
            </p>
          ) : null}
          {conv && conv.rows.length > 0 ? (
            <div className="mt-3 max-h-64 overflow-auto rounded border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-accent/40 text-left text-[11px] uppercase text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">音箱说的时间</th>
                    <th className="px-2 py-1.5 font-medium">你说</th>
                    <th className="px-2 py-1.5 font-medium">小爱答</th>
                    <th className="px-2 py-1.5 font-medium">延迟</th>
                    <th className="px-2 py-1.5 font-medium">疑似没答上</th>
                    <th className="px-2 py-1.5 font-medium">处置</th>
                  </tr>
                </thead>
                <tbody>
                  {conv.rows.map((r, i) => (
                    <tr key={`${r.deviceID}-${r.timestampMs}-${i}`} className="border-t border-border">
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                        {clockText(new Date(r.timestampMs).toISOString())}
                        {r.fromBaseline ? <span className="ml-1 opacity-60">（历史）</span> : null}
                      </td>
                      <td className="px-2 py-1.5">{r.query || '—'}</td>
                      <td className="px-2 py-1.5">{r.answer || '—'}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px]">
                        {Math.max(0, Math.round((r.receivedAt - r.timestampMs) / 1000))}s
                      </td>
                      <td className="px-2 py-1.5">{r.looksFailed ? '是' : ''}</td>
                      <td className="px-2 py-1.5">
                        {r.takeover ? (
                          <span title={r.takeover.reason}>
                            <span className="font-mono text-[11px] text-muted-foreground">{r.takeover.verdict}</span>
                            {' · '}
                            {r.takeover.acted}
                          </span>
                        ) : (
                          <span
                            className="opacity-60"
                            title="没递进判据的两种情况：启动时那批历史、接管开关关着"
                          >
                            没递进判据
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              {!conv?.state.running ? '轮询没开，开了才会拉对话记录'
                : conv.state.devices.some(d => d.polls > 0 && d.seen === 0)
                  ? '轮询在跑、请求也是通的（code=0），但一条记录都没有。先查 Cookie 里的 deviceId 是不是**这台音箱自己的 deviceID** —— 填成登录那台设备时平台不报错、只是静默回空记录（2026-10-09 就是这么误判成"这台不写对话历史"的）。都对还是一片空，才轮到另一种解释：这个账号确实没留着可读的历史。'
                  : '已经在轮询了，对着音箱说一句试试'}
            </p>
          )}
        </div>
      ) : null}

      {view ? (
        <div className="mt-6 rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">语音接管（G3：你说点歌就由我们放整曲）</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            两层短路：① 命中下面那张控制词表就照做（但<b>只在这台正被我们投放时动</b>，否则交回小爱）；
            ② 句子里有<b>点歌触发词</b>（播放 / 我想听 / 来一首…）就<em>不看小爱答了什么</em>，直接去我们的曲库找最像的一条整曲顶上；
            ③ 都对不上就什么都不做。
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            为什么不看它的回答：这台没音乐会员，小爱接住点歌口令后回的永远是「请欣赏X 试听版，开通音乐会员听全曲」那一套
            —— <b>它答得越顺，端上来的越是 30 秒片段</b>（实测设备上报 30024ms，而《七里香》整曲 04:59）。
            代价也没藏着：不看回答就没人替你判「这句到底是不是点歌」，所以剩下三道闸一道都不松 ——
            触发词、相似度门槛、「像整曲」的时长门槛。<b>含触发词的闲聊会被去搜歌</b>（多半 no-hit 不动），
            真撞上就把那个词从下面那张表里摘掉。
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            一条要注意的：<b>进程重启后的第一轮全算历史</b>（标着「历史」那批不会触发接管），
            所以要验真实口令，得等面板开始轮询之后再对音箱说话；不想等也可以直接用下面那条
            <b>模拟口令</b>走同一条判据链路。
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                className="h-4 w-4 rounded accent-primary"
                checked={view.takeoverEnabled}
                onChange={e => void saveTakeover({ enabled: e.target.checked })}
              />
              允许接管
            </label>
            <span className="text-muted-foreground">相似度门槛</span>
            <input
              type="number"
              min={0.2}
              max={0.95}
              step={0.05}
              defaultValue={view.fuzzyMatchCutoff}
              onChange={e => setAskCutoffDraft(e.target.value)}
              className="w-20 rounded border border-border bg-background px-2 py-1"
            />
            <span className="text-muted-foreground">音量步长</span>
            <input
              type="number"
              min={1}
              max={50}
              defaultValue={view.volumeStep}
              onChange={e => setAskStepDraft(e.target.value)}
              className="w-16 rounded border border-border bg-background px-2 py-1"
              title="说「大声点」时一次加/减多少"
            />
            <span className="text-muted-foreground">像整曲</span>
            <input
              type="number"
              min={0}
              max={600}
              step={5}
              defaultValue={view.takeoverMinTrackSec}
              onChange={e => setMinTrackDraft(e.target.value)}
              className="w-16 rounded border border-border bg-background px-2 py-1"
              title="抢播候选的时长下限（秒）：短于它的当试听版/铃声跳过。填 0 = 不筛（试听版也会被端上来）"
            />
            <input
              type="text"
              defaultValue={view.takeoverSources.join(', ')}
              onChange={e => setAskSourcesDraft(e.target.value)}
              className="w-28 rounded border border-border bg-background px-2 py-1 font-mono text-[11px]"
              title="去哪几台源搜候选，逗号分隔，最多三台"
            />
            <button
              onClick={() => void saveTakeover({})}
              className="rounded-full px-2.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              保存
            </button>
          </div>
          <label className="mt-3 block text-[11px] text-muted-foreground">
            点歌触发词（逗号分隔）：<span className="text-foreground">这句话里含其中一个词，我们就去搜歌并顶上（不看小爱答了什么）</span>。
            这张表现在<b>就是唯一的点歌判据</b>，词填宽了闲聊也会招来放歌：我模拟「今天天气怎么样」时，酷我库里真有一首就叫这个名，相似度 100%。
            默认表刻意不收单个「放」字（「放假」「星期放」会误开）。
            <input
              type="text"
              defaultValue={view.takeoverTriggers.join(', ')}
              onChange={e => setAskTriggersDraft(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px]"
            />
          </label>
          <label className="mt-3 block text-[11px] text-muted-foreground">
            控制词表（一行一条，格式 <code className="font-mono">操作=词,词</code>；顺序有意义，先具体后笼统）
            <textarea
              defaultValue={formatControlRules(view.controlRules as never)}
              onChange={e => setAskRulesDraft(e.target.value)}
              rows={7}
              className="mt-1 w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px]"
            />
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <input
              type="text"
              value={simQuery}
              onChange={e => setSimQuery(e.target.value)}
              placeholder="假装你说：下一首"
              className="w-48 rounded border border-border bg-background px-2 py-1"
            />
            <input
              type="text"
              value={simAnswer}
              onChange={e => setSimAnswer(e.target.value)}
              placeholder="假装小爱答：没有找到（留空=没拿到回答）"
              className="w-64 rounded border border-border bg-background px-2 py-1"
            />
            <button
              onClick={() => void runSimulate()}
              className="rounded-full px-2.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              走一遍判据
            </button>
          </div>
          {simResult ? (
            <p className="mt-2 text-xs">
              <span className="font-mono text-[11px] text-muted-foreground">{simResult.verdict}</span>
              {' · '}
              {simResult.reason}
              {' → '}
              <span className="text-foreground">{simResult.acted}</span>
            </p>
          ) : null}
          {askLog.length > 0 ? (
            <div className="mt-3 max-h-56 overflow-auto rounded border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-accent/40 text-left text-[11px] uppercase text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">时刻</th>
                    <th className="px-2 py-1.5 font-medium">来源</th>
                    <th className="px-2 py-1.5 font-medium">你说</th>
                    <th className="px-2 py-1.5 font-medium">小爱答</th>
                    <th className="px-2 py-1.5 font-medium">判定</th>
                    <th className="px-2 py-1.5 font-medium">做了什么</th>
                  </tr>
                </thead>
                <tbody>
                  {askLog.map((r, i) => (
                    <tr key={`${r.at}-${i}`} className="border-t border-border align-top">
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
                        {clockText(new Date(r.at).toISOString())}
                      </td>
                      <td className="px-2 py-1.5 text-[11px] text-muted-foreground">{r.synthetic ? '合成' : '真话'}</td>
                      <td className="px-2 py-1.5">{r.query || '—'}</td>
                      <td className="px-2 py-1.5">{r.answer || '—'}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px]">{r.verdict}</td>
                      <td className="px-2 py-1.5">
                        {r.acted}
                        <div className="text-[11px] text-muted-foreground">{r.reason}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">还没有判过任何一条口令</p>
          )}
        </div>
      ) : null}
    </div>
  )
}
