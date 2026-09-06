package com.tiejiang.hollymusic

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.tiejiang.hollymusic.ui.AppRoot
import com.tiejiang.hollymusic.ui.theme.HollyTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            HollyTheme { AppRoot() }
        }
    }
}
