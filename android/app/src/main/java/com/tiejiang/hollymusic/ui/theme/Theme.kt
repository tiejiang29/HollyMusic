package com.tiejiang.hollymusic.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

object Holly {
    val green = Color(0xFF1FC774)
    val greenLt = Color(0xFF55E6A4)
    val blue = Color(0xFF3D74E0)
    val blueLt = Color(0xFF8AB4FF)
    val orange = Color(0xFFEE9422)
    val orangeLt = Color(0xFFFFC96B)

    val bg = Color(0xFFF4F6F8)
    val card = Color(0xFFFFFFFF)
    val txt = Color(0xFF171C26)
    val txt2 = Color(0xFF878D9C)
    val txt3 = Color(0xFFBAC0CB)
    val divider = Color(0xFFF2F4F7)
    val danger = Color(0xFFE35D5D)

    /** 品牌渐变（荧光绿 135°） */
    val grad
        get() = Brush.linearGradient(listOf(greenLt, green))
    val gradBlue
        get() = Brush.linearGradient(listOf(blueLt, blue))
    val gradOrange
        get() = Brush.linearGradient(listOf(orangeLt, orange))

    /** 按封面 uid 稳定取一组展示色（真封面加载前占位） */
    fun coverColors(key: String): List<Color> = when (Math.floorMod(key.hashCode(), 7)) {
        0 -> listOf(greenLt, Color(0xFF12996A))
        1 -> listOf(blueLt, blue)
        2 -> listOf(Color(0xFFFF8E8E), Color(0xFFD8384E))
        3 -> listOf(Color(0xFFD9A0F0), Color(0xFF8A3BD0))
        4 -> listOf(orangeLt, orange)
        5 -> listOf(Color(0xFF6BD8F0), Color(0xFF1F86C4))
        else -> listOf(Color(0xFFA6AEBE), Color(0xFF5B6474))
    }
}

private val LightScheme = lightColorScheme(
    primary = Holly.green,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDDF6EA),
    onPrimaryContainer = Color(0xFF0A3D26),
    secondary = Holly.blue,
    background = Holly.bg,
    onBackground = Holly.txt,
    surface = Holly.bg,
    onSurface = Holly.txt,
    surfaceVariant = Holly.card,
    onSurfaceVariant = Holly.txt2,
    outlineVariant = Holly.divider,
)

@Composable
fun HollyTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = LightScheme,
        typography = MaterialTheme.typography.run {
            copy(
                headlineLarge = headlineLarge.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.ExtraBold),
                titleLarge = titleLarge.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.ExtraBold, fontSize = 25.sp),
                titleMedium = titleMedium.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold),
            )
        },
        content = content,
    )
}

object HollyShapes {
    val card = RoundedCornerShape(22.dp)
    val chip = RoundedCornerShape(99.dp)
    val cover = RoundedCornerShape(12.dp)
    val bigCover = RoundedCornerShape(30.dp)
    val btn = RoundedCornerShape(16.dp)
}
