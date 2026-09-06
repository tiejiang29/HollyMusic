package com.tiejiang.hollymusic.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tiejiang.hollymusic.core.Api
import com.tiejiang.hollymusic.core.PlayerManager
import com.tiejiang.hollymusic.core.Song
import com.tiejiang.hollymusic.core.Settings
import com.tiejiang.hollymusic.ui.components.HollyChip
import com.tiejiang.hollymusic.ui.components.HollyCover
import com.tiejiang.hollymusic.ui.components.MiniPlayer
import com.tiejiang.hollymusic.ui.components.SectionHeader
import com.tiejiang.hollymusic.ui.components.SongRow
import com.tiejiang.hollymusic.ui.theme.Holly
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private enum class HomeTab(val label: String) { REC("推荐"), LIB("音乐库"), TOP("排行榜"), FAV("收藏") }
private enum class MainTab(val label: String) { HOME("首页"), MINE("我的") }

@Composable
fun MainScreen(
    onOpenSearch: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenPlayer: () -> Unit,
    onOpenToplist: (String, String) -> Unit,
    onOpenPlaylist: (String, String) -> Unit,
) {
    var tab by remember { mutableStateOf(MainTab.HOME) }
    val player = PlayerManager.state.collectAsState().value

    Column(Modifier.fillMaxSize().background(Holly.bg).statusBarsPadding()) {
        Box(Modifier.weight(1f)) {
            when (tab) {
                MainTab.HOME -> HomeContent(onOpenSearch, onOpenToplist, onOpenPlaylist)
                MainTab.MINE -> MineContent(onOpenSearch, onOpenSettings, onOpenPlayer)
            }
        }
        MiniPlayer(st = player, onClick = onOpenPlayer)
        Spacer(Modifier.height(6.dp))
        BottomTabs(tab) { tab = it }
    }
}

@Composable
private fun BottomTabs(current: MainTab, onSelect: (MainTab) -> Unit) {
    Surface(
        shape = RoundedCornerShape(topStart = 26.dp, topEnd = 26.dp),
        color = Color.White,
        shadowElevation = 12.dp,
    ) {
        Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
            BottomTabItem(Icons.Outlined.Home, Icons.Filled.Home, "首页", current == MainTab.HOME, Modifier.weight(1f)) { onSelect(MainTab.HOME) }
            BottomTabItem(Icons.Outlined.Person, Icons.Filled.Person, "我的", current == MainTab.MINE, Modifier.weight(1f)) { onSelect(MainTab.MINE) }
        }
    }
}

@Composable
private fun BottomTabItem(
    outline: ImageVector,
    filled: ImageVector,
    label: String,
    selected: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Column(
        modifier
            .clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(if (selected) filled else outline, label, tint = if (selected) Holly.txt else Color(0xFFA9AFC0))
        Text(
            label, fontSize = 11.sp,
            color = if (selected) Holly.txt else Color(0xFFA9AFC0),
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        )
    }
}

// ───────────────────────── 首页 ─────────────────────────

@Composable
private fun HomeContent(
    onOpenSearch: () -> Unit,
    onOpenToplist: (String, String) -> Unit,
    onOpenPlaylist: (String, String) -> Unit,
) {
    var channel by remember { mutableStateOf(HomeTab.REC) }
    val player = PlayerManager.state.collectAsState().value

    Column {
        // 顶部频道
        Row(
            Modifier.padding(horizontal = 20.dp, vertical = 14.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            HomeTab.entries.forEach { t ->
                val on = channel == t
                Text(
                    t.label + if (t == HomeTab.FAV) "" else "",
                    fontSize = if (on) 19.sp else 16.sp,
                    fontWeight = if (on) FontWeight.ExtraBold else FontWeight.Medium,
                    color = if (on) Holly.txt else Color(0xFF8A919F),
                    modifier = Modifier
                        .padding(end = 26.dp)
                        .clickable { channel = t },
                )
            }
        }
        // 搜索框
        SearchPill(onOpenSearch)
        when (channel) {
            HomeTab.REC -> RecommendChannel(onOpenToplist, onOpenPlaylist)
            HomeTab.LIB -> LibraryChannel()
            HomeTab.TOP -> ToplistChannel(onOpenToplist)
            HomeTab.FAV -> FavoriteChannel()
        }
    }
}

@Composable
private fun SearchPill(onOpenSearch: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 18.dp, vertical = 6.dp)
            .height(44.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Surface(
            shape = CircleShape, color = Color.White, shadowElevation = 2.dp,
            modifier = Modifier
                .weight(1f)
                .clip(CircleShape)
                .clickable(onClick = onOpenSearch),
        ) {
            Row(
                Modifier.padding(horizontal = 15.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(20.dp)
                        .clip(CircleShape)
                        .background(
                            Brush.sweepGradient(
                                listOf(Holly.greenLt, Holly.blue, Holly.orange, Holly.greenLt)
                            )
                        )
                )
                Text(
                    "  搜索歌曲、歌手、专辑",
                    fontSize = 13.5.sp, color = Color(0xFFA9AFC0),
                    modifier = Modifier.padding(start = 9.dp),
                )
                Spacer(Modifier.weight(1f))
            }
        }
        Spacer(Modifier.width(12.dp))
        Box(
            Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(Holly.grad)
                .clickable(onClick = onOpenSearch),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Search, null, tint = Color.White)
        }
    }
}

