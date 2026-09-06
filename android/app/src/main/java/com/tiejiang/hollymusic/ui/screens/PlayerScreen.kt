package com.tiejiang.hollymusic.ui.screens

import android.graphics.Bitmap
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.RepeatOne
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.QueueMusic
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.palette.graphics.Palette
import coil.ImageLoader
import coil.request.ImageRequest
import com.tiejiang.hollymusic.core.Api
import com.tiejiang.hollymusic.core.LyricLine
import com.tiejiang.hollymusic.core.Lyrics
import com.tiejiang.hollymusic.core.PlayerManager
import com.tiejiang.hollymusic.core.PlayerManager.PlayerState
import com.tiejiang.hollymusic.ui.components.formatMs
import com.tiejiang.hollymusic.ui.theme.Holly
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** 封面取色：亮/暗两个魔法色（加载失败回退品牌绿系） */
@Composable
private fun rememberMagicColors(uid: String?): Pair<Color, Color> {
    val ctx = LocalContext.current
    var pair by remember(uid) { mutableStateOf<Pair<Color, Color>?>(null) }
    LaunchedEffect(uid) {
        if (uid == null) return@LaunchedEffect
        withContext(Dispatchers.IO) {
            try {
                val loader = ImageLoader(ctx)
                val req = ImageRequest.Builder(ctx)
                    .data(Api.coverUrl(uid))
                    .allowHardware(false)
                    .size(96)
                    .build()
                val dr = loader.execute(req).drawable ?: return@withContext
                val bmp = (dr as? android.graphics.drawable.BitmapDrawable)?.bitmap ?: return@withContext
                val palette = Palette.from(bmp).generate()
                val dark = palette.getDarkVibrantColor(palette.getDarkMutedColor(0xFF1FA36B.toInt()))
                val light = palette.getLightVibrantColor(palette.getVibrantColor(0xFF4FD694.toInt()))
                pair = Color(light).copy(alpha = 1f) to Color(dark).copy(alpha = 1f)
            } catch (_: Exception) {
            }
        }
    }
    return pair ?: (Color(0xFF4FD694) to Color(0xFF14624A))
}

@Composable
fun PlayerScreen(onClose: () -> Unit) {
    val st by PlayerManager.state.collectAsState()
    val song = st.current
    val (light, dark) = rememberMagicColors(song?.uid)

    val bg = Brush.linearGradient(
        listOf(
            light.copy(alpha = 0.95f),
            dark,
            dark.copy(alpha = 0.85f).compositeOverBlack(),
        )
    )

    Box(
        Modifier
            .fillMaxSize()
            .background(bg)
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        Column(Modifier.fillMaxSize()) {
            // 顶栏
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onClose) {
                    Icon(Icons.Filled.KeyboardArrowDown, "收起", tint = Color.White, modifier = Modifier.size(30.dp))
                }
                Column(
                    Modifier.weight(1f),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(song?.name ?: "未在播放", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(song?.singer ?: "", color = Color.White.copy(alpha = 0.72f), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp))
                }
                IconButton(onClick = { /* 更多菜单：音质/下载 二期 */ }) {
                    Icon(Icons.Filled.MoreVert, "更多", tint = Color.White)
                }
            }

            // 中部 pager：封面 ⇄ 歌词
            val pager = rememberPagerState(pageCount = { 2 })
            HorizontalPager(
                state = pager,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
            ) { page ->
                if (page == 0) CoverPage(st, song?.uid)
                else LyricPage(st)
            }

            // 页指示
            Row(
                Modifier
                    .align(Alignment.CenterHorizontally)
                    .padding(vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                repeat(2) { i ->
                    Box(
                        Modifier
                            .height(6.dp)
                            .width(if (pager.currentPage == i) 16.dp else 6.dp)
                            .clip(CircleShape)
                            .background(if (pager.currentPage == i) Color.White else Color.White.copy(alpha = 0.35f))
                    )
                }
            }

            // 试听/错误提示
            st.error?.let {
                Text(
                    it, color = Color(0xFFFFE9C2), fontSize = 11.5.sp, textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 4.dp),
                )
            }

            // 进度条
            var dragPos by remember { mutableStateOf<Float?>(null) }
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 26.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(formatMs((dragPos ?: st.positionMs.toFloat()).toLong()), color = Color.White.copy(alpha = 0.75f), fontSize = 11.sp)
                Slider(
                    value = (dragPos ?: st.positionMs.toFloat()).coerceIn(0f, st.durationMs.toFloat().coerceAtLeast(1f)),
                    onValueChange = { dragPos = it },
                    onValueChangeFinished = {
                        dragPos?.let { PlayerManager.seekTo(it.toLong()) }
                        dragPos = null
                    },
                    valueRange = 0f..st.durationMs.toFloat().coerceAtLeast(1f),
                    colors = SliderDefaults.colors(
                        thumbColor = Color.White,
                        activeTrackColor = Color.White,
                        inactiveTrackColor = Color.White.copy(alpha = 0.22f),
                    ),
                    modifier = Modifier
                        .weight(1f)
                        .padding(horizontal = 10.dp),
                )
                Text(formatMs(st.durationMs), color = Color.White.copy(alpha = 0.75f), fontSize = 11.sp)
            }

            // 控制行
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 30.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = { /* 播放模式二期 */ }, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Filled.Repeat, null, tint = Color.White.copy(alpha = 0.85f))
                }
                IconButton(onClick = { PlayerManager.previous() }, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Filled.SkipPrevious, "上一首", tint = Color.White, modifier = Modifier.size(36.dp))
                }
                Box(
                    Modifier
                        .size(74.dp)
                        .clip(CircleShape)
                        .background(Color.White)
                        .clickable { PlayerManager.togglePlayPause() },
                    contentAlignment = Alignment.Center,
                ) {
                    if (st.buffering && !st.playing) {
                        androidx.compose.material3.CircularProgressIndicator(
                            color = Color(0xFF123B2B), strokeWidth = 2.5.dp, modifier = Modifier.size(28.dp),
                        )
                    } else {
                        Icon(
                            if (st.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                            null,
                            tint = Color(0xFF123B2B),
                            modifier = Modifier.size(34.dp),
                        )
                    }
                }
                IconButton(onClick = { PlayerManager.next() }, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Filled.SkipNext, "下一首", tint = Color.White, modifier = Modifier.size(36.dp))
                }
                IconButton(onClick = { /* 队列 Sheet 二期 */ }, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Filled.QueueMusic, null, tint = Color.White.copy(alpha = 0.85f))
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

