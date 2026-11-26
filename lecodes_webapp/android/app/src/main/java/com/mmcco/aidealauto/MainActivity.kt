//
//  MainActivity.kt
//  Android-оболочка для «ИИдеал Авто» (com.mmcco.aidealauto) на базе runtime-движка le.codes.
//  Обеспечивает нативный мост `app.ar_display` для полноценного AR / VR HUD на внешнем дисплее
//  (смарт-очки RayNeo, XREAL, Rokid, Viture, DeX, эмулируемый 2-й экран) и 3DoF Head Tracking.
//
//  Лицензия: GPL-3.0
//

package com.mmcco.aidealauto

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Point
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.display.DisplayManager
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.KeyEvent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModelProvider
import io.letary.lecodes.LeCodesView
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.runtime.LeCodesRuntime
import io.letary.lecodes.services.Services
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity(), SensorEventListener, DisplayManager.DisplayListener {

    lateinit var viewModel: AppViewModel

    private val mainHandler = Handler(Looper.getMainLooper())
    private var sensorManager: SensorManager? = null
    private var displayManager: DisplayManager? = null
    private var arHudPresentation: ARHudPresentation? = null
    private var activeExternalDisplay: Display? = null

    // Последнее состояние AR HUD (восстанавливается мгновенно при подключении нового дисплея)
    private var lastSyncedState: JSONObject? = null
    private var lastCustomPhotoBase64: String? = null
    private var externalCameraEnabled: Boolean = true

    // Активные каналы нативного сервиса `app.ar_display`
    private val serviceChannels = mutableSetOf<Services.Channel>()
    private var pendingGalleryCall: Services.ServiceCall? = null

    private val galleryPickerLauncher = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        handlePickedGalleryUri(uri)
    }

    // Датчики ориентации (3DoF Head Tracking для AR-очков)
    private var rotationVectorSensor: Sensor? = null
    private var gyroSensor: Sensor? = null
    private var accelSensor: Sensor? = null
    private var lastAttitudeEmitMs: Long = 0L

    private val rotationMatrix = FloatArray(9)
    private val orientationAngles = FloatArray(3)

    companion object {
        private const val TAG = "AIdealMainActivity"
        private const val PERMISSION_REQ_CODE = 1001
        const val AR_DISPLAY_SERVICE = "app.ar_display"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        viewModel = ViewModelProvider(this)[AppViewModel::class.java]

        // LeCodesView является корневым представлением Activity — отрисовка выполняется нативным le.codes движком
        setContentView(LeCodesView(engine = viewModel.engine, context = applicationContext))

        viewModel.engine.setLanguage(resources.configuration.locales[0]?.language ?: "ru")

        // Регистрация официальных плагинов le.codes ДО загрузки бандла
        LeCodesRuntime.registerBundledPlugins(viewModel.engine, applicationContext)

        // Регистрация нативного моста внешнего AR HUD дисплея ДО загрузки бандла
        registerArDisplayService(viewModel.engine)

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

    // =========================================================================
    // НАТИВНЫЙ МОСТ `app.ar_display` (TypeScript Service <-> ARHudPresentation)
    // =========================================================================

    private fun registerArDisplayService(engine: LecodesEngine) {
        engine.registerService(AR_DISPLAY_SERVICE, 1) { _, channel ->
            mainHandler.post {
                serviceChannels.add(channel)
                // Сразу отправляем актуальное состояние внешнего дисплея в TS
                emitToChannel(channel, "displayChanged", buildDisplayInfoJson())
            }

            Services.Instance(
                onCall = { call ->
                    mainHandler.post {
                        handleArServiceCall(call)
                    }
                },
                onClose = {
                    mainHandler.post {
                        serviceChannels.remove(channel)
                    }
                }
            )
        }
    }

    private fun emitToAllChannels(event: String, payload: JSONObject) {
        val json = payload.toString()
        val snapshot = serviceChannels.toList()
        for (ch in snapshot) {
            try {
                ch.emit(event, json)
            } catch (e: Exception) {
                Log.w(TAG, "Ошибка отправки события $event в TS", e)
            }
        }
    }

    private fun emitToChannel(channel: Services.Channel, event: String, payload: JSONObject) {
        try {
            channel.emit(event, payload.toString())
        } catch (e: Exception) {
            Log.w(TAG, "Ошибка отправки события $event", e)
        }
    }

    private fun buildDisplayInfoJson(): JSONObject {
        val d = activeExternalDisplay
        val pres = arHudPresentation
        val obj = JSONObject()
        if (d != null && pres != null) {
            val size = Point()
            @Suppress("DEPRECATION")
            d.getRealSize(size)
            obj.put("connected", true)
            obj.put("displayId", d.displayId)
            obj.put("name", d.name ?: "Внешний AR-дисплей")
            obj.put("width", size.x)
            obj.put("height", size.y)
            obj.put("mode", pres.getArMode())
            obj.put("facing", pres.getFacingMode())
            obj.put("hasCustomPhoto", pres.hasCustomPhoto())
        } else {
            obj.put("connected", false)
            obj.put("displayId", -1)
            obj.put("name", "")
            obj.put("width", 0)
            obj.put("height", 0)
            obj.put("mode", "optical")
            obj.put("facing", "back")
            obj.put("hasCustomPhoto", false)
        }
        return obj
    }

    private fun handleArServiceCall(call: Services.ServiceCall) {
        val args = call.args
        when (call.method) {
            "getDisplayInfo" -> {
                call.resolve(buildDisplayInfoJson())
            }

            "syncState" -> {
                val payload = args.optJSONObject(0)
                if (payload != null) {
                    lastSyncedState = payload
                    arHudPresentation?.syncState(payload)
                }
                call.resolve(JSONObject().put("ok", true))
            }

            "setMode" -> {
                val mode = args.optString(0, "optical")
                arHudPresentation?.setArMode(mode, animate = true)
                call.resolve(buildDisplayInfoJson())
            }

            "setCameraFacing" -> {
                val facing = args.optString(0, "back")
                arHudPresentation?.setCameraFacing(facing)
                call.resolve(buildDisplayInfoJson())
            }

            "setCameraEnabled" -> {
                val enabled = args.optBoolean(0, true)
                externalCameraEnabled = enabled
                arHudPresentation?.setCameraEnabled(enabled)
                call.resolve(JSONObject().put("ok", true).put("enabled", enabled))
            }

            "setCustomPhoto" -> {
                val b64 = if (args.length() > 0 && !args.isNull(0)) args.optString(0, "") else ""
                lastCustomPhotoBase64 = b64.ifBlank { null }
                arHudPresentation?.setCustomPhotoBase64(lastCustomPhotoBase64)
                call.resolve(buildDisplayInfoJson())
            }

            "moveWindow" -> {
                val target = args.optString(0, "assistant")
                val dx = args.optInt(1, 0)
                val dy = args.optInt(2, 0)
                arHudPresentation?.moveWindowByDelta(target, dx, dy)
                call.resolve(JSONObject().put("ok", true))
            }

            "resetLayout" -> {
                arHudPresentation?.applyDefaultWindowLayout(animate = true)
                call.resolve(JSONObject().put("ok", true))
            }

            "capturePhoto" -> {
                val pres = arHudPresentation
                if (pres == null) {
                    call.reject("Внешний AR-дисплей не подключён")
                    return
                }
                pres.captureCurrentFrame { bytes, width, height, source ->
                    mainHandler.post {
                        if (bytes == null || bytes.isEmpty()) {
                            call.reject("Не удалось захватить кадр с внешнего AR-дисплея ($source)")
                        } else {
                            val systemId = viewModel.engine.addFetchBuffer(bytes)
                            call.resolve(
                                JSONObject()
                                    .put("systemId", systemId)
                                    .put("name", if (source == "gallery") "ar_gallery_node.jpg" else "ar_external_frame.jpg")
                                    .put("size", bytes.size)
                                    .put("width", width)
                                    .put("height", height)
                                    .put("source", source)
                            )
                        }
                    }
                }
            }

            "pickGalleryPhoto" -> {
                pendingGalleryCall?.resolve(JSONObject().put("cancelled", true))
                pendingGalleryCall = call
                try {
                    galleryPickerLauncher.launch("image/*")
                } catch (e: Exception) {
                    pendingGalleryCall = null
                    call.reject("Не удалось открыть галерею: ${e.message}")
                }
            }

            else -> {
                call.reject("Unknown ar_display method: ${call.method}")
            }
        }
    }

    private fun handlePickedGalleryUri(uri: Uri?) {
        val pending = pendingGalleryCall
        pendingGalleryCall = null
        if (uri == null) {
            pending?.resolve(JSONObject().put("cancelled", true))
            return
        }
        try {
            var displayName = "engine_photo.jpg"
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0) {
                        displayName = c.getString(idx) ?: displayName
                    }
                }
            }

            val rawBytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
            if (rawBytes == null || rawBytes.isEmpty()) {
                pending?.reject("Выбранный файл пуст")
                return
            }

            val decoded = BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size)
            if (decoded == null) {
                pending?.reject("Не удалось декодировать изображение")
                return
            }

            // Масштабируем до <= 1600px для быстрого отображения в AR-визире и передачи в Gemma 4 Vision
            val maxSide = max(decoded.width, decoded.height)
            val finalBmp = if (maxSide > 1600) {
                val scale = 1600f / maxSide.toFloat()
                val scaled = Bitmap.createScaledBitmap(
                    decoded,
                    max(1, (decoded.width * scale).roundToInt()),
                    max(1, (decoded.height * scale).roundToInt()),
                    true
                )
                decoded.recycle()
                scaled
            } else {
                decoded
            }

            val baos = ByteArrayOutputStream()
            finalBmp.compress(Bitmap.CompressFormat.JPEG, 90, baos)
            val jpegBytes = baos.toByteArray()
            val w = finalBmp.width
            val h = finalBmp.height
            finalBmp.recycle()

            val b64 = Base64.encodeToString(jpegBytes, Base64.NO_WRAP)
            lastCustomPhotoBase64 = b64
            arHudPresentation?.setCustomPhotoBase64(b64)

            val systemId = viewModel.engine.addFetchBuffer(jpegBytes)
            val resultJson = JSONObject()
                .put("cancelled", false)
                .put("systemId", systemId)
                .put("name", displayName)
                .put("size", jpegBytes.size)
                .put("width", w)
                .put("height", h)

            if (pending != null) {
                pending.resolve(resultJson)
            } else {
                emitToAllChannels(
                    "arAction",
                    JSONObject(resultJson.toString()).put("action", "galleryPhotoPicked")
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Ошибка чтения фото из галереи для AR HUD", e)
            pending?.reject("Ошибка чтения изображения: ${e.message}")
        }
    }

    // =========================================================================
    // ДАТЧИКИ ОРИЕНТАЦИИ И ВНЕШНИЕ ДИСПЛЕИ (RayNeo / XREAL / Emulator 2nd Display)
    // =========================================================================

    private fun initSensorsAndDisplays() {
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        rotationVectorSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        gyroSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
        accelSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)

        displayManager = getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
        displayManager?.registerDisplayListener(this, mainHandler)
        checkExternalDisplays()
    }

    private fun checkExternalDisplays() {
        val dm = displayManager ?: return
        val displays = dm.displays
        Log.i(TAG, "Обнаружено экранов: ${displays.size}")

        var externalDisplay: Display? = null
        for (d in displays) {
            if (d.displayId != Display.DEFAULT_DISPLAY && d.state != Display.STATE_OFF) {
                externalDisplay = d
                Log.i(TAG, "Найден внешний дисплей для полноценного AR HUD: id=${d.displayId}, name=${d.name}, flags=${d.flags}")
                break
            }
        }

        if (externalDisplay != null) {
            activeExternalDisplay = externalDisplay
            if (arHudPresentation == null || arHudPresentation?.display?.displayId != externalDisplay.displayId) {
                try {
                    arHudPresentation?.dismiss()
                } catch (_: Exception) {
                }
                val pres = ARHudPresentation(this, externalDisplay) { action, payload ->
                    if (action == "pickGalleryPhoto") {
                        mainHandler.post {
                            try {
                                galleryPickerLauncher.launch("image/*")
                            } catch (e: Exception) {
                                Log.w(TAG, "Ошибка запуска галереи с внешнего AR HUD", e)
                            }
                        }
                        return@ARHudPresentation
                    }
                    val ev = JSONObject(payload.toString()).put("action", action)
                    emitToAllChannels("arAction", ev)
                }
                arHudPresentation = pres
                try {
                    pres.show()
                    pres.setCameraEnabled(externalCameraEnabled)
                    lastCustomPhotoBase64?.let { pres.setCustomPhotoBase64(it) }
                    lastSyncedState?.let { pres.syncState(it) }
                    Log.i(TAG, "Полноценный AR HUD Presentation запущен на внешнем экране: ${externalDisplay.name}")
                } catch (e: Exception) {
                    Log.e(TAG, "Ошибка отображения AR HUD Presentation", e)
                    arHudPresentation = null
                    activeExternalDisplay = null
                }
            }
        } else {
            activeExternalDisplay = null
            try {
                arHudPresentation?.dismiss()
            } catch (_: Exception) {
            }
            arHudPresentation = null
        }

        emitToAllChannels("displayChanged", buildDisplayInfoJson())
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
                try {
                    SensorManager.getRotationMatrixFromVector(rotationMatrix, event.values)
                    SensorManager.getOrientation(rotationMatrix, orientationAngles)
                    val yawRaw = Math.toDegrees(orientationAngles[0].toDouble()).toFloat()
                    val pitchRaw = Math.toDegrees(orientationAngles[1].toDouble()).toFloat()
                    val rollRaw = Math.toDegrees(orientationAngles[2].toDouble()).toFloat()

                    val yaw = if (yawRaw.isFinite()) yawRaw else 0f
                    val pitch = if (pitchRaw.isFinite()) pitchRaw else 0f
                    val roll = if (rollRaw.isFinite()) rollRaw else 0f

                    arHudPresentation?.updateOrientation(pitch, roll, yaw)

                    val now = System.currentTimeMillis()
                    if (now - lastAttitudeEmitMs >= 250L && serviceChannels.isNotEmpty()) {
                        lastAttitudeEmitMs = now
                        emitToAllChannels(
                            "attitude",
                            JSONObject()
                                .put("yaw", yaw.toDouble())
                                .put("pitch", pitch.toDouble())
                                .put("roll", roll.toDouble())
                        )
                    }
                } catch (_: Exception) {
                    // Игнорируем единичные некорректные пакеты гироскопа (gimbal lock / NaN)
                }
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

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERMISSION_REQ_CODE) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                arHudPresentation?.setCameraEnabled(externalCameraEnabled)
            }
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
        arHudPresentation?.setCameraEnabled(externalCameraEnabled)
    }

    override fun onPause() {
        super.onPause()
        LeCodesRuntime.setForeground(false)
        viewModel.engine.pause()

        sensorManager?.unregisterListener(this)
    }

    override fun onDestroy() {
        displayManager?.unregisterDisplayListener(this)
        try {
            arHudPresentation?.dismiss()
        } catch (_: Exception) {
        }
        arHudPresentation = null
        activeExternalDisplay = null
        serviceChannels.clear()
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
