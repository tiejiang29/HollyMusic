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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tiejiang.hollymusic.core.Api
import com.tiejiang.hollymusic.core.Settings
import com.tiejiang.hollymusic.ui.theme.Holly

private val QUALITIES = listOf(
    "flac24bit" to "无损 Hi-Res",
    "flac" to "无损 FLAC",
    "320k" to "320K",
    "128k" to "128K",
)

@Composable
fun SettingsScreen(onBack: () -> Unit, onLogout: () -> Unit) {
    val ctx = LocalContext.current
    var quality by remember { mutableStateOf(Settings.cachedQuality) }
    var confirmLogout by remember { mutableStateOf(false) }

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
            Text("设置", fontSize = 22.sp, fontWeight = FontWeight.ExtraBold)
        }

        Column(Modifier.verticalScroll(rememberScrollState())) {
            SettingsGroup {
                Text(
                    "音质偏好（服务端自动降级回退）",
                    fontSize = 13.sp, fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                )
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    QUALITIES.forEach { (id, name) ->
                        val on = quality == id
                        val chipMod = if (on) Modifier.background(Holly.grad) else Modifier.background(Holly.divider)
                        Box(
                            Modifier
                                .weight(1f)
                                .clip(CircleShape)
                                .then(chipMod)
                                .clickable {
                                    quality = id
                                    Settings.saveQuality(ctx, id)
                                }
                                .padding(vertical = 9.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                name, fontSize = 11.sp,
                                color = if (on) Color.White else Holly.txt2,
                                fontWeight = if (on) FontWeight.Bold else FontWeight.Normal,
                            )
                        }
                    }
                }
                Spacer(Modifier.height(12.dp))
            }

            SettingsGroup {
                SettingsRow(Icons.Filled.Dns, "服务器", Settings.cachedServer) {}
                SettingsRow(Icons.Filled.Download, "下载目录", "Music/HollyMusic/") {}
                SettingsRow(Icons.Filled.Palette, "外观", "浅色（深色二期支持）") {}
            }
            SettingsGroup {
                SettingsRow(Icons.Filled.Info, "关于 HollyMusic", "v1.0.0") {}
            }

            Box(
                Modifier
                    .padding(22.dp)
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(22.dp))
                    .background(Color.White)
                    .clickable { confirmLogout = true }
                    .padding(vertical = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("退出登录", color = Holly.danger, fontSize = 14.5.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }

    if (confirmLogout) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("退出登录？", fontWeight = FontWeight.Bold) },
            text = { Text("将清除本机会话，需要重新登录才能播放。") },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    Settings.logout(ctx)
                    confirmLogout = false
                    onLogout()
                }) { Text("退出", color = Holly.danger) }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { confirmLogout = false }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun SettingsGroup(content: @Composable () -> Unit) {
    Surface(
        shape = RoundedCornerShape(22.dp), color = Color.White, shadowElevation = 2.dp,
        modifier = Modifier
            .padding(horizontal = 18.dp, vertical = 7.dp)
            .fillMaxWidth(),
    ) { Column { content() } }
}

@Composable
private fun SettingsRow(icon: ImageVector, title: String, value: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(36.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0x3855E6A4)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, null, tint = Holly.green, modifier = Modifier.size(19.dp))
        }
        Spacer(Modifier.width(12.dp))
        Text(title, fontSize = 14.5.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.weight(1f))
        Text(value, fontSize = 12.sp, color = Holly.txt3, maxLines = 1)
        Text("  ›", fontSize = 14.sp, color = Color(0xFFC9CFD9))
    }
}
