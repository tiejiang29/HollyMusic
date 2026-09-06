package com.tiejiang.hollymusic.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.QueueMusic
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.tiejiang.hollymusic.core.Api
import com.tiejiang.hollymusic.core.Song
import com.tiejiang.hollymusic.core.PlayerManager
import com.tiejiang.hollymusic.core.PlayerManager.PlayerState
import com.tiejiang.hollymusic.ui.theme.Holly

/** 封面：uid 稳定取色渐变占位 + 真图加载 */
@Composable
fun HollyCover(uid: String?, modifier: Modifier = Modifier, shape: RoundedCornerShape = HollyShapes.coverRound, text: String? = null) {
    val colors = Holly.coverColors(uid ?: "?")
    Box(
        modifier
            .clip(shape)
            .background(Brush.linearGradient(colors)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text ?: "",
            color = Color.White.copy(alpha = 0.9f),
            fontWeight = FontWeight.Bold,
            fontSize = 16.sp,
        )
        if (uid != null) {
            AsyncImage(
                model = Api.coverUrl(uid),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.matchParentSize(),
            )
        }
    }
}

private val HollyShapes = object {
    val coverRound = RoundedCornerShape(12.dp)
}

/** 三柱音浪（正在播放标记） */
@Composable
fun WaveIndicator(modifier: Modifier = Modifier, color: Color = Holly.green) {
    val t = rememberInfiniteTransition(label = "wave")
    val scales = listOf(
        t.animateFloat(0.4f, 1f, infiniteRepeatable(tween(500, easing = LinearEasing), RepeatMode.Reverse), label = "w1"),
        t.animateFloat(1f, 0.4f, infiniteRepeatable(tween(500, delayMillis = 120, easing = LinearEasing), RepeatMode.Reverse), label = "w2"),
        t.animateFloat(0.7f, 0.3f, infiniteRepeatable(tween(500, delayMillis = 240, easing = LinearEasing), RepeatMode.Reverse), label = "w3"),
    )
    Row(modifier.height(14.dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.Bottom) {
        scales.forEach { s ->
            Box(
                Modifier
                    .width(3.dp)
                    .height((13 * s.value).dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(color)
            )
        }
    }
}

/** 通用歌曲行（正在播放高亮 + ⋮ 菜单） */
@Composable
fun SongRow(
    song: Song,
    isCurrent: Boolean,
    isPlaying: Boolean,
    modifier: Modifier = Modifier,
    onPlay: () -> Unit,
    onMore: (() -> Unit)? = null,
) {
    Row(
        modifier
            .fillMaxWidth()
            .clickable(onClick = onPlay)
            .padding(horizontal = 18.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            HollyCover(uid = song.uid.ifBlank { null }, modifier = Modifier.size(48.dp))
            song.takeIf { isCurrent }?.let {
                Box(
                    Modifier
                        .matchParentSize()
                        .background(Color.Black.copy(alpha = 0.35f)),
                    contentAlignment = Alignment.Center,
                ) {
                    if (isPlaying) WaveIndicator(color = Color.White) else Icon(
                        Icons.Filled.PlayArrow, null, tint = Color.White, modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    song.name,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = if (isCurrent) Holly.green else MaterialTheme.colorScheme.onBackground,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (isCurrent && isPlaying) WaveIndicator(Modifier.padding(start = 6.dp))
            }
            Text(
                buildString {
                    append(song.singer)
                    song.albumName?.takeIf { it.isNotBlank() }?.let { append(" · $it") }
                },
                fontSize = 12.sp,
                color = Holly.txt2,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 3.dp),
            )
        }
        onMore?.let {
            IconButton(onClick = it) {
                Icon(Icons.Filled.MoreVert, "更多", tint = Holly.txt3)
            }
        }
    }
}

/** 胶囊筛选 chip */
@Composable
fun HollyChip(text: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        shape = CircleShape,
        color = if (selected) Color.Transparent else Holly.card,
        shadowElevation = 1.dp,
        modifier = Modifier.clip(CircleShape).clickable(onClick = onClick),
    ) {
        Box(
            Modifier
                .background(if (selected) Holly.grad else Brush.linearGradient(listOf(Holly.card, Holly.card)))
                .padding(horizontal = 16.dp, vertical = 6.dp),
        ) {
            Text(
                text,
                fontSize = 12.5.sp,
                color = if (selected) Color.White else Color(0xFF5A6474),
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            )
        }
    }
}

/** 区块标题（可选右侧「更多」） */
@Composable
fun SectionHeader(title: String, onMore: (() -> Unit)? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = 18.dp, end = 18.dp, top = 16.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, fontSize = 17.sp, fontWeight = FontWeight.ExtraBold)
        Spacer(Modifier.weight(1f))
        onMore?.let {
            Text("更多 ›", fontSize = 12.sp, color = Holly.txt2, modifier = Modifier.clickable(onClick = it))
        }
    }
}

/** 全局迷你播放条（随歌取色胶囊） */
@Composable
fun MiniPlayer(st: PlayerState, onClick: () -> Unit) {
    val song = st.current ?: return
    val colors = Holly.coverColors(song.uid)
    Box(
        Modifier
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .fillMaxWidth()
            .height(58.dp)
            .clip(CircleShape)
            .background(
                Brush.linearGradient(
                    listOf(colors[0].copy(alpha = 0.55f), colors[1].copy(alpha = 0.45f))
                )
            )
            .clickable(onClick = onClick),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .align(Alignment.Center)
                .fillMaxSize()
                .padding(start = 8.dp, end = 6.dp),
        ) {
            Box(Modifier.size(42.dp), contentAlignment = Alignment.Center) {
                HollyCover(uid = song.uid, modifier = Modifier.size(38.dp).clip(CircleShape))
            }
            Column(
                Modifier
                    .weight(1f)
                    .padding(start = 8.dp)
            ) {
                Text(song.name, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Color(0xFF153B2A), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(song.singer, fontSize = 11.sp, color = Color(0xFF153B2A).copy(alpha = 0.6f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconButton(onClick = { PlayerManager.togglePlayPause() }) {
                Icon(
                    if (st.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    null, tint = Color(0xFF153B2A),
                )
            }
            IconButton(onClick = onClick) {
                Icon(Icons.Filled.QueueMusic, null, tint = Color(0xFF153B2A))
            }
        }
    }
}

/** 播放列表条目辅助格式化 */
fun formatMs(ms: Long): String {
    if (ms <= 0) return "00:00"
    val s = ms / 1000
    return "%02d:%02d".format(s / 60, s % 60)
}
