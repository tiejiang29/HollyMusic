package com.tiejiang.hollymusic.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tiejiang.hollymusic.core.Api
import com.tiejiang.hollymusic.core.PlayerManager
import com.tiejiang.hollymusic.core.Song
import com.tiejiang.hollymusic.core.SuggestItem
import com.tiejiang.hollymusic.ui.components.HollyChip
import com.tiejiang.hollymusic.ui.components.SongRow
import com.tiejiang.hollymusic.ui.theme.Holly
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private val SOURCES = listOf(
    "kw" to "酷我", "tx" to "企鹅", "wy" to "网易", "kg" to "酷狗", "mg" to "咪咕",
)

@Composable
fun SearchScreen(onBack: () -> Unit) {
    var keyword by remember { mutableStateOf("") }
    var source by remember { mutableStateOf("kw") }
    var results by remember { mutableStateOf<List<Song>>(emptyList()) }
    var total by remember { mutableStateOf(0) }
    var suggests by remember { mutableStateOf<List<SuggestItem>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var searched by remember { mutableStateOf(false) }
    var searchJob by remember { mutableStateOf<Job?>(null) }
    val scope = rememberCoroutineScope()
    val player = PlayerManager.state.collectAsState().value
    val focus = remember { FocusRequester() }

    fun doSearch(kw: String = keyword) {
        if (kw.isBlank()) return
        keyword = kw
        searchJob?.cancel()
        scope.launch {
            searching = true
            suggests = emptyList()
            runCatching { Api.search(source, kw) }
                .onSuccess { (list, t) -> results = list; total = t; searched = true }
            searching = false
        }
    }

    LaunchedEffect(Unit) { focus.requestFocus() }

    // 联想防抖
    LaunchedEffect(keyword) {
        if (keyword.isBlank() || searched) return@LaunchedEffect
        delay(250)
        suggests = runCatching { Api.suggest(keyword) }.getOrDefault(emptyList())
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(Holly.bg)
            .statusBarsPadding()
            .imePadding()
    ) {
        // 搜索框行
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(
                shape = CircleShape, color = Color.White, shadowElevation = 2.dp,
                modifier = Modifier
                    .weight(1f)
                    .height(46.dp),
            ) {
                OutlinedTextField(
                    value = keyword,
                    onValueChange = {
                        keyword = it
                        searched = false
                    },
                    placeholder = { Text("搜索歌曲、歌手、专辑", fontSize = 13.5.sp, color = Holly.txt3) },
                    leadingIcon = { Icon(Icons.Filled.Search, null, tint = Holly.txt3) },
                    trailingIcon = {
                        if (keyword.isNotEmpty()) IconButton(onClick = { keyword = ""; results = emptyList(); suggests = emptyList() }) {
                            Icon(Icons.Filled.Close, "清空", tint = Holly.txt3)
                        }
                    },
                    singleLine = true,
                    shape = CircleShape,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                    keyboardActions = KeyboardActions(onSearch = { doSearch() }),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = Color.Transparent,
                        unfocusedBorderColor = Color.Transparent,
                        focusedContainerColor = Color.White,
                        unfocusedContainerColor = Color.White,
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focus),
                )
            }
            Spacer(Modifier.width(12.dp))
            Text(
                if (searched) "完成" else "搜索",
                color = Holly.green, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .clip(CircleShape)
                    .clickable { if (searched) onBack() else doSearch() }
                    .padding(4.dp),
            )
        }

        // 音源筛选
        LazyRow(
            Modifier.padding(horizontal = 18.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(SOURCES) { (id, name) ->
                HollyChip(name, source == id) {
                    source = id
                    if (searched) doSearch()
                }
            }
        }

        // 联想下拉
        if (!searched && suggests.isNotEmpty()) {
            Surface(
                shape = RoundedCornerShape(18.dp), color = Color.White, shadowElevation = 2.dp,
                modifier = Modifier
                    .padding(horizontal = 18.dp, vertical = 10.dp)
                    .fillMaxWidth(),
            ) {
                Column {
                    suggests.take(8).forEach { s ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable { doSearch(s.text.substringBefore(" - ")) }
                                .padding(horizontal = 16.dp, vertical = 11.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                Icons.Filled.History, null, tint = Holly.txt3,
                                modifier = Modifier.size(15.dp),
                            )
                            Text(
                                "  ${s.text}", fontSize = 13.5.sp,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            Spacer(Modifier.weight(1f))
                            Surface(shape = RoundedCornerShape(5.dp), color = Holly.divider) {
                                Text(
                                    when (s.type) { "singer" -> "歌手"; "album" -> "专辑"; else -> "歌曲" },
                                    fontSize = 9.sp, color = Holly.txt3,
                                    modifier = Modifier.padding(horizontal = 5.dp, vertical = 2.dp),
                                )
                            }
                        }
                    }
                }
            }
        }

        if (searched) {
            Text(
                "共 $total 条结果", fontSize = 11.sp, color = Holly.txt3,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }

        LazyColumn {
            if (searching) {
                item { Text("搜索中…", fontSize = 13.sp, color = Holly.txt3, modifier = Modifier.padding(18.dp)) }
            }
            itemsIndexed(results) { i, s ->
                SongRow(
                    song = s,
                    isCurrent = player.current?.uid == s.uid,
                    isPlaying = player.playing,
                    onPlay = { PlayerManager.playQueue(results, i) },
                )
            }
        }
    }
}
