//
//  MainActivity.kt
//  Android-оболочка для PWA «ИИдеал-Авто» на базе runtime-движка le.codes.
//
//  Лицензия: GPL-3.0
//

package com.example.aidealautodiaglecodes

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModelProvider
import io.letary.lecodes.LeCodesView
import io.letary.lecodes.runtime.LeCodesRuntime

class MainActivity : AppCompatActivity() {

    lateinit var viewModel: AppViewModel

    companion object {
        private const val TAG = "AIdealMainActivity"
        private const val PERMISSION_REQ_CODE = 1001
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        viewModel = ViewModelProvider(this)[AppViewModel::class.java]

        // LeCodesView является корневым представлением Activity — отрисовка выполняется нативным le.codes движком
        setContentView(LeCodesView(engine = viewModel.engine, context = applicationContext))

        viewModel.engine.setLanguage(resources.configuration.locales[0]?.language ?: "ru")

        // Регистрация официальных плагинов le.codes (:plugins:lecodes-browser) ДО загрузки бандла
        LeCodesRuntime.registerBundledPlugins(viewModel.engine, applicationContext)

        // Обработка холодного старта из уведомления/интента
        if (savedInstanceState == null) {
            LeCodesRuntime.onActivityLaunch(intent)
        }

        // Передача ссылки запуска в движок
        viewModel.engine.setLaunchUrl(intent.data?.toString())

        // Запуск движка и загрузка скомпилированного бандла app.js
        viewModel.onActivityCreate(this)

        // Проверка и запрос разрешений на Bluetooth (BLE для OBD-II) и мультимедиа (Камера, Микрофон)
        checkAndRequestHardwarePermissions()
    }

    /**
     * Запрос разрешений для работы с внешними OBD-II сканерами (ELM327 BLE)
     * и распознаванием деталей/голосовым вводом через WebRTC / PWA.
     */
    private fun checkAndRequestHardwarePermissions() {
        val needed = mutableListOf<String>()

        // Камера и аудио для диагностики и мультимодального анализа
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.CAMERA)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO)
        }

        // Bluetooth LE разрешения для связи со сканерами OBD-II (Android 12+ и младше)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.BLUETOOTH_SCAN)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.BLUETOOTH_CONNECT)
            }
        } else {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.ACCESS_FINE_LOCATION)
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.ACCESS_COARSE_LOCATION)
            }
        }

        if (needed.isNotEmpty()) {
            Log.i(TAG, "Запрос аппаратных разрешений: ${needed.joinToString()}")
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERMISSION_REQ_CODE)
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        viewModel.engine.handleKeyEvent(event)
        return super.dispatchKeyEvent(event)
    }

    override fun onResume() {
        super.onResume()
        LeCodesRuntime.setForeground(true)
        viewModel.engine.resume()
    }

    override fun onPause() {
        super.onPause()
        LeCodesRuntime.setForeground(false)
        viewModel.engine.pause()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (LeCodesRuntime.onNewIntent(intent)) return
        val url = intent.data?.toString() ?: return
        viewModel.engine.emitUrl(url)
    }
}