private fun Color.compositeOverBlack(): Color = Color(
    red = red * 0.6f,
    green = green * 0.6f,
    blue = blue * 0.6f,
    alpha = 1f,
)

@Composable
private fun CoverPage(st: PlayerState, uid: String?) {
    var coverBmp by remember { mutableStateOf<Bitmap?>(null) }
    val ctx = LocalContext.current
    LaunchedEffect(uid) {
        coverBmp = null
        if (uid == null) return@LaunchedEffect
        withContext(Dispatchers.IO) {
            try {
                val loader = ImageLoader(ctx)
                val req = ImageRequest.Builder(ctx).data(Api.coverUrl(uid)).allowHardware(false).build()
                coverBmp = ((loader.execute(req).drawable as? android.graphics.drawable.BitmapDrawable)?.bitmap)
            } catch (_: Exception) {
            }
        }
    }
    val breath by animateFloatAsState(
        targetValue = if (st.playing) 1.02f else 1f,
        animationSpec = tween(1600), label = "breath",
    )
    Column(
        Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier
                .size(262.dp)
                .graphicsLayer {
                    scaleX = breath
                    scaleY = breath
                }
                .clip(RoundedCornerShape(30.dp)),
        ) {
            val colors = Holly.coverColors(uid ?: "?")
            Box(Modifier.fillMaxSize().background(Brush.linearGradient(colors)))
            coverBmp?.let {
                Image(
                    it.asImageBitmap(), null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

@Composable
private fun LyricPage(st: PlayerState) {
    val lyricData = remember { derivedStateOf { PlayerManager.lyrics } }.value
    val lines = lyricData?.second ?: emptyList<LyricLine>()

    if (lines.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                when {
                    lyricData?.first == null -> "加载歌词中…"
                    lyricData.second.isEmpty() -> "纯音乐，请欣赏"
                    else -> "歌词即将呈现"
                },
                color = Color.White.copy(alpha = 0.6f), fontSize = 14.sp,
            )
        }
        return
    }

    val curIdx = Lyrics.indexAt(lines, st.positionMs)
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    LaunchedEffect(curIdx) {
        if (curIdx >= 0) {
            runCatching {
                listState.animateScrollToItem(
                    index = (curIdx - 4).coerceAtLeast(0),
                    scrollOffset = 0,
                )
            }
        }
    }

    androidx.compose.foundation.lazy.LazyColumn(
        state = listState,
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 30.dp),
        verticalArrangement = Arrangement.Center,
        userScrollEnabled = true,
    ) {
        items(lines.size) { i ->
            val cur = i == curIdx
            val near = i == curIdx + 1 || i == curIdx - 1
            Text(
                lines[i].text.ifBlank { "♪" },
                color = Color.White,
                fontSize = if (cur) 18.sp else 15.sp,
                fontWeight = if (cur) FontWeight.ExtraBold else FontWeight.Normal,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .graphicsLayer { alpha = if (cur) 1f else if (near) 0.72f else 0.4f }
                    .padding(vertical = 11.dp),
            )
        }
    }
}
