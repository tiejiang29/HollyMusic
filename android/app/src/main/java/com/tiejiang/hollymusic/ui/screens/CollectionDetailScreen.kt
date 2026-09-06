package com.tiejiang.hollymusic.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tiejiang.hollymusic.core.Api
import com.tiejiang.hollymusic.core.CollectionDetail
import com.tiejiang.hollymusic.core.PlayerManager
import com.tiejiang.hollymusic.ui.components.SongRow
import com.tiejiang.hollymusic.ui.theme.Holly
import kotlinx.coroutines.launch

/** 榜单 / 歌单 详情页（tracks 列表 + 播放全部） */
@Composable
fun CollectionDetailScreen(kind: String, id: String, source: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var detail by remember { mutableStateOf<CollectionDetail?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    val player = PlayerManager.state.collectAsState().value

    LaunchedEffect(id) {
        scope.launch {
            runCatching {
                if (kind == "toplist") Api.toplistDetail(id, source) else Api.playlistDetail(id, source)
            }.onSuccess { detail = it }
                .onFailure { err = "加载失败：${it.message}" }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(Holly.bg)
            .statusBarsPadding()
    ) {
        Row(
            Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(shape = CircleShape, color = Color.White, shadowElevation = 2.dp) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = Holly.txt,
                    modifier = Modifier
                        .clickable(onClick = onBack)
                        .padding(9.dp)
                        .size(20.dp),
                )
            }
            Spacer(Modifier.width(14.dp))
            Text(detail?.name ?: "加载中…", fontSize = 20.sp, fontWeight = FontWeight.ExtraBold)
        }

        val d = detail
        when {
            err != null -> Text(err!!, color = Holly.danger, fontSize = 13.sp, modifier = Modifier.padding(18.dp))
            d == null -> Text("加载中…", fontSize = 13.sp, color = Holly.txt3, modifier = Modifier.padding(18.dp))
            else -> {
                Row(
                    Modifier
                        .padding(horizontal = 18.dp)
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(20.dp))
                        .background(Holly.grad)
                        .clickable { if (d.tracks.isNotEmpty()) PlayerManager.playQueue(d.tracks, 0) }
                        .padding(vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "▶ 播放全部",
                        color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(start = 18.dp),
                    )
                    Text("（${d.tracks.size} 首）", color = Color.White.copy(alpha = 0.8f), fontSize = 12.sp)
                }
                LazyColumn(Modifier.padding(top = 6.dp)) {
                    itemsIndexed(d.tracks) { i, s ->
                        SongRow(
                            song = s,
                            isCurrent = player.current?.uid == s.uid,
                            isPlaying = player.playing,
                            onPlay = { PlayerManager.playQueue(d.tracks, i) },
                        )
                    }
                }
            }
        }
    }
}
