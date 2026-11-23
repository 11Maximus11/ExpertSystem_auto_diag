//
//  BrowserSheet.kt — lecodes-plugins/browser
//
//  The "browser" service: a Chrome Custom Tab over the app's activity (the system browser's
//  cookies and passkeys, the toolbar in the app's color). A tab cannot be asked whether it is still
//  up, so its end is the activity's RESUME after the tab took the foreground: that is when `show`
//  resolves and `closed` fires. A redirect to the app's own scheme reaches the activity as a new
//  intent (singleTask), which the host turns into the "url" app event — this half never sees it,
//  the SDK does. `callbackScheme` is therefore unused here, `ephemeral` cannot be honored.
//
//  One sheet at a time: a second `show` while one is up rejects with `busy`.
//

package io.letary.lecodes.plugins.browser

import android.app.Activity
import android.app.Application
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.services.Reply

class BrowserSheet(
    private val engine: LecodesEngine,
    private val appContext: Context,
    private val events: BrowserEvents,
) : BrowserPlugin {

    private var pending: Reply<BrowserResult, BrowserCode>? = null
    /** The tab is up (until the activity resumes after having paused for it). */
    private var launched = false
    private var paused = false

    private val lifecycle = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityPaused(activity: Activity) { if (launched && activity === engine.getActivity()) paused = true }
        override fun onActivityResumed(activity: Activity) { if (launched && paused && activity === engine.getActivity()) finish() }
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
        override fun onActivityStarted(activity: Activity) {}
        override fun onActivityStopped(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
    }

    override fun show(url: String, options: BrowserOpenOptions?, reply: Reply<BrowserResult, BrowserCode>) {
        if (pending != null) return reply.reject(BrowserCode.BUSY)
        val uri = runCatching { Uri.parse(url) }.getOrNull()
        val scheme = uri?.scheme?.lowercase()
        if (uri == null || (scheme != "http" && scheme != "https")) return reply.reject(BrowserCode.INVALID)
        val activity = engine.getActivity() ?: return reply.reject(BrowserCode.INVALID)

        val builder = CustomTabsIntent.Builder().setShowTitle(true)
        parseColor(options?.color)?.let { color ->
            builder.setDefaultColorSchemeParams(CustomTabColorSchemeParams.Builder().setToolbarColor(color).build())
        }
        pending = reply
        launched = true
        paused = false
        (appContext as Application).registerActivityLifecycleCallbacks(lifecycle)
        try {
            builder.build().launchUrl(activity, uri)
        } catch (_: ActivityNotFoundException) {
            // No browser that hosts a tab: the system's own handler, whatever it is.
            try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
            } catch (_: Exception) {
                pending = null
                launched = false
                (appContext as Application).unregisterActivityLifecycleCallbacks(lifecycle)
                reply.reject(BrowserCode.INVALID)
            }
        }
    }

    /** The SDK's dismiss (its return URL arrived as the "url" event): the activity is already in
     *  front — the redirect intent cleared the tab above it — so the sheet is over. */
    override fun dismiss(reply: Reply<Unit, BrowserCode>) {
        if (launched) {
            engine.getActivity()?.let { activity ->
                activity.startActivity(Intent(activity, activity.javaClass).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            }
            finish()
        }
        reply.resolve(Unit)
    }

    override fun close() { finish() }

    private fun finish() {
        if (!launched) return
        launched = false
        paused = false
        (appContext as Application).unregisterActivityLifecycleCallbacks(lifecycle)
        val reply = pending ?: return
        pending = null
        reply.resolve(BrowserResult(url = null))
        events.closed()
    }

    private fun parseColor(hex: String?): Int? {
        val s = hex?.trim() ?: return null
        if (!s.startsWith("#")) return null
        val body = if (s.length == 4) s.drop(1).map { "$it$it" }.joinToString("") else s.drop(1)
        if (body.length != 6 && body.length != 8) return null
        // "#RRGGBBAA" on the wire; Android's Color.parseColor wants "#AARRGGBB".
        val argb = if (body.length == 8) body.substring(6) + body.substring(0, 6) else body
        return runCatching { Color.parseColor("#$argb") }.getOrNull()
    }
}
