package com.tiejiang.hollymusic

import android.app.Application
import com.tiejiang.hollymusic.core.Settings
import com.tiejiang.hollymusic.core.PlayerManager

class HollyApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Settings.load(this)
        PlayerManager.init(this)
    }
}
