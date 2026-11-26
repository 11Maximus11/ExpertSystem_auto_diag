package com.mmcco.aidealauto

import android.Manifest
import android.annotation.SuppressLint
import android.app.Presentation
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.text.TextUtils
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.MotionEvent
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.graphics.Outline
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Полнофункциональный AR / VR HUD Presentation для внешних смарт-очков
 * (RayNeo, XREAL, Rokid, Viture, DeX и эмулируемый внешний дисплей Android).
 *
 * Повторяет фирменный дизайн с плавающими перетаскиваемыми окнами:
 * - Верхняя плавающая панель управления (AR-очки | VR режим | Диалог | + Диалог | Сброс окон | Выйти из AR)
 * - Плавающее окно «Камера и визир узла» с живой камерой Camera2 (TextureView), оранжевым визиром,
 *   поддержкой подмены кадра из галереи и полосой OBD-телеметрии
 * - Плавающее окно «Ассистент и чеклист ремонта» с живыми OBD-показателями, вердиктом ИИ,
 *   кодами DTC и интерактивным чеклистом шагов ремонта
 * - Режим VR: камера (или фото узла) разворачивается на весь фон под окном ассистента
 * - В оптическом режиме AR-очки фон чисто чёрный (#000000 — оптически прозрачен в Micro-OLED / Birdbath)
 *
 * Лицензия: GPL-3.0
 */
class ARHudPresentation(
    private val hostContext: Context,
    display: Display,
    private val onAction: (String, JSONObject) -> Unit
) : Presentation(hostContext, display) {

    companion object {
        private const val TAG = "ARHudPresentation"
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    // Режим и состояние
    private var arMode: String = "optical" // "optical" | "vr"
    private var facingMode: String = "back" // "back" | "front"
    private var cameraEnabled: Boolean = true
    private var customPhotoBitmap: Bitmap? = null
    private var customPhotoJpegBytes: ByteArray? = null

    private var lastPitch: Float = 0f
    private var lastRoll: Float = 0f
    private var lastYaw: Float = 0f
    private var currentStatusText: String = "AR-HUD готов к работе"
    private var isListeningVoice: Boolean = false
    private var isAskingAi: Boolean = false

    // Корневые контейнеры и окна
    private lateinit var rootCanvas: FrameLayout
    private lateinit var vrBgContainer: FrameLayout
    private lateinit var opticalCamHost: FrameLayout
    private lateinit var camWindow: LinearLayout
    private lateinit var aiWindow: LinearLayout
    private lateinit var topBarWrap: FrameLayout

    // Элементы верхней панели
    private lateinit var btnModeOptical: TextView
    private lateinit var btnModeVr: TextView
    private lateinit var btnVrSwitchCam: TextView
    private lateinit var btnSessionTitle: TextView

    // Элементы окна камеры
    private lateinit var camTextureView: TextureView
    private lateinit var customPhotoImageView: ImageView
    private lateinit var btnClearCustomPhoto: TextView
    private lateinit var camTelemetryBadge: TextView
    private lateinit var btnCamVoice: TextView

    // Элементы окна ассистента
    private lateinit var aiSubtitleView: TextView
    private lateinit var obdRpmVal: TextView
    private lateinit var obdCoolantVal: TextView
    private lateinit var obdVoltVal: TextView
    private lateinit var obdTpsVal: TextView
    private lateinit var obdSpeedVal: TextView
    private lateinit var thinkingBanner: LinearLayout
    private lateinit var aiContentList: LinearLayout
    private lateinit var btnAiVoice: TextView

    // Координаты плавающих окон (в px внешнего дисплея)
    private var rootW: Int = 1920
    private var rootH: Int = 1080
    private var layoutInitialized: Boolean = false

    // Camera2
    private var cameraManager: CameraManager? = null
    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var cameraThread: HandlerThread? = null
    private var cameraHandler: Handler? = null
    private var previewWidth: Int = 1280
    private var previewHeight: Int = 960
    private var sensorOrientation: Int = 90

    // Помощник перевода dp -> px с учётом плотности внешнего дисплея
    private fun dp(value: Float): Int {
        val density = context.resources.displayMetrics.density.coerceIn(1.0f, 3.0f)
        return (value * density).roundToInt()
    }

    private fun roundedBg(
        fillColor: Int,
        radiusDp: Float,
        strokeWidthDp: Float = 0f,
        strokeColor: Int = Color.TRANSPARENT
    ): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = dp(radiusDp).toFloat()
        setColor(fillColor)
        if (strokeWidthDp > 0f) {
            setStroke(max(1, dp(strokeWidthDp)), strokeColor)
        }
    }

    private fun clipRounded(view: View, radiusDp: Float) {
        val radPx = dp(radiusDp).toFloat()
        view.outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(v: View, outline: Outline) {
                outline.setRoundRect(0, 0, v.width, v.height, radPx)
            }
        }
        view.clipToOutline = true
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cameraManager = hostContext.getSystemService(Context.CAMERA_SERVICE) as? CameraManager

        rootCanvas = FrameLayout(context).apply {
            setBackgroundColor(Color.BLACK) // Чистый чёрный для оптических AR-очков
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        // 0. Фоновый контейнер камеры для VR-режима
        vrBgContainer = FrameLayout(context).apply {
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        rootCanvas.addView(vrBgContainer)

        // Единая пара живой камеры (TextureView) + подменного фото из галереи (ImageView)
        camTextureView = TextureView(context).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
                    configureCameraTransform(width, height)
                    if (cameraEnabled && customPhotoBitmap == null) {
                        openCameraSafely()
                    }
                }

                override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
                    configureCameraTransform(width, height)
                }

                override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
                    closeCameraSafely()
                    return true
                }

                override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}
            }
        }

        customPhotoImageView = ImageView(context).apply {
            scaleType = ImageView.ScaleType.CENTER_CROP
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }

        // 1. Плавающее окно камеры и визира (#arWindowCamera)
        camWindow = buildCameraWindow()
        rootCanvas.addView(camWindow)

        // 2. Плавающее окно ассистента и чеклиста (#arWindowAssistant)
        aiWindow = buildAssistantWindow()
        rootCanvas.addView(aiWindow)

        // 3. Верхняя плавающая таблетка управления (.ar-top-status)
        topBarWrap = buildTopFloatingBar()
        rootCanvas.addView(topBarWrap)

        // Монтируем TextureView и ImageView в активный контейнер (optical по умолчанию)
        attachMediaToCurrentMode()

        rootCanvas.addOnLayoutChangeListener { _, l, t, r, b, _, _, _, _ ->
            val w = r - l
            val h = b - t
            if (w > 100 && h > 100 && (!layoutInitialized || w != rootW || h != rootH)) {
                rootW = w
                rootH = h
                if (!layoutInitialized) {
                    layoutInitialized = true
                    applyDefaultWindowLayout(animate = false)
                } else {
                    clampWindows()
                }
            }
        }

        setContentView(rootCanvas)
        updateModeVisuals()
        renderDefaultEmptyChecklist()
    }

    private fun buildTopFloatingBar(): FrameLayout {
        val pillRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10f), dp(5f), dp(10f), dp(5f))
        }

        fun makeTopBtn(text: String, bg: Int, border: Int, fg: Int, onClick: () -> Unit): TextView {
            return TextView(context).apply {
                this.text = text
                textSize = 12f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(fg)
                gravity = Gravity.CENTER
                setPadding(dp(11f), dp(6f), dp(11f), dp(6f))
                background = roundedBg(bg, 8f, 1f, border)
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
                lp.marginEnd = dp(6f)
                layoutParams = lp
                setOnClickListener { onClick() }
            }
        }

        btnModeOptical = makeTopBtn(
            "AR-очки",
            Color.parseColor("#EA580C"),
            Color.parseColor("#F97316"),
            Color.WHITE
        ) {
            setArMode("optical", animate = true)
            onAction("setMode", JSONObject().put("mode", "optical"))
        }
        pillRow.addView(btnModeOptical)

        btnModeVr = makeTopBtn(
            "VR режим",
            Color.parseColor("#14FFFFFF"),
            Color.parseColor("#4794A3B8"),
            Color.parseColor("#94A3B8")
        ) {
            setArMode("vr", animate = true)
            onAction("setMode", JSONObject().put("mode", "vr"))
        }
        pillRow.addView(btnModeVr)

        btnVrSwitchCam = makeTopBtn(
            "Камера",
            Color.parseColor("#14FFFFFF"),
            Color.parseColor("#4794A3B8"),
            Color.parseColor("#E2E8F0")
        ) {
            toggleFacing()
            onAction("switchCamera", JSONObject().put("facing", facingMode))
        }.apply {
            visibility = View.GONE
        }
        pillRow.addView(btnVrSwitchCam)

        // Разделитель
        pillRow.addView(View(context).apply {
            setBackgroundColor(Color.parseColor("#4794A3B8"))
            val lp = LinearLayout.LayoutParams(dp(1f), dp(18f))
            lp.marginEnd = dp(6f)
            layoutParams = lp
        })

        btnSessionTitle = makeTopBtn(
            "Диагностика #1",
            Color.parseColor("#E60F172A"),
            Color.parseColor("#5938BDF8"),
            Color.parseColor("#F8FAFC")
        ) {
            onAction("openSessionPicker", JSONObject())
        }.apply {
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            maxWidth = dp(170f)
        }
        pillRow.addView(btnSessionTitle)

        pillRow.addView(
            makeTopBtn(
                "+ Диалог",
                Color.parseColor("#2438BDF8"),
                Color.parseColor("#6638BDF8"),
                Color.parseColor("#38BDF8")
            ) {
                onAction("newSession", JSONObject())
            }
        )

        pillRow.addView(
            makeTopBtn(
                "Сброс окон",
                Color.parseColor("#14FFFFFF"),
                Color.parseColor("#4794A3B8"),
                Color.parseColor("#CBD5E1")
            ) {
                applyDefaultWindowLayout(animate = true)
                onAction("resetLayout", JSONObject())
            }
        )

        pillRow.addView(
            makeTopBtn(
                "Выйти из AR",
                Color.parseColor("#33EF4444"),
                Color.parseColor("#8CEF4444"),
                Color.parseColor("#FECACA")
            ) {
                onAction("exitAr", JSONObject())
            }.apply {
                (layoutParams as LinearLayout.LayoutParams).marginEnd = 0
            }
        )

        val hsv = HorizontalScrollView(context).apply {
            isHorizontalScrollBarEnabled = false
            background = roundedBg(
                Color.parseColor("#F00A0F19"),
                14f,
                1f,
                Color.parseColor("#7338BDF8")
            )
            addView(pillRow)
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER_HORIZONTAL
            )
        }

        return FrameLayout(context).apply {
            addView(hsv)
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP
            ).apply {
                topMargin = dp(10f)
                leftMargin = dp(10f)
                rightMargin = dp(10f)
            }
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun buildCameraWindow(): LinearLayout {
        val win = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedBg(
                Color.parseColor("#E0080C14"),
                14f,
                1.5f,
                Color.parseColor("#A6F97316")
            )
            layoutParams = FrameLayout.LayoutParams(dp(340f), dp(300f))
        }
        clipRounded(win, 14f)

        // Заголовок окна (зона перетаскивания)
        val dragBar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#29F97316"))
            setPadding(dp(12f), dp(8f), dp(12f), dp(8f))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
        dragBar.addView(TextView(context).apply {
            text = "Камера и визир узла"
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor("#F8FAFC"))
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        })
        dragBar.addView(TextView(context).apply {
            text = "::: Перетащить"
            textSize = 10.5f
            setTextColor(Color.parseColor("#CBD5E1"))
        })
        attachDragHandler(dragBar, win)
        win.addView(dragBar)

        // Тонкий оранжевый разделитель
        win.addView(View(context).apply {
            setBackgroundColor(Color.parseColor("#4DF97316"))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1f))
        })

        // Область камеры + оптического визира
        val viewportBox = FrameLayout(context).apply {
            setBackgroundColor(Color.parseColor("#020617"))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
        }

        opticalCamHost = FrameLayout(context).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        viewportBox.addView(opticalCamHost)

        // Оранжевый оптический прицел (4 уголка + центральное перекрестие)
        viewportBox.addView(ReticleOverlayView(context).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        })

        // Кнопка возврата к живой камере (показывается только при загруженном фото узла из галереи)
        btnClearCustomPhoto = TextView(context).apply {
            text = "✕ Живая камера"
            textSize = 10.5f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor("#FDE68A"))
            setPadding(dp(8f), dp(4f), dp(8f), dp(4f))
            background = roundedBg(Color.parseColor("#CC0F172A"), 7f, 1f, Color.parseColor("#99F59E0B"))
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP or Gravity.END
            ).apply {
                topMargin = dp(10f)
                rightMargin = dp(10f)
            }
            setOnClickListener {
                clearCustomPhoto()
                onAction("clearGalleryPhoto", JSONObject())
            }
        }
        viewportBox.addView(btnClearCustomPhoto)

        // Мини-бейдж живой OBD телеметрии поверх камеры (внизу слева)
        camTelemetryBadge = TextView(context).apply {
            text = "0 rpm • 0°C • 12.6V"
            textSize = 10.5f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor("#38BDF8"))
            setPadding(dp(8f), dp(4f), dp(8f), dp(4f))
            background = roundedBg(Color.parseColor("#C7020617"), 7f, 1f, Color.parseColor("#6638BDF8"))
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.START
            ).apply {
                bottomMargin = dp(10f)
                leftMargin = dp(10f)
            }
        }
        viewportBox.addView(camTelemetryBadge)
        win.addView(viewportBox)

        // Нижняя панель действий камеры
        val footer = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#F20F172A"))
            setPadding(dp(8f), dp(8f), dp(8f), dp(8f))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }

        val btnFlip = TextView(context).apply {
            text = "⟲"
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor("#E2E8F0"))
            gravity = Gravity.CENTER
            background = roundedBg(Color.parseColor("#E61E293B"), 9f, 1f, Color.parseColor("#4D94A3B8"))
            layoutParams = LinearLayout.LayoutParams(dp(36f), dp(36f)).apply { marginEnd = dp(6f) }
            setOnClickListener {
                toggleFacing()
                onAction("switchCamera", JSONObject().put("facing", facingMode))
            }
        }
        footer.addView(btnFlip)

        val btnGallery = TextView(context).apply {
            text = "Фото"
            textSize = 11f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor("#38BDF8"))
            gravity = Gravity.CENTER
            setPadding(dp(8f), 0, dp(8f), 0)
            background = roundedBg(Color.parseColor("#2438BDF8"), 9f, 1f, Color.parseColor("#6638BDF8"))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                dp(36f)
            ).apply { marginEnd = dp(6f) }
            setOnClickListener {
                onAction("pickGalleryPhoto", JSONObject())
            }
        }
        footer.addView(btnGallery)

        val btnSnap = TextView(context).apply {
            text = "Сфоткать в ИИ"
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            background = roundedBg(Color.parseColor("#EA580C"), 9f)
            layoutParams = LinearLayout.LayoutParams(0, dp(36f), 1f).apply { marginEnd = dp(6f) }
            setOnClickListener {
                onAction("capturePhoto", JSONObject())
            }
        }
        footer.addView(btnSnap)

        btnCamVoice = TextView(context).apply {
            text = "Голос"
            textSize = 11f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(dp(9f), 0, dp(9f), 0)
            background = roundedBg(Color.parseColor("#0284C7"), 9f)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                dp(36f)
            )
            setOnClickListener {
                onAction("toggleVoice", JSONObject())
            }
        }
        footer.addView(btnCamVoice)
        win.addView(footer)

        return win
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun buildAssistantWindow(): LinearLayout {
        val win = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedBg(
                Color.parseColor("#E0080C14"),
                14f,
                1.5f,
                Color.parseColor("#B338BDF8")
            )
            layoutParams = FrameLayout.LayoutParams(dp(500f), dp(300f))
        }
        clipRounded(win, 14f)

        // Шапка с перетаскиванием и 3DoF статусом
        val dragBar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#2938BDF8"))
            setPadding(dp(12f), dp(7f), dp(12f), dp(7f))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }

        val titleCol = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        titleCol.addView(TextView(context).apply {
            text = "Ассистент и чеклист ремонта"
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor("#F8FAFC"))
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        })
        aiSubtitleView = TextView(context).apply {
            text = "3DoF Y0° P0° • AR-HUD готов к работе"
            textSize = 10f
            setTextColor(Color.parseColor("#94A3B8"))
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        titleCol.addView(aiSubtitleView)
        dragBar.addView(titleCol)

        dragBar.addView(TextView(context).apply {
            text = "::: Перетащить"
            textSize = 10.5f
            setTextColor(Color.parseColor("#CBD5E1"))
        })
        attachDragHandler(dragBar, win)
        win.addView(dragBar)

        // Полоса живой OBD-II телеметрии
        val obdStrip = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#C7020617"))
            setPadding(dp(10f), dp(5f), dp(10f), dp(5f))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }

        fun makeObdCell(label: String, initVal: String, valColor: Int): Pair<LinearLayout, TextView> {
            val cell = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }
            cell.addView(TextView(context).apply {
                text = "$label "
                textSize = 10.5f
                setTextColor(Color.parseColor("#94A3B8"))
            })
            val tv = TextView(context).apply {
                text = initVal
                textSize = 11.5f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(valColor)
            }
            cell.addView(tv)
            return cell to tv
        }

        val (cRpm, vRpm) = makeObdCell("RPM", "0", Color.parseColor("#10B981"))
        val (cCool, vCool) = makeObdCell("ОЖ", "0°C", Color.parseColor("#F59E0B"))
        val (cVolt, vVolt) = makeObdCell("АКБ", "12.6V", Color.parseColor("#38BDF8"))
        val (cTps, vTps) = makeObdCell("TPS", "0%", Color.parseColor("#E2E8F0"))
        val (cSpd, vSpd) = makeObdCell("СКР", "0 км/ч", Color.parseColor("#6EE7B7"))
        obdRpmVal = vRpm
        obdCoolantVal = vCool
        obdVoltVal = vVolt
        obdTpsVal = vTps
        obdSpeedVal = vSpd
        obdStrip.addView(cRpm)
        obdStrip.addView(cCool)
        obdStrip.addView(cVolt)
        obdStrip.addView(cTps)
        obdStrip.addView(cSpd)
        win.addView(obdStrip)

        win.addView(View(context).apply {
            setBackgroundColor(Color.parseColor("#4010B981"))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1f))
        })

        // Баннер анализа ИИ
        thinkingBanner = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#38EA580C"))
            setPadding(dp(12f), dp(6f), dp(12f), dp(6f))
            visibility = View.GONE
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            addView(TextView(context).apply {
                text = "ИИ анализирует кадр и симптомы..."
                textSize = 11.5f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Color.parseColor("#FB923C"))
            })
        }
        win.addView(thinkingBanner)

        // Прокручиваемая лента вердикта и интерактивного чеклиста
        aiContentList = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12f), dp(10f), dp(12f), dp(12f))
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            )
        }
        val scroll = ScrollView(context).apply {
            isVerticalScrollBarEnabled = true
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
            addView(aiContentList)
        }
        win.addView(scroll)

        // Нижняя строка быстрых действий окна ассистента
        val footer = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#F00F172A"))
            setPadding(dp(10f), dp(7f), dp(10f), dp(7f))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
        footer.addView(TextView(context).apply {
            text = "Ввод текста и управление окнами доступны также с экрана телефона"
            textSize = 10.5f
            setTextColor(Color.parseColor("#94A3B8"))
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = dp(8f)
            }
        })
        footer.addView(TextView(context).apply {
            text = "Кадр в ИИ"
            textSize = 11f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor("#FB923C"))
            gravity = Gravity.CENTER
            setPadding(dp(10f), dp(6f), dp(10f), dp(6f))
            background = roundedBg(Color.parseColor("#29F97316"), 8f, 1f, Color.parseColor("#73F97316"))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { marginEnd = dp(6f) }
            setOnClickListener {
                onAction("capturePhoto", JSONObject())
            }
        })
        btnAiVoice = TextView(context).apply {
            text = "Голос"
            textSize = 11f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor("#F472B6"))
            gravity = Gravity.CENTER
            setPadding(dp(10f), dp(6f), dp(10f), dp(6f))
            background = roundedBg(Color.parseColor("#24EC4899"), 8f, 1f, Color.parseColor("#73EC4899"))
            setOnClickListener {
                onAction("toggleVoice", JSONObject())
            }
        }
        footer.addView(btnAiVoice)
        win.addView(footer)

        return win
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun attachDragHandler(handle: View, targetWin: View) {
        var downRawX = 0f
        var downRawY = 0f
        var startLeft = 0
        var startTop = 0
        handle.setOnTouchListener { _, ev ->
            val lp = targetWin.layoutParams as FrameLayout.LayoutParams
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = ev.rawX
                    downRawY = ev.rawY
                    startLeft = lp.leftMargin
                    startTop = lp.topMargin
                    targetWin.bringToFront()
                    topBarWrap.bringToFront()
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = (ev.rawX - downRawX).roundToInt()
                    val dy = (ev.rawY - downRawY).roundToInt()
                    val minTop = dp(58f)
                    val pad = dp(10f)
                    val maxLeft = max(pad, rootW - lp.width - pad)
                    val maxTop = max(minTop, rootH - lp.height - pad)
                    lp.leftMargin = (startLeft + dx).coerceIn(pad, maxLeft)
                    lp.topMargin = (startTop + dy).coerceIn(minTop, maxTop)
                    targetWin.layoutParams = lp
                    true
                }
                else -> false
            }
        }
    }

    private fun attachMediaToCurrentMode() {
        (camTextureView.parent as? ViewGroup)?.removeView(camTextureView)
        (customPhotoImageView.parent as? ViewGroup)?.removeView(customPhotoImageView)

        val target = if (arMode == "vr") vrBgContainer else opticalCamHost
        target.addView(camTextureView)
        target.addView(customPhotoImageView)
    }

    private fun updateModeVisuals() {
        val isVr = arMode == "vr"
        vrBgContainer.visibility = if (isVr) View.VISIBLE else View.GONE
        camWindow.visibility = if (isVr) View.GONE else View.VISIBLE
        btnVrSwitchCam.visibility = if (isVr) View.VISIBLE else View.GONE

        btnModeOptical.background = roundedBg(
            if (!isVr) Color.parseColor("#EA580C") else Color.parseColor("#14FFFFFF"),
            8f,
            1f,
            if (!isVr) Color.parseColor("#F97316") else Color.parseColor("#4794A3B8")
        )
        btnModeOptical.setTextColor(if (!isVr) Color.WHITE else Color.parseColor("#94A3B8"))

        btnModeVr.background = roundedBg(
            if (isVr) Color.parseColor("#EA580C") else Color.parseColor("#14FFFFFF"),
            8f,
            1f,
            if (isVr) Color.parseColor("#F97316") else Color.parseColor("#4794A3B8")
        )
        btnModeVr.setTextColor(if (isVr) Color.WHITE else Color.parseColor("#94A3B8"))

        aiWindow.background = roundedBg(
            if (isVr) Color.parseColor("#CC080C14") else Color.parseColor("#E0080C14"),
            14f,
            1.5f,
            Color.parseColor("#B338BDF8")
        )
    }

    fun applyDefaultWindowLayout(animate: Boolean = false) {
        if (!::camWindow.isInitialized || !::aiWindow.isInitialized) return
        val w = max(rootW, 640)
        val h = max(rootH, 360)
        val topSafe = dp(60f)
        val padX = dp(20f)
        val padBottom = dp(18f)
        val gap = dp(12f)
        val availH = max(dp(220f), h - topSafe - padBottom)
        val usableW = max(dp(480f), w - padX * 2)

        val camW = ((usableW - gap) * 0.39f).roundToInt().coerceIn(dp(260f), dp(520f))
        val aiW = max(dp(300f), usableW - gap - camW)
        val vrAiW = (usableW * 0.64f).roundToInt().coerceIn(dp(360f), dp(720f))

        (camWindow.layoutParams as FrameLayout.LayoutParams).apply {
            width = camW
            height = availH
            leftMargin = padX
            topMargin = topSafe
            camWindow.layoutParams = this
        }

        (aiWindow.layoutParams as FrameLayout.LayoutParams).apply {
            if (arMode == "vr") {
                width = vrAiW
                height = availH
                leftMargin = max(padX, padX + (usableW - vrAiW) / 2)
                topMargin = topSafe
            } else {
                width = aiW
                height = availH
                leftMargin = padX + camW + gap
                topMargin = topSafe
            }
            aiWindow.layoutParams = this
        }

        if (animate) {
            listOf(camWindow, aiWindow).forEach { v ->
                if (v.visibility == View.VISIBLE) {
                    v.alpha = 0.55f
                    v.scaleX = 0.96f
                    v.scaleY = 0.96f
                    v.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(220L).start()
                }
            }
        }
    }

    private fun clampWindows() {
        val minTop = dp(58f)
        val pad = dp(10f)
        listOf(camWindow, aiWindow).forEach { v ->
            val lp = v.layoutParams as FrameLayout.LayoutParams
            lp.width = min(lp.width, max(dp(220f), rootW - pad * 2))
            lp.height = min(lp.height, max(dp(180f), rootH - minTop - pad))
            lp.leftMargin = lp.leftMargin.coerceIn(pad, max(pad, rootW - lp.width - pad))
            lp.topMargin = lp.topMargin.coerceIn(minTop, max(minTop, rootH - lp.height - pad))
            v.layoutParams = lp
        }
    }

    // =========================================================================
    // ПУБЛИЧНЫЕ МЕТОДЫ УПРАВЛЕНИЯ ИЗ MainActivity / TypeScript Service
    // =========================================================================

    fun setArMode(mode: String, animate: Boolean = true) {
        val normalized = if (mode == "vr") "vr" else "optical"
        if (arMode == normalized && layoutInitialized) return
        arMode = normalized
        if (!::camWindow.isInitialized) return
        attachMediaToCurrentMode()
        updateModeVisuals()
        applyDefaultWindowLayout(animate)
    }

    fun getArMode(): String = arMode

    fun getFacingMode(): String = facingMode

    fun hasCustomPhoto(): Boolean = customPhotoBitmap != null

    fun setCameraFacing(facing: String) {
        val norm = if (facing == "front") "front" else "back"
        if (facingMode == norm) return
        facingMode = norm
        if (cameraEnabled && customPhotoBitmap == null && ::camTextureView.isInitialized && camTextureView.isAvailable) {
            closeCameraSafely()
            openCameraSafely()
        }
    }

    private fun toggleFacing() {
        setCameraFacing(if (facingMode == "back") "front" else "back")
    }

    fun setCameraEnabled(enabled: Boolean) {
        cameraEnabled = enabled
        if (!::camTextureView.isInitialized) return
        if (enabled) {
            if (customPhotoBitmap == null && camTextureView.isAvailable) {
                openCameraSafely()
            }
        } else {
            closeCameraSafely()
        }
    }

    fun setCustomPhotoBase64(b64: String?) {
        if (b64.isNullOrBlank()) {
            clearCustomPhoto()
            return
        }
        val clean = if (b64.contains(",")) b64.substringAfter(",") else b64
        try {
            val bytes = Base64.decode(clean, Base64.DEFAULT)
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return
            customPhotoBitmap = bmp
            customPhotoJpegBytes = bytes
            closeCameraSafely()
            if (::customPhotoImageView.isInitialized) {
                customPhotoImageView.setImageBitmap(bmp)
                customPhotoImageView.visibility = View.VISIBLE
                btnClearCustomPhoto.visibility = View.VISIBLE
            }
        } catch (e: Exception) {
            Log.w(TAG, "Не удалось декодировать фото для AR-визира", e)
        }
    }

    fun clearCustomPhoto() {
        customPhotoBitmap = null
        customPhotoJpegBytes = null
        if (::customPhotoImageView.isInitialized) {
            customPhotoImageView.setImageBitmap(null)
            customPhotoImageView.visibility = View.GONE
            btnClearCustomPhoto.visibility = View.GONE
        }
        if (cameraEnabled && ::camTextureView.isInitialized && camTextureView.isAvailable) {
            openCameraSafely()
        }
    }

    fun moveWindowByDelta(target: String, dxPx: Int, dyPx: Int) {
        if (!::camWindow.isInitialized || !::aiWindow.isInitialized) return
        val win = if (target == "camera" && arMode == "optical") camWindow else aiWindow
        val lp = win.layoutParams as FrameLayout.LayoutParams
        val minTop = dp(58f)
        val pad = dp(10f)
        val maxLeft = max(pad, rootW - lp.width - pad)
        val maxTop = max(minTop, rootH - lp.height - pad)
        lp.leftMargin = (lp.leftMargin + dxPx).coerceIn(pad, maxLeft)
        lp.topMargin = (lp.topMargin + dyPx).coerceIn(minTop, maxTop)
        win.layoutParams = lp
        win.bringToFront()
        topBarWrap.bringToFront()
    }

    fun captureCurrentFrame(callback: (ByteArray?, Int, Int, String) -> Unit) {
        val customBytes = customPhotoJpegBytes
        val customBmp = customPhotoBitmap
        if (customBytes != null && customBmp != null) {
            callback(customBytes, customBmp.width, customBmp.height, "gallery")
            return
        }
        if (!::camTextureView.isInitialized || !camTextureView.isAvailable) {
            callback(null, 0, 0, "camera_unavailable")
            return
        }
        try {
            val bmp = camTextureView.bitmap
            if (bmp == null) {
                callback(null, 0, 0, "empty_frame")
                return
            }
            val baos = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.JPEG, 88, baos)
            val bytes = baos.toByteArray()
            val w = bmp.width
            val h = bmp.height
            bmp.recycle()
            callback(bytes, w, h, "camera")
        } catch (e: Exception) {
            Log.e(TAG, "Ошибка захвата кадра с внешнего AR HUD", e)
            callback(null, 0, 0, "error")
        }
    }

    fun updateOrientation(pitch: Float, roll: Float, yaw: Float) {
        if (pitch.isFinite()) lastPitch = pitch
        if (roll.isFinite()) lastRoll = roll
        if (yaw.isFinite()) lastYaw = yaw
        if (::aiSubtitleView.isInitialized) {
            aiSubtitleView.text = String.format(
                "3DoF Y%.0f° P%.0f° R%.0f° • %s",
                lastYaw,
                lastPitch,
                lastRoll,
                currentStatusText
            )
        }
    }

    fun syncState(state: JSONObject) {
        if (!::aiContentList.isInitialized) return

        // Режим (если пришёл из TS)
        val modeVal = state.optString("mode", "")
        if (modeVal == "optical" || modeVal == "vr") {
            if (modeVal != arMode) {
                setArMode(modeVal, animate = true)
            }
        }

        // Заголовок активной сессии
        val sessTitle = state.optString("sessionTitle", "Диагностика #1").ifBlank { "Диагностика #1" }
        btnSessionTitle.text = sessTitle

        // Статус + флаги
        val status = state.optString("status", "")
        if (status.isNotBlank()) {
            currentStatusText = status
        }
        isAskingAi = state.optBoolean("isAsking", false)
        isListeningVoice = state.optBoolean("isListening", false)

        thinkingBanner.visibility = if (isAskingAi) View.VISIBLE else View.GONE
        aiSubtitleView.text = String.format(
            "3DoF Y%.0f° P%.0f° R%.0f° • %s",
            lastYaw,
            lastPitch,
            lastRoll,
            currentStatusText
        )

        btnCamVoice.background = roundedBg(
            if (isListeningVoice) Color.parseColor("#EF4444") else Color.parseColor("#0284C7"),
            9f
        )
        btnAiVoice.background = roundedBg(
            if (isListeningVoice) Color.parseColor("#EF4444") else Color.parseColor("#24EC4899"),
            8f,
            1f,
            if (isListeningVoice) Color.parseColor("#EF4444") else Color.parseColor("#73EC4899")
        )
        btnAiVoice.setTextColor(if (isListeningVoice) Color.WHITE else Color.parseColor("#F472B6"))

        // Живые датчики OBD-II
        val obd = state.optJSONObject("obd")
        if (obd != null) {
            val rpm = obd.optInt("rpm", 0)
            val coolant = obd.optInt("coolantTemp", 0)
            val volt = obd.optDouble("voltage", 12.6)
            val tps = obd.optInt("throttle", 0)
            val speed = obd.optInt("speed", 0)
            obdRpmVal.text = rpm.toString()
            obdCoolantVal.text = "${coolant}°C"
            obdVoltVal.text = String.format("%.1fV", volt)
            obdTpsVal.text = "${tps}%"
            obdSpeedVal.text = "$speed км/ч"
            camTelemetryBadge.text = String.format("%d rpm • %d°C • %.1fV", rpm, coolant, volt)
        }

        // Лента вердикта и интерактивный чеклист
        renderAssistantFeed(state)
    }

    private fun renderDefaultEmptyChecklist() {
        aiContentList.removeAllViews()
        aiContentList.addView(TextView(context).apply {
            text = "Наведите камеру на узел двигателя, загрузите фото или задайте вопрос голосом/текстом с телефона. Здесь появятся вердикт ИИдеал Авто и пошаговый чеклист ремонта."
            textSize = 12.5f
            setTextColor(Color.parseColor("#94A3B8"))
            setLineSpacing(dp(3f).toFloat(), 1.0f)
        })
    }

    private fun renderAssistantFeed(state: JSONObject) {
        aiContentList.removeAllViews()

        val vehicle = state.optString("vehicle", "").trim()
        val latestUser = state.optString("latestUser", "").trim()
        val summaryTitle = state.optString("summaryTitle", "").trim()
        val replyText = state.optString("replyText", "").trim()
        val isWelcome = state.optBoolean("isWelcome", false)
        val followups = state.optJSONArray("followups") ?: JSONArray()
        val faults = state.optJSONArray("faults") ?: JSONArray()
        val tasks = state.optJSONArray("tasks") ?: JSONArray()
        val tasksMessageId = state.optString("tasksMessageId", "")

        if (vehicle.isNotBlank()) {
            aiContentList.addView(TextView(context).apply {
                text = "Авто: $vehicle"
                textSize = 11.5f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Color.parseColor("#FDE68A"))
                setPadding(dp(9f), dp(4f), dp(9f), dp(4f))
                background = roundedBg(Color.parseColor("#24F59E0B"), 7f, 1f, Color.parseColor("#59F59E0B"))
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(7f) }
            })
        }

        if (latestUser.isNotBlank()) {
            aiContentList.addView(TextView(context).apply {
                text = "Вы: $latestUser"
                textSize = 11.5f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Color.parseColor("#38BDF8"))
                setPadding(dp(10f), dp(7f), dp(10f), dp(7f))
                background = roundedBg(Color.parseColor("#1F38BDF8"), 9f, 1f, Color.parseColor("#4D38BDF8"))
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(8f) }
            })
        }

        if ((isWelcome || (summaryTitle.isBlank() && replyText.isBlank())) && tasks.length() == 0) {
            if (latestUser.isBlank()) {
                renderDefaultEmptyChecklist()
            } else {
                aiContentList.addView(TextView(context).apply {
                    text = "Ожидание вердикта ИИ..."
                    textSize = 12f
                    setTextColor(Color.parseColor("#94A3B8"))
                })
            }
            return
        }

        if (summaryTitle.isNotBlank()) {
            aiContentList.addView(TextView(context).apply {
                text = summaryTitle
                textSize = 14f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Color.parseColor("#F8FAFC"))
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(5f) }
            })
        }

        if (replyText.isNotBlank()) {
            aiContentList.addView(TextView(context).apply {
                text = replyText
                textSize = 12.5f
                setTextColor(Color.parseColor("#CBD5E1"))
                setLineSpacing(dp(3f).toFloat(), 1.0f)
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(8f) }
            })
        }

        for (i in 0 until min(2, followups.length())) {
            val q = followups.optString(i, "").trim()
            if (q.isNotBlank()) {
                aiContentList.addView(TextView(context).apply {
                    text = "→ $q"
                    textSize = 11.5f
                    typeface = Typeface.DEFAULT_BOLD
                    setTextColor(Color.parseColor("#FB923C"))
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(5f) }
                })
            }
        }

        if (faults.length() > 0) {
            val faultRow = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(8f) }
            }
            for (i in 0 until min(4, faults.length())) {
                val f = faults.optJSONObject(i) ?: continue
                val code = f.optString("code", "DTC")
                val sev = f.optString("severity", "warning")
                val conf = f.optInt("confidence", 0)
                val isCrit = sev == "critical"
                val chipText = if (conf > 0) "$code • $conf%" else code
                faultRow.addView(TextView(context).apply {
                    text = chipText
                    textSize = 11f
                    typeface = Typeface.DEFAULT_BOLD
                    setTextColor(if (isCrit) Color.parseColor("#FCA5A5") else Color.parseColor("#FDE68A"))
                    setPadding(dp(8f), dp(4f), dp(8f), dp(4f))
                    background = roundedBg(
                        if (isCrit) Color.parseColor("#33EF4444") else Color.parseColor("#29F59E0B"),
                        7f,
                        1f,
                        if (isCrit) Color.parseColor("#8CEF4444") else Color.parseColor("#8CF59E0B")
                    )
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    ).apply { marginEnd = dp(6f) }
                })
            }
            aiContentList.addView(faultRow)
        }

        if (tasks.length() > 0) {
            aiContentList.addView(TextView(context).apply {
                text = "ШАГИ РЕМОНТА И ПРОВЕРКИ:"
                textSize = 10.5f
                typeface = Typeface.DEFAULT_BOLD
                setTextColor(Color.parseColor("#FB923C"))
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    topMargin = dp(2f)
                    bottomMargin = dp(6f)
                }
            })

            for (i in 0 until tasks.length()) {
                val t = tasks.optJSONObject(i) ?: continue
                val done = t.optBoolean("done", false)
                val stepText = t.optString("text", "")
                val stepId = t.optString("id", (i + 1).toString())

                val row = LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(8f), dp(6f), dp(8f), dp(6f))
                    background = roundedBg(
                        if (done) Color.parseColor("#1A10B981") else Color.parseColor("#14FFFFFF"),
                        8f,
                        1f,
                        if (done) Color.parseColor("#4D10B981") else Color.parseColor("#2694A3B8")
                    )
                    layoutParams = LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                    ).apply { bottomMargin = dp(5f) }
                    setOnClickListener {
                        onAction(
                            "toggleTask",
                            JSONObject()
                                .put("messageId", tasksMessageId)
                                .put("stepId", stepId)
                                .put("done", !done)
                        )
                    }
                }

                val checkBox = TextView(context).apply {
                    text = if (done) "✓" else ""
                    textSize = 11f
                    typeface = Typeface.DEFAULT_BOLD
                    setTextColor(Color.BLACK)
                    gravity = Gravity.CENTER
                    background = roundedBg(
                        if (done) Color.parseColor("#10B981") else Color.TRANSPARENT,
                        5f,
                        1.5f,
                        if (done) Color.parseColor("#10B981") else Color.parseColor("#38BDF8")
                    )
                    layoutParams = LinearLayout.LayoutParams(dp(19f), dp(19f)).apply { marginEnd = dp(9f) }
                }
                row.addView(checkBox)

                row.addView(TextView(context).apply {
                    text = "${i + 1}. $stepText"
                    textSize = 12f
                    setTextColor(if (done) Color.parseColor("#64748B") else Color.parseColor("#E2E8F0"))
                    if (done) {
                        paintFlags = paintFlags or Paint.STRIKE_THRU_TEXT_FLAG
                    }
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                })
                aiContentList.addView(row)
            }
        }
    }

    // =========================================================================
    // CAMERA2 LIFECYCLE (TextureView с корректным Aspect-Fill и поворотом)
    // =========================================================================

    private fun startCameraThread() {
        if (cameraThread != null) return
        cameraThread = HandlerThread("ExternalArCamera").also { it.start() }
        cameraHandler = Handler(cameraThread!!.looper)
    }

    private fun stopCameraThread() {
        cameraThread?.quitSafely()
        try {
            cameraThread?.join(500)
        } catch (_: Exception) {
        }
        cameraThread = null
        cameraHandler = null
    }

    @SuppressLint("MissingPermission")
    private fun openCameraSafely() {
        if (!cameraEnabled || customPhotoBitmap != null) return
        if (ContextCompat.checkSelfPermission(hostContext, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            return
        }
        val mgr = cameraManager ?: return
        val surfaceTex = if (::camTextureView.isInitialized) camTextureView.surfaceTexture else null
        if (surfaceTex == null) return

        val desiredFacing = if (facingMode == "front") {
            CameraCharacteristics.LENS_FACING_FRONT
        } else {
            CameraCharacteristics.LENS_FACING_BACK
        }
        val cameraId = mgr.cameraIdList.firstOrNull { id ->
            mgr.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) == desiredFacing
        } ?: mgr.cameraIdList.firstOrNull() ?: return

        closeCameraSafely()
        startCameraThread()

        try {
            val chars = mgr.getCameraCharacteristics(cameraId)
            sensorOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
            val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            val sizes = map?.getOutputSizes(SurfaceTexture::class.java)
            if (sizes != null && sizes.isNotEmpty()) {
                val chosen = sizes
                    .filter { it.width in 640..1920 && it.height in 480..1440 }
                    .minByOrNull {
                        abs((it.width.toFloat() / max(1, it.height)) - 1.333f) +
                            abs(it.width - 1280) / 4000f
                    }
                    ?: sizes.firstOrNull { it.width in 960..1920 && it.height in 540..1080 }
                    ?: sizes.first()
                previewWidth = chosen.width
                previewHeight = chosen.height
            }
            surfaceTex.setDefaultBufferSize(previewWidth, previewHeight)
            mainHandler.post {
                if (::camTextureView.isInitialized) {
                    configureCameraTransform(camTextureView.width, camTextureView.height)
                }
            }

            mgr.openCamera(cameraId, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    cameraDevice = camera
                    val previewSurface = Surface(surfaceTex)
                    try {
                        val req = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                            addTarget(previewSurface)
                            set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                        }.build()

                        @Suppress("DEPRECATION")
                        camera.createCaptureSession(
                            listOf(previewSurface),
                            object : CameraCaptureSession.StateCallback() {
                                override fun onConfigured(session: CameraCaptureSession) {
                                    captureSession = session
                                    try {
                                        session.setRepeatingRequest(req, null, cameraHandler)
                                    } catch (e: Exception) {
                                        Log.w(TAG, "setRepeatingRequest error", e)
                                    }
                                }

                                override fun onConfigureFailed(session: CameraCaptureSession) {
                                    Log.w(TAG, "Camera preview configure failed on external display")
                                }
                            },
                            cameraHandler
                        )
                    } catch (e: Exception) {
                        Log.w(TAG, "createCaptureSession failed", e)
                    }
                }

                override fun onDisconnected(camera: CameraDevice) {
                    camera.close()
                    if (cameraDevice == camera) cameraDevice = null
                }

                override fun onError(camera: CameraDevice, error: Int) {
                    camera.close()
                    if (cameraDevice == camera) cameraDevice = null
                    Log.w(TAG, "External AR camera error: $error")
                }
            }, cameraHandler)
        } catch (e: Exception) {
            Log.w(TAG, "openCameraSafely exception", e)
        }
    }

    private fun configureCameraTransform(viewW: Int, viewH: Int) {
        if (viewW <= 0 || viewH <= 0 || !::camTextureView.isInitialized) return
        val matrix = Matrix()
        val viewRect = RectF(0f, 0f, viewW.toFloat(), viewH.toFloat())
        val bufferRect = RectF(0f, 0f, previewHeight.toFloat(), previewWidth.toFloat())
        val centerX = viewRect.centerX()
        val centerY = viewRect.centerY()

        val rotation = display.rotation
        if (rotation == Surface.ROTATION_90 || rotation == Surface.ROTATION_270) {
            bufferRect.offset(centerX - bufferRect.centerX(), centerY - bufferRect.centerY())
            matrix.setRectToRect(viewRect, bufferRect, Matrix.ScaleToFit.FILL)
            val scale = max(viewH.toFloat() / previewHeight, viewW.toFloat() / previewWidth)
            matrix.postScale(scale, scale, centerX, centerY)
            matrix.postRotate((90 * (rotation - 2)).toFloat(), centerX, centerY)
        } else {
            // Camera2 SurfaceTexture автоматически применяет sensorOrientation (обычно 90° на телефоне),
            // поэтому при вертикальном сенсоре реальная ширина/высота буфера на экране меняются местами.
            val swapForSensor = (sensorOrientation == 90 || sensorOrientation == 270)
            val effW = if (swapForSensor) previewHeight.toFloat() else previewWidth.toFloat()
            val effH = if (swapForSensor) previewWidth.toFloat() else previewHeight.toFloat()
            val bufAspect = effW / max(1f, effH)
            val viewAspect = viewW.toFloat() / max(1f, viewH.toFloat())
            var sx = 1f
            var sy = 1f
            if (bufAspect > viewAspect) {
                sx = bufAspect / viewAspect
            } else {
                sy = viewAspect / bufAspect
            }
            matrix.setScale(sx, sy, centerX, centerY)
            if (rotation == Surface.ROTATION_180) {
                matrix.postRotate(180f, centerX, centerY)
            }
        }
        camTextureView.setTransform(matrix)
    }

    private fun closeCameraSafely() {
        try {
            captureSession?.close()
        } catch (_: Exception) {
        }
        captureSession = null
        try {
            cameraDevice?.close()
        } catch (_: Exception) {
        }
        cameraDevice = null
    }

    override fun onStop() {
        closeCameraSafely()
        stopCameraThread()
        super.onStop()
    }

    /**
     * Лёгкий оверлей оптического оранжевого визира (4 уголка + прицел в центре).
     */
    private class ReticleOverlayView(context: Context) : View(context) {
        private val bracketPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#D9F97316")
            strokeWidth = (2.5f * context.resources.displayMetrics.density).coerceAtLeast(3f)
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
        }
        private val centerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#8838BDF8")
            strokeWidth = (1.5f * context.resources.displayMetrics.density).coerceAtLeast(2f)
            style = Paint.Style.STROKE
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val d = context.resources.displayMetrics.density
            val m = 14f * d
            val len = 20f * d
            val w = width.toFloat()
            val h = height.toFloat()
            if (w <= m * 2 || h <= m * 2) return

            // Верхний левый
            canvas.drawLine(m, m, m + len, m, bracketPaint)
            canvas.drawLine(m, m, m, m + len, bracketPaint)
            // Верхний правый
            canvas.drawLine(w - m, m, w - m - len, m, bracketPaint)
            canvas.drawLine(w - m, m, w - m, m + len, bracketPaint)
            // Нижний левый
            canvas.drawLine(m, h - m, m + len, h - m, bracketPaint)
            canvas.drawLine(m, h - m, m, h - m - len, bracketPaint)
            // Нижний правый
            canvas.drawLine(w - m, h - m, w - m - len, h - m, bracketPaint)
            canvas.drawLine(w - m, h - m, w - m, h - m - len, bracketPaint)

            // Центральное перекрестие
            val cx = w / 2f
            val cy = h / 2f
            val r = 9f * d
            canvas.drawCircle(cx, cy, r, centerPaint)
            canvas.drawLine(cx - r * 1.6f, cy, cx - r * 0.5f, cy, centerPaint)
            canvas.drawLine(cx + r * 0.5f, cy, cx + r * 1.6f, cy, centerPaint)
            canvas.drawLine(cx, cy - r * 1.6f, cx, cy - r * 0.5f, centerPaint)
            canvas.drawLine(cx, cy + r * 0.5f, cx, cy + r * 1.6f, centerPaint)
        }
    }
}
