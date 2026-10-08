/**
 * QQ 音乐 tx 搜索的 `zzc` 签名与请求形状。
 *
 * 为什么要有这个文件：`musicu.fcg` 那条老接口现在对匿名请求**不再返回搜索结果**
 * （子包 code=2001/500003，或 code=0 但 `sum=0`、列表全空），换成
 * `musics.fcg?sign=zzc…` 才给。签名是**纯算法**（对请求体 JSON 串做 SHA1 后按下标取字符
 * + 逐字节 XOR + 去掉特殊符号的 base64），不需要登录、不需要 token，所以无人值守可用。
 *
 * 算法出处：lyswhut/lx-music-desktop v2.12.3「修复 tx 歌曲搜索失败的问题（#2848）」，
 * 文件 `src/renderer/utils/musicSdk/tx/utils/crypto.js` 与 `tx/musicSearch.js`，
 * 该仓库为 **Apache-2.0 许可**，此处按原实现移植（常量表与取位顺序不要动，改了签名就不对）。
 */

const crypto = require('crypto')

const ENDPOINT = 'https://u.y.qq.com/cgi-bin/musics.fcg'

const PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19]
const PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5]
const SCRAMBLE_VALUES = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179]

/** 载荷键：子包既可能按这个模块名回，也可能按老的 `req` 回，两种都要认 */
const SUB_KEY = 'music.search.SearchCgiService'

/** PC 客户端那套匿名身份（`ct:19` 这一族的字段名带下划线，与老的 `ct:11` 一族不通用） */
const COMM = {
  _channelid: '0',
  _os_version: '6.2.9200-2',
  ct: '19',
  cv: '2151',
  guid: '1F70E520B2EAA7D25E11760783C53CA9',
  patch: '118',
  psrf_access_token_expiresAt: 0,
  psrf_qqaccess_token: '',
  psrf_qqopenid: '',
  psrf_qqunionid: '',
  tmeAppID: 'qqmusic',
  tmeLoginType: 0,
  uin: '0',
  wid: '7223299733393904640',
}

function zzcSign(text) {
  const hash = crypto.createHash('sha1').update(text).digest('hex')
  const part1 = PART_1_INDEXES.map(i => hash[i]).join('')
  const part2 = PART_2_INDEXES.map(i => hash[i]).join('')
  const part3 = SCRAMBLE_VALUES.map((value, i) => value ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16))
  const b64 = Buffer.from(part3).toString('base64').replace(/[\\/+=]/g, '')
  return (`zzc${part1}${b64}${part2}`).toLowerCase()
}

/** 会话号：32 位大写十六进制 + 5 位补零随机 = 37 字符。服务端只查唯一性，实测固定值也回数据 */
function txSearchId() {
  let hex = ''
  for (let i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16)
  return hex.toUpperCase() + String(Math.floor(Math.random() * 100000)).padStart(5, '0')
}

/**
 * 一次搜索要发的东西。**text 与 sign 必须出自同一份字符串**——签名算的就是载荷的字节，
 * 谁再 stringify 一次（键序变了）签名就对不上，所以这里一次性做完，调用方只管发。
 */
function txSearchRequest(query, page = 1, limit = 30) {
  const data = {
    comm: COMM,
    [SUB_KEY]: {
      module: SUB_KEY,
      method: 'DoSearchForQQMusicDesktop',
      param: {
        grp: 1,
        num_per_page: limit,
        page_num: page,
        query,
        remoteplace: 'txt.newclient.top',
        search_type: 0,
        searchid: txSearchId(),
      },
    },
  }
  const text = JSON.stringify(data)
  return { url: `${ENDPOINT}?sign=${zzcSign(text)}`, text }
}

/** 从响应里认歌：新版在 `song.list`，老 Lite 那版在 `item_song`；`sum` 给分页用 */
function pickTxSongs(json) {
  const sub = json && (json[SUB_KEY] || json.req)
  const code = sub && sub.code
  const data = sub && sub.data
  const body = (data && data.body) || {}
  const items = body.item_song || (body.song && body.song.list) || []
  return { code, items: Array.isArray(items) ? items : [], sum: (data && data.meta && data.meta.sum) || 0 }
}

module.exports = { ENDPOINT, SUB_KEY, zzcSign, txSearchId, txSearchRequest, pickTxSongs }
