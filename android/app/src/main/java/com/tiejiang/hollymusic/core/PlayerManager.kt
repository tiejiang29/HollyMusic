package com.tiejiang.hollymusic.core

import android.content.ComponentName
import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.guava.await
import kotlinx.coroutines.launch
import android.net.Uri

/** 播放队列 + 播放器状态单例，UI 与服务通过 MediaController 桥接 */
object PlayerManager {

    data class PlayerState(
        val queue: List<Song> = emptyList(),
        val index: Int = -1,
        val playing: Boolean = false,
        val buffering: Boolean = false,
        val positionMs: Long = 0,
        val durationMs: Long = 0,
        val error: String? = null,
    ) {
        val current: Song? get() = queue.getOrNull(index)
    }

    private val _state = MutableStateFlow(PlayerState())
    val state: StateFlow<PlayerState> = _state

    var lyrics: Pair<String?, List<LyricLine>>? = null
        private set

    private var controller: MediaController? = null
    private val scope = CoroutineScope(Dispatchers.Main + Job())
    private var ticker: Job? = null

    val isReady: Boolean get() = controller != null

    fun init(context: Context) {
        if (controller != null) return
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        scope.launch {
            val c = MediaController.Builder(context, token).buildAsync().await()
            controller = c
            c.addListener(object : Player.Listener {
                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    _state.value = _state.value.copy(playing = isPlaying)
                }

                override fun onPlaybackStateChanged(playbackState: Int) {
                    _state.value = _state.value.copy(
                        buffering = playbackState == Player.STATE_BUFFERING,
                        durationMs = c.duration.takeIf { it > 0 } ?: 0,
                    )
                }

                override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                    syncFromController()
                    loadLyrics()
                }

                override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                    _state.value = _state.value.copy(error = "播放失败：${error.errorCodeName}")
                }
            })
            startTicker()
            syncFromController()
        }
    }

    private fun startTicker() {
        ticker?.cancel()
        ticker = scope.launch {
            while (true) {
                controller?.let { c ->
                    if (c.isPlaying) {
                        _state.value = _state.value.copy(
                            positionMs = c.currentPosition,
                            durationMs = c.duration.takeIf { it > 0 } ?: _state.value.durationMs,
                        )
                    }
                }
                delay(500)
            }
        }
    }

    private fun syncFromController() {
        val c = controller ?: return
        _state.value = _state.value.copy(
            playing = c.isPlaying,
            buffering = c.playbackState == Player.STATE_BUFFERING,
            positionMs = c.currentPosition,
            durationMs = c.duration.takeIf { it > 0 } ?: 0,
            error = null,
        )
    }

    /** 从歌曲解析播放地址并起播（index 为点击行在 queue 中的位置） */
    fun playQueue(songs: List<Song>, index: Int) {
        _state.value = _state.value.copy(queue = songs, index = index)
        resolveAndSet(index, playNow = true)
    }

    fun playAt(index: Int) {
        _state.value = _state.value.copy(index = index)
        resolveAndSet(index, playNow = true)
    }

    fun next() {
        val s = _state.value
        if (s.index < s.queue.size - 1) playAt(s.index + 1)
        else if (s.queue.isNotEmpty()) playAt(0)
    }

    fun previous() {
        val s = _state.value
        if (s.positionMs > 3000) seekTo(0)
        else if (s.index > 0) playAt(s.index - 1)
        else if (s.queue.isNotEmpty()) playAt(s.queue.size - 1)
    }

    fun togglePlayPause() {
        val c = controller ?: return
        if (c.isPlaying) c.pause() else c.prepareAndPlay()
    }

    fun seekTo(ms: Long) {
        controller?.seekTo(ms)
        _state.value = _state.value.copy(positionMs = ms)
    }

    private fun Player.prepareAndPlay() {
        prepare()
        play()
    }

    private fun resolveAndSet(index: Int, playNow: Boolean) {
        val song = _state.value.queue.getOrNull(index) ?: return
        _state.value = _state.value.copy(buffering = true, error = null)
        // 直接播 /api/audio 代理流：服务端本地优先（音乐库→缓存→在线），Range/seek 原生支持，
        // OkHttp DataSource 与 Api 共享 CookieJar
        val url = Api.audioUrl(song.uid)
        val item = MediaItem.Builder()
            .setUri(url)
            .setMediaId(song.uid)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(song.name)
                    .setArtist(song.singer)
                    .setAlbumTitle(song.albumName)
                    .setArtworkUri(Uri.parse(Api.coverUrl(song.uid)))
                    .build()
            )
            .build()
        val c = controller ?: return
        c.setMediaItem(item)
        if (playNow) c.prepareAndPlay() else c.prepare()
    }

    private fun loadLyrics() {
        val song = _state.value.current ?: run { lyrics = null; return }
        lyrics = song.uid to emptyList()
        scope.launch {
            val lrc = Api.lyrics(song.uid)
            if (_state.value.current?.uid == song.uid) {
                lyrics = lrc to Lyrics.parse(lrc)
            }
        }
    }

    fun release() {
        ticker?.cancel()
        controller?.release()
        controller = null
    }
}
