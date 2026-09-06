package com.tiejiang.hollymusic.core

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking

private val Context.dataStore by preferencesDataStore(name = "holly_settings")

/** 应用本地配置（服务器地址 / 登录态 Cookie 持久化） */
object Settings {
    private val KEY_SERVER = stringPreferencesKey("server_url")
    private val KEY_USERNAME = stringPreferencesKey("username")
    private val KEY_COOKIE_USER = stringPreferencesKey("cookie_holly_user")
    private val KEY_COOKIE_SIG = stringPreferencesKey("cookie_holly_sig")
    private val KEY_QUALITY = stringPreferencesKey("quality")

    var cachedServer: String = ""
    var cachedUsername: String = ""
    var cachedQuality: String = "flac"

    fun load(ctx: Context) = runBlocking {
        val p = ctx.dataStore.data.first()
        cachedServer = p[KEY_SERVER] ?: ""
        cachedUsername = p[KEY_USERNAME] ?: ""
        cachedQuality = p[KEY_QUALITY] ?: "flac"
        val user = p[KEY_COOKIE_USER]
        val sig = p[KEY_COOKIE_SIG]
        if (!cachedServer.isBlank() && !user.isNullOrBlank() && !sig.isNullOrBlank()) {
            Api.restoreCookies(cachedServer, user, sig)
        }
    }

    /** 登录成功后保存全部状态 */
    fun saveLogin(ctx: Context, server: String, username: String, user: String, sig: String) {
        cachedServer = server
        cachedUsername = username
        runBlocking {
            ctx.dataStore.edit {
                it[KEY_SERVER] = server
                it[KEY_USERNAME] = username
                it[KEY_COOKIE_USER] = user
                it[KEY_COOKIE_SIG] = sig
            }
        }
    }

    fun saveQuality(ctx: Context, quality: String) {
        cachedQuality = quality
        runBlocking {
            ctx.dataStore.edit { it[KEY_QUALITY] = quality }
        }
    }

    fun logout(ctx: Context) {
        runBlocking {
            ctx.dataStore.edit {
                it.remove(KEY_COOKIE_USER)
                it.remove(KEY_COOKIE_SIG)
            }
        }
        Api.clearCookies()
    }
}
