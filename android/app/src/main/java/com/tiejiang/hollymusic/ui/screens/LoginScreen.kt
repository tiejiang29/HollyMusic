package com.tiejiang.hollymusic.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.IconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tiejiang.hollymusic.core.Api
import com.tiejiang.hollymusic.core.ApiException
import com.tiejiang.hollymusic.core.Settings
import com.tiejiang.hollymusic.ui.theme.Holly
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(onSuccess: () -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf(Settings.cachedServer.ifBlank { "http://172.16.1.7:3099" }) }
    var username by remember { mutableStateOf(Settings.cachedUsername) }
    var password by remember { mutableStateOf("") }
    var err by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }

    fun doLogin() {
        if (loading) return
        err = null
        loading = true
        scope.launch {
            try {
                Api.login(server, username.trim(), password)
                Api.cookieSnapshot(server.trim().trimEnd('/'))?.let { (u, sv, s) ->
                    Settings.saveLogin(ctx, server.trim().trimEnd('/'), username.trim(), u, sv, s)
                }
                onSuccess()
            } catch (e: Exception) {
                err = when (e) {
                    is ApiException -> e.message ?: "登录失败"
                    else -> "无法连接服务器，请检查地址与网络"
                }
            } finally {
                loading = false
            }
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(Holly.bg)
    ) {
        // 柔光色晕（右上绿、左下蓝）
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .offset(x = 80.dp, y = (-80).dp)
                .size(300.dp)
                .clip(CircleShape)
                .background(
                    Brush.radialGradient(
                        listOf(Color(0x5955E6A4), Color.Transparent)
                    )
                )
        )
        Box(
            Modifier
                .align(Alignment.BottomStart)
                .offset(x = (-70).dp, y = 70.dp)
                .size(240.dp)
                .clip(CircleShape)
                .background(
                    Brush.radialGradient(
                        listOf(Color(0x407FB2FF), Color.Transparent)
                    )
                )
        )

        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 34.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Spacer(Modifier.height(120.dp))
            Box(
                Modifier
                    .size(88.dp)
                    .clip(RoundedCornerShape(28.dp))
                    .background(Holly.grad),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.MusicNote, null, tint = Color.White, modifier = Modifier.size(46.dp))
            }
            Spacer(Modifier.height(16.dp))
            Text("HollyMusic", fontSize = 23.sp, fontWeight = FontWeight.ExtraBold)
            Spacer(Modifier.height(48.dp))

            LoginField("服务器地址", server, { server = it }, KeyboardType.Uri)
            Spacer(Modifier.height(16.dp))
            LoginField("用户名", username, { username = it }, KeyboardType.Text)
            Spacer(Modifier.height(16.dp))
            LoginField("密码", password, { password = it }, KeyboardType.Password, PasswordVisualTransformation())
            if (err != null) {
                Spacer(Modifier.height(14.dp))
                Text(err!!, color = Holly.danger, fontSize = 12.5.sp)
            }
            Spacer(Modifier.height(28.dp))

            Box(
                Modifier
                    .fillMaxWidth()
                    .height(52.dp)
                    .clip(CircleShape)
                    .background(Holly.grad)
                    .clickable(enabled = !loading) { doLogin() },
                contentAlignment = Alignment.Center,
            ) {
                if (loading) CircularProgressIndicator(color = Color.White, modifier = Modifier.size(24.dp))
                else Text("登 录", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold, letterSpacing = 6.sp)
            }
            Spacer(Modifier.height(26.dp))
            Text(
                "首次使用请先在服务器管理后台开启账户\n连接失败？检查服务器地址与端口是否可达",
                fontSize = 11.5.sp, color = Holly.txt3, lineHeight = 18.sp,
            )
            Spacer(Modifier.height(40.dp))
        }
    }
}

@Composable
private fun LoginField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    type: KeyboardType,
    visual: androidx.compose.ui.text.input.VisualTransformation = androidx.compose.ui.text.input.VisualTransformation.None,
) {
    Column(Modifier.fillMaxWidth()) {
        Text(label, fontSize = 12.sp, color = Holly.txt2, modifier = Modifier.padding(start = 6.dp, bottom = 7.dp))
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            shape = RoundedCornerShape(16.dp),
            visualTransformation = visual,
            keyboardOptions = KeyboardOptions(keyboardType = type),
            trailingIcon = if (value.isNotEmpty()) {
                {
                    IconButton(onClick = { onChange("") }) {
                        Icon(Icons.Filled.Close, "清空", tint = Holly.txt3, modifier = Modifier.size(16.dp))
                    }
                }
            } else null,
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Holly.green,
                unfocusedBorderColor = Color(0xFFE4E8EF),
                focusedContainerColor = Color.White,
                unfocusedContainerColor = Color.White,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
