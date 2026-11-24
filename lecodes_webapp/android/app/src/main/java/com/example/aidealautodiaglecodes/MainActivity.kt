//
//  MainActivity.kt
//  Android-оболочка для PWA «ИИдеал-Авто» на базе runtime-движка le.codes.
//
//  Лицензия: GPL-3.0
//

package com.example.aidealautodiaglecodes

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.display.DisplayManager
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Display
import android.view.KeyEvent
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModelProvider
import io.letary.lecodes.LeCodesView
import io.letary.lecodes.runtime.LeCodesRuntime

class MainActivity : AppCompatActivity(), SensorEventListener, DisplayManager.DisplayListener {

    lateinit var viewModel: AppViewModel

    private var sensorManager: SensorManager? = null
    private var displayManager: DisplayManager? = null
    private var arHudPresentation: ARHudPresentation? = null

    // Датчики ориентации (3DoF Head Tracking для AR-очков)
    private var rotationVectorSensor: Sensor? = null
    private var gyroSensor: Sensor? = null
    private var accelSensor: Sensor? = null

    private val rotationMatrix = FloatArray(9)
    private val orientationAngles = FloatArray(3)

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

        // Инициализация датчиков ориентации и внешних экранов (AR HUD / Glasses / DeX)
        initSensorsAndDisplays()

        // Проверка подключения USB-устройств (очки RayNeo / XREAL / Rokid или OBD2-сканеры)
        checkUsbAttachment(intent)
    }

    private fun initSensorsAndDisplays() {
        // 1. Мониторинг датчиков ориентации (акселерометр, гироскоп, вектор вращения)
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        rotationVectorSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        gyroSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
        accelSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)

        // 2. Мониторинг внешних дисплеев (смарт-очки RayNeo/XREAL/Rokid, HDMI/DP док-станции, DeX)
        displayManager = getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
        displayManager?.registerDisplayListener(this, null)
        checkExternalDisplays()
    }

    private fun checkExternalDisplays() {
        val dm = displayManager ?: return
        val displays = dm.displays
        Log.i(TAG, "Обнаружено экранов: ${displays.size}")

        // Ищем внешний дисплей (дисплей отличный от DEFAULT_DISPLAY)
        var externalDisplay: Display? = null
        for (d in displays) {
            if (d.displayId != Display.DEFAULT_DISPLAY) {
                externalDisplay = d
                Log.i(TAG, "Найден внешний дисплей для AR HUD: id=${d.displayId}, name=${d.name}, flags=${d.flags}")
                break
            }
        }

        if (externalDisplay != null) {
            if (arHudPresentation == null || arHudPresentation?.display?.displayId != externalDisplay.displayId) {
                arHudPresentation?.dismiss()
                arHudPresentation = ARHudPresentation(this, externalDisplay)
                try {
                    arHudPresentation?.show()
                    Log.i(TAG, "AR HUD Presentation успешно отображен на внешнем экране: ${externalDisplay.name}")
                } catch (e: Exception) {
                    Log.e(TAG, "Ошибка отображения AR HUD Presentation", e)
                }
            }
        } else {
            arHudPresentation?.dismiss()
            arHudPresentation = null
        }
    }

    override fun onDisplayAdded(displayId: Int) {
        Log.i(TAG, "Подключен внешний дисплей (AR-очки / монитор): $displayId")
        checkExternalDisplays()
    }

    override fun onDisplayRemoved(displayId: Int) {
        Log.i(TAG, "Отключен внешний дисплей: $displayId")
        checkExternalDisplays()
    }

    override fun onDisplayChanged(displayId: Int) {
        checkExternalDisplays()
    }

    override fun onSensorChanged(event: SensorEvent?) {
        if (event == null) return
        when (event.sensor.type) {
            Sensor.TYPE_ROTATION_VECTOR -> {
                SensorManager.getRotationMatrixFromVector(rotationMatrix, event.values)
                SensorManager.getOrientation(rotationMatrix, orientationAngles)
                val yaw = Math.toDegrees(orientationAngles[0].toDouble()).toFloat()
                val pitch = Math.toDegrees(orientationAngles[1].toDouble()).toFloat()
                val roll = Math.toDegrees(orientationAngles[2].toDouble()).toFloat()

                // Обновляем ориентацию в проекции смарт-очков
                arHudPresentation?.updateOrientation(pitch, roll, yaw)
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun checkUsbAttachment(intent: Intent?) {
        if (intent?.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) {
            val device = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE)
            }
            Log.i(TAG, "USB устройство подключено: ${device?.deviceName}, VID=${device?.vendorId}, PID=${device?.productId}")
        }
    }

    private fun checkAndRequestHardwarePermissions() {
        val needed = mutableListOf<String>()

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.CAMERA)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO)
        }

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

        rotationVectorSensor?.let {
            sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_UI)
        }
        checkExternalDisplays()
    }

    override fun onPause() {
        super.onPause()
        LeCodesRuntime.setForeground(false)
        viewModel.engine.pause()

        sensorManager?.unregisterListener(this)
    }

    override fun onDestroy() {
        displayManager?.unregisterDisplayListener(this)
        arHudPresentation?.dismiss()
        arHudPresentation = null
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        checkUsbAttachment(intent)
        if (LeCodesRuntime.onNewIntent(intent)) return
        val url = intent.data?.toString() ?: return
        viewModel.engine.emitUrl(url)
    }
}
