package com.tiejiang.hollymusic.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

@Serializable
data class ApiEnvelope(
    val success: Boolean = false,
    val data: kotlinx.serialization.json.JsonElement? = null,
    val error: ApiError? = null,
)

@Serializable
data class ApiError(val code: String = "", val message: String = "")

class ApiException(val code: String, message: String) : Exception(message)

/** HollyMusic 服务端 API 客户端：Cookie 认证 + 统一 {success,data} 响应 */
object Api {

    val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private val cookieStore = mutableMapOf<String, List<Cookie>>()

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .addNetworkInterceptor { chain ->
            val req = chain.request()
            if (com.tiejiang.hollymusic.BuildConfig.DEBUG) {
                android.util.Log.d("HollyApi", "→(wire) ${req.method} ${req.url.encodedPath} Cookie=[${req.header("Cookie") ?: "无"}]")
            }
            val resp = chain.proceed(req)
            if (com.tiejiang.hollymusic.BuildConfig.DEBUG) {
                android.util.Log.d("HollyApi", "←(wire) ${resp.code} ${req.url.encodedPath}")
            }
            resp
        }
        .cookieJar(object : CookieJar {
            override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
                synchronized(cookieStore) {
                    val kept = (cookieStore[url.host] ?: emptyList()).filter { old ->
                        cookies.none { it.name == old.name }
                    }
                    cookieStore[url.host] = kept + cookies.filter { it.name.startsWith("holly_") || it.persistent }
                }
            }

            override fun loadForRequest(url: HttpUrl): List<Cookie> =
                synchronized(cookieStore) { cookieStore[url.host].orEmpty() }
        })
        .build()

    fun baseUrl(): String = Settings.cachedServer.trimEnd('/')

    fun absolutize(url: String): String =
        if (url.startsWith("http")) url else baseUrl() + url

    fun coverUrl(uid: String): String = "${baseUrl()}/api/cover/${uid.replace("al-", "")}"

    fun restoreCookies(server: String, user: String, sv: String, sig: String) {
        val host = (if (server.startsWith("http")) server else "http://$server")
            .toHttpUrlOrNull()?.host ?: return
        synchronized(cookieStore) {
            cookieStore[host] = listOf(
                Cookie.Builder().name("holly_user").value(user).domain(host).path("/").build(),
                Cookie.Builder().name("holly_sv").value(sv).domain(host).path("/").build(),
                Cookie.Builder().name("holly_sig").value(sig).domain(host).path("/").build(),
            )
        }
    }

    fun clearCookies() = synchronized(cookieStore) { cookieStore.clear() }

    /** 取当前会话三件套（user, sv, sig)，用于持久化 */
    fun cookieSnapshot(server: String = Settings.cachedServer): Triple<String, String, String>? {
        val host = server.toHttpUrlOrNull()?.host ?: return null
        val list = synchronized(cookieStore) { cookieStore[host] }.orEmpty()
        val user = list.firstOrNull { it.name == "holly_user" }?.value ?: return null
        val sv = list.firstOrNull { it.name == "holly_sv" }?.value ?: return null
        val sig = list.firstOrNull { it.name == "holly_sig" }?.value ?: return null
        return Triple(user, sv, sig)
    }

    private suspend fun rawCall(request: Request): String = withContext(Dispatchers.IO) {
        suspendCancellableCoroutine { cont ->
            http.newCall(request).apply {
                cont.invokeOnCancellation { cancel() }
                enqueue(object : okhttp3.Callback {
                    override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                        if (cont.isActive) cont.resumeWithException(e)
                    }

                    override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                        response.use {
                            val body = it.body?.string().orEmpty()
                            if (cont.isActive) cont.resume(body)
                        }
                    }
                })
            }
        }
    }

    /** 请求并解析统一响应外层，返回 data 的 JSON 原文 */
    private suspend fun call(request: Request): String {
        val body = rawCall(request)
        val env = runCatching { json.decodeFromString(ApiEnvelope.serializer(), body) }
            .getOrElse { throw ApiException("PARSE", "响应解析失败: ${body.take(80)}") }
        if (!env.success) throw ApiException(env.error?.code ?: "UNKNOWN", env.error?.message ?: "请求失败")
        return env.data?.toString() ?: "null"
    }

    private fun node(raw: String): JsonObject =
        (json.parseToJsonElement(raw) as? JsonObject) ?: JsonObject(emptyMap())

    private fun str(o: JsonObject, key: String): String =
        (o[key] as? JsonPrimitive)?.contentOrNullSafe() ?: ""

    private fun int(o: JsonObject, key: String): Int =
        (o[key] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0

    private fun optStr(o: JsonObject, key: String): String? =
        (o[key] as? JsonPrimitive)?.contentOrNullSafe()

    private fun JsonPrimitive.contentOrNullSafe(): String? = if (isString) content else content

    private fun <T> decode(s: KSerializer<T>, raw: String): T = json.decodeFromString(s, raw)

    // ───────────────────────── 业务接口 ─────────────────────────

    /** 启动会话校验：cookie 有效返回用户名，失败抛异常 */
    suspend fun authMe(): String {
        val req = Request.Builder().url("${baseUrl()}/api/auth/me").get().build()
        val obj = node(call(req))
        return str(obj, "username")
    }

    /** 音频流地址（服务端本地优先：音乐库→缓存→在线；支持 Range/seek） */
    fun audioUrl(uid: String, quality: String = Settings.cachedQuality): String =
        "${baseUrl()}/api/audio?uid=${encode(uid)}&quality=${encode(quality)}"

    suspend fun login(serverRaw: String, username: String, password: String) {
        val server = serverRaw.trim().trimEnd('/')
        if (server.toHttpUrlOrNull() == null) throw ApiException("URL", "服务器地址无效")
        Settings.cachedServer = server
        val body = """{"username":${json.encodeToString(String.serializer(), username)},"password":${json.encodeToString(String.serializer(), password)}}"""
        val req = Request.Builder()
            .url("$server/api/auth/login")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        call(req)
        if (cookieSnapshot(server) == null) throw ApiException("COOKIE", "登录成功但未收到会话")
    }

    suspend fun search(source: String, keyword: String, page: Int = 1, limit: Int = 30): Pair<List<Song>, Int> {
        val req = Request.Builder().url(
            "${baseUrl()}/api/search?source=$source&keyword=${encode(keyword)}&page=$page&limit=$limit"
        ).get().build()
        val raw = call(req)
        val obj = node(raw)
        val listJson = obj["list"] ?: return emptyList<Song>() to 0
        val list = json.decodeFromJsonElement(ListSerializer(Song.serializer()), listJson)
        return list to int(obj, "total")
    }

    suspend fun suggest(keyword: String): List<SuggestItem> {
        val req = Request.Builder().url("${baseUrl()}/api/search/suggest?keyword=${encode(keyword)}").get().build()
        return runCatching { decode(ListSerializer(SuggestItem.serializer()), call(req)) }.getOrDefault(emptyList())
    }

    suspend fun musicUrl(song: Song, quality: String = Settings.cachedQuality): String {
        val mi = mapOf(
            "name" to song.name, "singer" to song.singer, "source" to song.source,
            "songmid" to song.songmid, "albumName" to (song.albumName ?: ""),
            "interval" to song.interval,
        )
        val jsonBody = """{"musicInfo":${json.encodeToString(
            MapSerializer(String.serializer(), String.serializer()), mi
        )},"quality":${json.encodeToString(String.serializer(), quality)}}"""
        val req = Request.Builder()
            .url("${baseUrl()}/api/music-url")
            .post(jsonBody.toRequestBody("application/json".toMediaType()))
            .build()
        val url = str(node(call(req)), "url")
        if (url.isBlank()) throw ApiException("URL", "获取播放链接失败")
        return absolutize(url)
    }

    suspend fun lyrics(uid: String): String? {
        val req = Request.Builder().url("${baseUrl()}/api/lyrics?id=${encode(uid)}").get().build()
        return runCatching { optStr(node(call(req)), "lyric") }.getOrNull()
    }

    suspend fun toplists(scope: String = "full", source: String = "tx"): List<DiscoveryToplist> {
        val req = Request.Builder().url("${baseUrl()}/api/discover/toplists?scope=$scope&source=$source").get().build()
        return decode(ListSerializer(DiscoveryToplist.serializer()), call(req))
    }

    suspend fun toplistDetail(id: String, source: String = "tx"): CollectionDetail {
        val req = Request.Builder().url("${baseUrl()}/api/discover/toplists/$id?source=$source").get().build()
        return decode(CollectionDetail.serializer(), call(req))
    }

    suspend fun playlists(source: String = "tx"): List<DiscoveryPlaylist> {
        val req = Request.Builder().url("${baseUrl()}/api/discover/playlists?source=$source&limit=12").get().build()
        return runCatching { decode(ListSerializer(DiscoveryPlaylist.serializer()), call(req)) }.getOrDefault(emptyList())
    }

    suspend fun playlistDetail(id: String, source: String = "tx"): CollectionDetail {
        val req = Request.Builder().url("${baseUrl()}/api/discover/playlists/$id?source=$source").get().build()
        return decode(CollectionDetail.serializer(), call(req))
    }

    suspend fun favorites(): List<Song> {
        val req = Request.Builder().url("${baseUrl()}/api/favorites?limit=500").get().build()
        val raw = call(req)
        val listJson = node(raw)["list"] ?: return emptyList()
        val list = json.decodeFromJsonElement(ListSerializer(FavoriteSong.serializer()), listJson)
        return list.mapNotNull { f -> f.musicInfo?.let { it.copy(uid = f.songId) } }
    }

    suspend fun addFavorite(uid: String) {
        val req = Request.Builder().url("${baseUrl()}/api/favorites")
            .post("""{"id":${json.encodeToString(String.serializer(), uid)}}""".toRequestBody("application/json".toMediaType()))
            .build()
        call(req)
    }

    suspend fun removeFavorite(uid: String) {
        val req = Request.Builder().url("${baseUrl()}/api/favorites?id=${encode(uid)}").delete().build()
        call(req)
    }

    private fun encode(s: String) = java.net.URLEncoder.encode(s, "UTF-8")
}
