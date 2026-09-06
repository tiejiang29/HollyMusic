package com.tiejiang.hollymusic.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.tiejiang.hollymusic.core.Api
import com.tiejiang.hollymusic.core.Settings
import com.tiejiang.hollymusic.ui.screens.CollectionDetailScreen
import com.tiejiang.hollymusic.ui.screens.LoginScreen
import com.tiejiang.hollymusic.ui.screens.MainScreen
import com.tiejiang.hollymusic.ui.screens.PlayerScreen
import com.tiejiang.hollymusic.ui.screens.SearchScreen
import com.tiejiang.hollymusic.ui.screens.SettingsScreen

object Routes {
    const val LOGIN = "login"
    const val MAIN = "main"
    const val SEARCH = "search"
    const val SETTINGS = "settings"
    const val PLAYER = "player"
    const val TOPLIST = "toplist/{id}/{source}"
    const val PLAYLIST = "playlist/{id}/{source}"
}

@Composable
fun AppRoot() {
    val nav = rememberNavController()
    var loggedIn by remember { mutableStateOf<Boolean?>(null) }

    // 校验本地 cookie 是否存在（快速判定，不联网校验过期）
    LaunchedEffect(Unit) {
        loggedIn = Api.cookieSnapshot() != null
    }

    val start = when (loggedIn) {
        null -> return // 等 DataStore 载入
        false -> Routes.LOGIN
        true -> Routes.MAIN
    }

    NavHost(navController = nav, startDestination = start) {
        composable(Routes.LOGIN) {
            LoginScreen(onSuccess = {
                nav.navigate(Routes.MAIN) { popUpTo(Routes.LOGIN) { inclusive = true } }
            })
        }
        composable(Routes.MAIN) {
            MainScreen(
                onOpenSearch = { nav.navigate(Routes.SEARCH) },
                onOpenSettings = { nav.navigate(Routes.SETTINGS) },
                onOpenPlayer = { nav.navigate(Routes.PLAYER) },
                onOpenToplist = { id, source -> nav.navigate("toplist/$id/$source") },
                onOpenPlaylist = { id, source -> nav.navigate("playlist/$id/$source") },
            )
        }
        composable(Routes.SEARCH) {
            SearchScreen(onBack = { nav.popBackStack() })
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(
                onBack = { nav.popBackStack() },
                onLogout = {
                    nav.navigate(Routes.LOGIN) { popUpTo(0) { inclusive = true } }
                },
            )
        }
        composable(Routes.PLAYER) {
            PlayerScreen(onClose = { nav.popBackStack() })
        }
        composable(Routes.TOPLIST) { entry ->
            val id = entry.arguments?.getString("id").orEmpty()
            val source = entry.arguments?.getString("source") ?: "tx"
            CollectionDetailScreen(kind = "toplist", id = id, source = source, onBack = { nav.popBackStack() })
        }
        composable(Routes.PLAYLIST) { entry ->
            val id = entry.arguments?.getString("id").orEmpty()
            val source = entry.arguments?.getString("source") ?: "tx"
            CollectionDetailScreen(kind = "playlist", id = id, source = source, onBack = { nav.popBackStack() })
        }
    }
}
