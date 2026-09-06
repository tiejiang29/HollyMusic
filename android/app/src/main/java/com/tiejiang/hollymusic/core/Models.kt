package com.tiejiang.hollymusic.core

import kotlinx.serialization.Serializable

/** 与服务端 lib/types/music.ts 的 MusicInfo+uid 对齐（宽松解析，忽略未知字段） */
@Serializable
data class Song(
    val name: String = "",
    val singer: String = "",
    val source: String = "",
    val songmid: String = "",
    val albumName: String? = null,
    val interval: String = "",
    val img: String? = null,
    val uid: String = "",
)

@Serializable
data class SuggestItem(val text: String = "", val type: String = "")

@Serializable
data class DiscoveryToplist(
    val id: String = "",
    val name: String = "",
    val description: String = "",
    val cover: String = "",
    val updateTime: String? = null,
    val source: String = "tx",
    val common: Boolean = false,
)

@Serializable
data class DiscoveryPlaylist(
    val id: String = "",
    val name: String = "",
    val author: String = "",
    val description: String = "",
    val cover: String = "",
    val playCount: Long = 0,
    val songCount: Int? = null,
    val source: String = "tx",
)

@Serializable
data class CollectionDetail(
    val id: String = "",
    val name: String = "",
    val description: String = "",
    val cover: String = "",
    val author: String = "",
    val updateTime: String? = null,
    val tracks: List<Song> = emptyList(),
)

@Serializable
data class FavoriteSong(
    val songId: String = "",
    val source: String = "",
    val starredAt: String = "",
    val musicInfo: Song? = null,
)

/** LRC 中的单行歌词 */
data class LyricLine(val timeMs: Long, val text: String)

object Lyrics {
    /** 解析 LRC 文本为按时间排序的行；无时间标签行跳过 */
    fun parse(lrc: String?): List<LyricLine> {
        if (lrc.isNullOrBlank()) return emptyList()
        val out = mutableListOf<LyricLine>()
        val re = Regex("""\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?]""")
        for (raw in lrc.lines()) {
            val line = raw.trim()
            if (line.isEmpty()) continue
            val tags = re.findAll(line).toList()
            if (tags.isEmpty()) continue
            val text = line.substring(tags.last().range.last + 1).trim()
            for (m in tags) {
                val min = m.groupValues[1].toLongOrNull() ?: continue
                val sec = m.groupValues[2].toLongOrNull() ?: continue
                val fracStr = m.groupValues[3]
                val frac = when (fracStr.length) {
                    0 -> 0L
                    1 -> fracStr.toLong() * 100
                    2 -> fracStr.toLong() * 10
                    else -> fracStr.take(3).toLong()
                }
                out += LyricLine(min * 60_000 + sec * 1000 + frac, text)
            }
        }
        return out.sortedBy { it.timeMs }
    }

    /** 当前时间所在行索引（二分） */
    fun indexAt(lines: List<LyricLine>, posMs: Long): Int {
        if (lines.isEmpty()) return -1
        var lo = 0
        var hi = lines.size - 1
        var ans = -1
        while (lo <= hi) {
            val mid = (lo + hi) / 2
            if (lines[mid].timeMs <= posMs) { ans = mid; lo = mid + 1 } else hi = mid - 1
        }
        return ans
    }
}
