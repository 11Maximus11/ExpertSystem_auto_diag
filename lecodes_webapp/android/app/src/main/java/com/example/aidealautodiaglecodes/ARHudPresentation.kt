package com.example.aidealautodiaglecodes

import android.app.Presentation
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.Display
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * AR HUD Presentation для внешних смарт-очков (RayNeo, XREAL, Rokid, Viture)
 * и автомобильных дисплеев (проекция HUD на лобовое стекло, HDMI/DP).
 *
 * Оптимизировано для оптического совмещения (AR):
 * Глубокий черный фон (в Micro-OLED / Birdbath очках черный цвет прозрачен),
 * высококонтрастные неоновые зеленые и янтарные индикаторы скорости, оборотов и DTC.
 *
 * Лицензия: GPL-3.0
 */
class ARHudPresentation(
    outerContext: Context,
    display: Display
) : Presentation(outerContext, display) {

    private lateinit var speedView: TextView
    private lateinit var rpmView: TextView
    private lateinit var coolantView: TextView
    private lateinit var dtcAlertView: TextView
    private lateinit var orientationView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = FrameLayout(context).apply {
            setBackgroundColor(Color.BLACK) // В AR-очках черный цвет оптически прозрачен
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        val container = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL or Gravity.TOP
            setPadding(48, 64, 48, 64)
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }

        // Заголовок HUD
        val header = TextView(context).apply {
            text = "ИИдеал-Авто • AR HUD ПРОЕКЦИЯ"
            textSize = 14f
            setTextColor(Color.parseColor("#38bdf8"))
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 16)
        }
        container.addView(header)

        // Блок скорости и оборотов
        val mainDash = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, 24, 0, 24)
        }

        speedView = TextView(context).apply {
            text = "0"
            textSize = 72f
            setTextColor(Color.parseColor("#10b981"))
            setPadding(16, 0, 8, 0)
        }
        val speedUnit = TextView(context).apply {
            text = "км/ч"
            textSize = 20f
            setTextColor(Color.parseColor("#6ee7b7"))
            setPadding(0, 48, 24, 0)
        }

        rpmView = TextView(context).apply {
            text = "780 RPM"
            textSize = 32f
            setTextColor(Color.parseColor("#f59e0b"))
            setPadding(24, 36, 0, 0)
        }

        mainDash.addView(speedView)
        mainDash.addView(speedUnit)
        mainDash.addView(rpmView)
        container.addView(mainDash)

        // Блок телеметрии (ОЖ, Вольтаж, Нагрузка)
        coolantView = TextView(context).apply {
            text = "ОЖ: 89°C  |  АКБ: 14.1 В  |  Дроссель: 14%  |  Лямбда: 1.00"
            textSize = 18f
            setTextColor(Color.parseColor("#93c5fd"))
            gravity = Gravity.CENTER
            setPadding(0, 8, 0, 16)
        }
        container.addView(coolantView)

        // Блок ориентации головы / очков (3DoF Head Tracking)
        orientationView = TextView(context).apply {
            text = "3DoF Tracking: Pitch 0° | Roll 0° | Yaw 0°"
            textSize = 13f
            setTextColor(Color.parseColor("#64748b"))
            gravity = Gravity.CENTER
            setPadding(0, 4, 0, 16)
        }
        container.addView(orientationView)

        // Блок предупреждений кодов DTC
        dtcAlertView = TextView(context).apply {
            text = "СИСТЕМА В НОРМЕ (DTC ошибок нет)"
            textSize = 18f
            setTextColor(Color.parseColor("#10b981"))
            gravity = Gravity.CENTER
            setPadding(16, 12, 16, 12)
        }
        container.addView(dtcAlertView)

        root.addView(container)
        setContentView(root)
    }

    fun updateTelemetry(speed: Int, rpm: Int, coolantTemp: Int, dtcCount: Int, dtcSummary: String? = null) {
        if (!::speedView.isInitialized) return
        speedView.text = speed.toString()
        rpmView.text = "$rpm RPM"
        coolantView.text = "ОЖ: ${coolantTemp}°C  |  АКБ: 14.1 В  |  Дроссель: 14%"
        if (dtcCount > 0) {
            dtcAlertView.setTextColor(Color.parseColor("#ef4444"))
            dtcAlertView.text = "ВНИМАНИЕ DTC ($dtcCount): ${dtcSummary ?: "Требуется диагностика"}"
        } else {
            dtcAlertView.setTextColor(Color.parseColor("#10b981"))
            dtcAlertView.text = "СИСТЕМА В НОРМЕ (DTC ошибок нет)"
        }
    }

    fun updateOrientation(pitch: Float, roll: Float, yaw: Float) {
        if (!::orientationView.isInitialized) return
        orientationView.text = String.format("3DoF AR HUD: Pitch %.1f° | Roll %.1f° | Yaw %.1f°", pitch, roll, yaw)
    }
}