/** 频道：推荐 = 精选榜卡 + 推荐歌单横滑 */
@Composable
private fun RecommendChannel(
    onOpenToplist: (String, String) -> Unit,
    onOpenPlaylist: (String, String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var toplists by remember { mutableStateOf(listOf<com.tiejiang.hollymusic.core.DiscoveryToplist>()) }
    var playlists by remember { mutableStateOf(listOf<com.tiejiang.hollymusic.core.DiscoveryPlaylist>()) }
    var loading by remember { mutableStateOf(true) }

    androidx.compose.runtime.LaunchedEffect(Unit) {
        scope.launch {
            toplists = runCatching { Api.toplists("common") }.getOrDefault(emptyList())
            playlists = runCatching { Api.playlists() }.getOrDefault(emptyList())
            loading = false
        }
    }

    LazyColumn(Modifier.fillMaxSize()) {
        item {
            LazyRow(
                Modifier.padding(horizontal = 18.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(13.dp),
            ) {
                items(toplists.take(6)) { t ->
                    Column(
                        Modifier
                            .width(200.dp)
                            .clip(RoundedCornerShape(20.dp))
                            .background(Color.White)
                            .clickable { onOpenToplist(t.id, t.source) },
                    ) {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .height(110.dp)
                                .background(Holly.gradBlue),
                            contentAlignment = Alignment.Center,
                        ) {
                            Column(Modifier.padding(16.dp)) {
                                Text(t.name, color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(
                                    t.description.ifBlank { "热门榜单" },
                                    color = Color.White.copy(alpha = 0.85f), fontSize = 11.sp,
                                    maxLines = 2, overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.padding(top = 6.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
        item {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 18.dp, end = 18.dp, top = 14.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("推荐歌单", fontSize = 17.sp, fontWeight = FontWeight.ExtraBold)
            }
        }
        item {
            LazyRow(
                Modifier.padding(horizontal = 18.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(playlists) { p ->
                    Column(
                        Modifier
                            .width(118.dp)
                            .clickable { onOpenPlaylist(p.id, p.source) },
                    ) {
                        HollyCover(
                            uid = "al-${p.id}",
                            modifier = Modifier.size(118.dp),
                            shape = RoundedCornerShape(16.dp),
                        )
                        Text(
                            p.name, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(top = 8.dp),
                        )
                    }
                }
            }
        }
    }
}

/** 频道：音乐库 = 搜索（歌名/歌手/拼音首字母）+ 歌手索引 chips + 歌曲列表（服务端边听边下库） */
@Composable
private fun LibraryChannel() {
    val scope = rememberCoroutineScope()
    var keyword by remember { mutableStateOf("") }
    var selectedSinger by remember { mutableStateOf("") }
    var songs by remember { mutableStateOf<List<Song>>(emptyList()) }
    var total by remember { mutableStateOf(0) }
    var singerGroups by remember { mutableStateOf<List<com.tiejiang.hollymusic.core.SingerGroup>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }

    // 搜索/选歌手 → 300ms 防抖请求（singerGroups 只在无筛选时刷新，避免选项跳变）
    androidx.compose.runtime.LaunchedEffect(keyword, selectedSinger) {
        delay(300)
        runCatching { Api.library(keyword = keyword.trim(), singer = selectedSinger) }
            .onSuccess { r ->
                songs = r.list
                total = r.total
                if (keyword.isBlank() && selectedSinger.isBlank()) singerGroups = r.singerGroups
            }
        loaded = true
    }

    Column {
        // 歌手搜索框
        Surface(
            shape = androidx.compose.foundation.shape.CircleShape,
            color = Color.White, shadowElevation = 2.dp,
            modifier = Modifier
                .padding(horizontal = 18.dp, vertical = 8.dp)
                .fillMaxWidth()
                .heightIn(min = 46.dp),
        ) {
            androidx.compose.material3.OutlinedTextField(
                value = keyword,
                onValueChange = { keyword = it },
                placeholder = { Text("搜索歌名 / 歌手 / 拼音首字母", fontSize = 13.sp, color = Holly.txt3) },
                leadingIcon = { Icon(Icons.Filled.Search, null, tint = Holly.txt3) },
                trailingIcon = {
                    if (keyword.isNotEmpty()) {
                        IconButton(onClick = { keyword = "" }) {
                            Icon(Icons.Filled.Close, "清空", tint = Holly.txt3)
                        }
                    }
                },
                singleLine = true,
                shape = androidx.compose.foundation.shape.CircleShape,
                colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = Color.Transparent,
                    unfocusedBorderColor = Color.Transparent,
                    focusedContainerColor = Color.White,
                    unfocusedContainerColor = Color.White,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        // 歌手索引 chips
        if (singerGroups.isNotEmpty()) {
            LazyRow(
                Modifier.padding(horizontal = 18.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item { HollyChip("全部 ${singerGroups.sumOf { it.count }}", selectedSinger.isBlank()) { selectedSinger = "" } }
                items(singerGroups) { g ->
                    HollyChip("${g.singer} ${g.count}", selectedSinger == g.singer) { selectedSinger = g.singer }
                }
            }
        }
        Text(
            buildString {
                if (selectedSinger.isNotBlank()) append("$selectedSinger · ")
                append("${songs.size}")
                if (total > songs.size) append("/$total")
                append(" 首")
            },
            fontSize = 11.sp, color = Holly.txt3,
            modifier = Modifier.padding(start = 20.dp, top = 8.dp, bottom = 4.dp),
        )
        LazyColumn {
            if (loaded && songs.isEmpty()) {
                item {
                    Text(
                        if (keyword.isBlank() && selectedSinger.isBlank()) "音乐库还是空的，播放过的歌会自动入库"
                        else "没有匹配的歌曲",
                        fontSize = 13.sp, color = Holly.txt3,
                        modifier = Modifier.padding(18.dp),
                    )
                }
            }
            itemsIndexed(songs) { i, s ->
                val st = PlayerManager.state.collectAsState().value
                SongRow(
                    song = s,
                    isCurrent = st.current?.uid == s.uid,
                    isPlaying = st.playing,
                    onPlay = { PlayerManager.playQueue(songs, i) },
                )
            }
        }
    }
}

@Composable
private fun QuickCard(
    title: String, count: String, brush: Brush, modifier: Modifier = Modifier, onClick: () -> Unit,
) {
    Column(
        modifier
            .clip(RoundedCornerShape(20.dp))
            .background(brush)
            .clickable(onClick = onClick)
            .padding(vertical = 15.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, color = Color.White, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
        Text(count, color = Color.White.copy(alpha = 0.75f), fontSize = 10.sp)
    }
}

/** 频道：排行榜 = 分类 + 榜单网格 */
@Composable
private fun ToplistChannel(onOpenToplist: (String, String) -> Unit) {
    val scope = rememberCoroutineScope()
    var lists by remember { mutableStateOf(listOf<com.tiejiang.hollymusic.core.DiscoveryToplist>()) }
    var loading by remember { mutableStateOf(true) }

    androidx.compose.runtime.LaunchedEffect(Unit) {
        scope.launch {
            lists = runCatching { Api.toplists("full") }.getOrDefault(emptyList())
            loading = false
        }
    }

    LazyColumn {
        item {
            LazyRow(
                Modifier.padding(horizontal = 18.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                item { HollyChip("官方榜", true) {} }
            }
        }
        if (loading) {
            item { Text("加载榜单中…", fontSize = 13.sp, color = Holly.txt3, modifier = Modifier.padding(18.dp)) }
        }
        itemsIndexed(lists) { i, t ->
            ToplistCard(t, hero = i == 0, onClick = { onOpenToplist(t.id, t.source) })
        }
    }
}

@Composable
private fun ToplistCard(t: com.tiejiang.hollymusic.core.DiscoveryToplist, hero: Boolean, onClick: () -> Unit) {
    Column(
        Modifier
            .padding(
                start = if (hero) 18.dp else 0.dp,
                end = 18.dp, top = 8.dp,
            )
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(if (hero) Brush.linearGradient(listOf(Color(0xFF20303F), Color(0xFF3A5468))) else Brush.linearGradient(listOf(Color.White, Color.White)))
            .clickable(onClick = onClick)
            .padding(17.dp),
    ) {
        Text(
            t.name,
            color = if (hero) Color.White else Holly.txt,
            fontSize = if (hero) 17.sp else 15.sp, fontWeight = FontWeight.Bold,
        )
        Text(
            t.description.ifBlank { "更新中" },
            color = if (hero) Color.White.copy(alpha = 0.7f) else Holly.txt2,
            fontSize = 11.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

/** 频道：收藏 = 全量收藏列表 */
@Composable
private fun FavoriteChannel() {
    val scope = rememberCoroutineScope()
    var favs by remember { mutableStateOf<List<Song>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }

    androidx.compose.runtime.LaunchedEffect(Unit) {
        scope.launch {
            favs = runCatching { Api.favorites() }.getOrDefault(emptyList())
            loaded = true
        }
    }

    LazyColumn {
        item { SectionHeader("已收藏 ${favs.size} 首") }
        if (loaded && favs.isEmpty()) {
            item {
                Text("暂无收藏", fontSize = 13.sp, color = Holly.txt3, modifier = Modifier.padding(18.dp))
            }
        }
        itemsIndexed(favs) { i, s ->
            val st = PlayerManager.state.collectAsState().value
            SongRow(
                song = s,
                isCurrent = st.current?.uid == s.uid,
                isPlaying = st.playing,
                onPlay = { PlayerManager.playQueue(favs, i) },
            )
        }
    }
}

// ───────────────────────── 我的 ─────────────────────────

@Composable
private fun MineContent(onOpenSearch: () -> Unit, onOpenSettings: () -> Unit, onOpenPlayer: () -> Unit) {
    val scope = rememberCoroutineScope()
    var favCount by remember { mutableStateOf(0) }

    androidx.compose.runtime.LaunchedEffect(Unit) {
        scope.launch {
            favCount = runCatching { Api.favorites() }.getOrDefault(emptyList()).size
        }
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 18.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text("我的", fontSize = 25.sp, fontWeight = FontWeight.ExtraBold)
                Box(
                    Modifier
                        .padding(top = 4.dp)
                        .size(width = 34.dp, height = 4.dp)
                        .clip(CircleShape)
                        .background(Holly.grad)
                )
            }
            Spacer(Modifier.weight(1f))
            Surface(shape = RoundedCornerShape(14.dp), color = Color.White, shadowElevation = 2.dp) {
                IconButton(onClick = onOpenSettings) {
                    Icon(Icons.Filled.Settings, "设置", tint = Color(0xFF4A5263))
                }
            }
        }

        LazyColumn {
            item {
                // 用户卡
                Surface(
                    shape = RoundedCornerShape(22.dp), color = Color.White, shadowElevation = 3.dp,
                    modifier = Modifier
                        .padding(horizontal = 18.dp)
                        .fillMaxWidth(),
                ) {
                    Column(Modifier.padding(18.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                Modifier
                                    .size(56.dp)
                                    .clip(CircleShape)
                                    .background(
                                        Brush.sweepGradient(
                                            listOf(Color(0xFFF5C754), Color(0xFFF09FB2), Holly.greenLt, Holly.blue, Color(0xFFF5C754))
                                        )
                                    ),
                                contentAlignment = Alignment.Center,
                            ) {
                                Box(
                                    Modifier
                                        .size(48.dp)
                                        .clip(CircleShape)
                                        .background(Brush.linearGradient(listOf(Holly.orangeLt, Holly.orange))),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        Settings.cachedUsername.take(1).uppercase().ifBlank { "H" },
                                        color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 20.sp,
                                    )
                                }
                            }
                            Spacer(Modifier.width(14.dp))
                            Column(Modifier.weight(1f)) {
                                Text(Settings.cachedUsername.ifBlank { "未登录" }, fontSize = 19.sp, fontWeight = FontWeight.ExtraBold)
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.padding(top = 5.dp),
                                ) {
                                    Box(Modifier.size(6.dp).clip(CircleShape).background(Holly.green))
                                    Text(
                                        "  已连接 · ${Settings.cachedServer.removePrefix("http://").removePrefix("https://")}",
                                        fontSize = 11.5.sp, color = Holly.txt2,
                                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text("$favCount", fontSize = 22.sp, fontWeight = FontWeight.ExtraBold)
                                Text("收藏", fontSize = 10.5.sp, color = Holly.txt2)
                            }
                        }
                    }
                }
            }
        }
    }
}
