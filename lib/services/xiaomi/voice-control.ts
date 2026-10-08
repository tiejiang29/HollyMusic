/**
 * 语音接管的第①层：本地控制词表（零网络、零 LLM）。
 *
 * 为什么"命中即执行"这条最爽的路反而要加闸门：**没在投的时候什么都不该动**。
 * 用户说"暂停"，小米自己就暂停了；我们若在没有投放会话时也去发一条 `pause`，
 * 轻则重复一次指令，重则在别人正用那台音箱时插一脚。所以这里把规则写死：
 * **控制词只在"这台设备上有我们的投放会话"时才执行**（`voice-takeover` 那侧查会话）。
 *
 * 词表面板可改、落库（管理员要调的一律进面板 + 落库），默认这份是按小爱常见口令列的；
 * 顺序有意义：**先长的、先具体的**（"取消单曲循环"要赢过"单曲循环"，"不要随机"要赢过"随机"）。
 */

export type ControlOp =
  | 'pause' | 'resume' | 'next' | 'prev' | 'stop'
  | 'volumeUp' | 'volumeDown' | 'setVolume'

export interface ControlRule {
  op: ControlOp
  /** 命中其中任一片段就算这条指令；片段是"包含"匹配，不是全等 */
  words: string[]
}

/**
 * 默认词表。三条注意：
 * - 只做服务端确实管得了的那 7 件（暂停/继续/上下一首/停止/音量）——**播放模式（随机·单曲循环）
 *   是前端 `player-store` 的概念，服务端会话里没有对应物**，硬加一条口令只会接一个假动作；
 * - 没写"播放"这类裸词：太容易在闲聊里被说出来，而投放态要的是"继续"；
 * - 音量步长在 `volumeStep` 里（面板可调），词表只管"往哪边调"。
 */
export const DEFAULT_CONTROL_RULES: ControlRule[] = [
  { op: 'prev', words: ['上一首', '上一曲', '切上一首', '前一首', '退回上一首'] },
  { op: 'next', words: ['下一首', '下一曲', '切歌', '换一首', '切下一首', '播放下一首'] },
  { op: 'volumeUp', words: ['大声一点', '大声点', '音量大一点', '调大音量', '音量调大', '声音大一点', '太轻了', '调大', '响一点'] },
  { op: 'volumeDown', words: ['小声一点', '小声点', '音量小一点', '调小音量', '音量调小', '声音小一点', '太吵了', '调小', '轻一点'] },
  { op: 'stop', words: ['停止播放', '关掉音乐', '关闭音乐', '退出播放', '别放了', '停下'] },
  { op: 'resume', words: ['继续播放', '继续放', '恢复播放', '接着放', '继续这首'] },
  { op: 'pause', words: ['暂停播放', '暂停一下', '先暂停', '停一下', 'pause', '暂停'] },
]

/** 归一化：去空白、去常见标点、转小写（"Pause"和"暂停。"要当成同一句） */
export function normalizeUtterance(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[\s。，！？、；：""''~·\.!\?;:]+/g, '')
    .trim()
}

/** 把面板那份文本（`上一首|上一曲=上一首,上一曲` 每行一条）解析成规则；解析不动就返回原表 */
export function parseControlRules(text: string): ControlRule[] {
  const out: ControlRule[] = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const op = line.slice(0, eq).trim() as ControlOp
    const words = line.slice(eq + 1).split(/[,，|]/).map(w => normalizeUtterance(w)).filter(Boolean)
    if (!words.length) continue
    if (!VALID_OPS.has(op)) continue
    out.push({ op, words })
  }
  return out
}

const VALID_OPS = new Set<string>([
  'pause', 'resume', 'next', 'prev', 'stop', 'volumeUp', 'volumeDown', 'setVolume',
])

/** 规则表 → 面板那份文本（读写同一份表示，改准了能存回去） */
export function formatControlRules(rules: ControlRule[]): string {
  return rules.map(r => `${r.op}=${r.words.join(', ')}`).join('\n')
}

export type ControlHit = { op: ControlOp; matched: string; volumeTo?: number }

/**
 * "这句话像不像在点歌"的触发词表（面板可改、落库）。
 *
 * 为什么非有不可：真机模拟里我说过一句「今天天气怎么样」，小爱答"没有找到"，
 * 而酷我曲库里**真有一首就叫《今天天气怎么样》** ⇒ 相似度 100% ⇒ 我们直接把天气问答
 * 变成了放歌。"它没答上"根本推不出"他要听歌"。所以第②层的门槛是两条同时成立：
 * **它像没答上** 且 **这话像点歌**。
 *
 * 默认这份刻意不收单个"放"字（"放假""星期放"会误开），只认点歌句式的那个形状。
 */
export const DEFAULT_MUSIC_TRIGGERS = [
  '播放', '放一首', '放首', '来一首', '来首', '来点', '我想听', '我要听',
  '听一首', '听首', '点一首', '点首', '听一下', '播一下', '放歌',
]

/** 命中哪个点歌触发词（返回命中的那个词，方便面板上说清"凭什么接管"） */
export function matchMusicTrigger(query: string, triggers: string[]): string | null {
  const text = normalizeUtterance(query)
  if (!text) return null
  for (const raw of triggers ?? []) {
    const t = normalizeUtterance(raw)
    if (t && text.includes(t)) return t
  }
  return null
}

/** "音量调到 40"这类带数字的指令要单独抠出来（其余 op 只按片段匹配） */
const VOLUME_TO = /(?:音量|声音)(?:调到|设为|改成|变成|是)\s*([0-9]{1,3})/

/**
 * 命中哪条控制指令。按表里的顺序试（先具体后笼统），一条都没中就返回 null。
 * 返回 matched 是为了让面板显示"是哪几个字触发的"——判错时这是唯一能自查的线索。
 */
export function matchControl(query: string, rules: ControlRule[]): ControlHit | null {
  const text = normalizeUtterance(query)
  if (!text) return null
  const to = text.match(VOLUME_TO)
  if (to) {
    const n = Number(to[1])
    if (Number.isFinite(n)) return { op: 'setVolume', matched: to[0], volumeTo: Math.min(100, Math.max(0, n)) }
  }
  for (const rule of rules) {
    for (const w of rule.words) {
      const needle = normalizeUtterance(w)
      if (needle && text.includes(needle)) return { op: rule.op, matched: needle }
    }
  }
  return null
}

/**
 * 编辑距离（莱氏顿伯格），只给相似度用。
 * 短句（歌曲名）所以 O(n*m) 无所谓；上限防的是有人把整段话丢进来。
 */
export function levenshtein(a: string, b: string): number {
  const s = a.length > 64 ? a.slice(0, 64) : a
  const t = b.length > 64 ? b.slice(0, 64) : b
  if (s === t) return 0
  if (!s.length) return t.length
  if (!t.length) return s.length
  let prev = new Array<number>(t.length + 1)
  let cur = new Array<number>(t.length + 1)
  for (let j = 0; j <= t.length; j++) prev[j] = j
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    const swap = prev
    prev = cur
    cur = swap
  }
  return prev[t.length]
}

/** 相似度 = 1 - 距离/较长串长度（照参考实现的口径），完全不一样是 0 */
export function similarity(a: string, b: string): number {
  const s = normalizeUtterance(a)
  const t = normalizeUtterance(b)
  const max = Math.max(s.length, t.length)
  if (!max) return 0
  return 1 - levenshtein(s, t) / max
}
