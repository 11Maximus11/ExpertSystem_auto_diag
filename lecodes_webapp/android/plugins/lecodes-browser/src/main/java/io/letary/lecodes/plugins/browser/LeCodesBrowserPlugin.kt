//
//  LeCodesBrowserPlugin.kt — lecodes-plugins/browser
//
//  The "browser" service (the system sheet: a Chrome Custom Tab) and the embedded web view on its
//  two surfaces, one page class under both (WebViewPage.kt) — the Kotlin twin of BrowserPlugin.swift:
//   - the VIEW "webView" (WebViewInstance): the fullscreen page the app pushes or opens; its params
//     are read once, at creation, and its view is the WebView itself;
//   - the HOST NODE "webView" (WebViewNodeInstance): the page as a box of a screen's layout, laid
//     out and painted by the core's holder (UINodeHost); `url`, `stops` and `externalLinks` are LIVE.
//  WHEN and WITH WHAT to open them is the app's code; the channels themselves (the calls, the params,
//  the props, the events) are BrowserPlugin.gen.kt, generated from contract.d.ts.
//
//  The node's rules (BrowserPlugin.swift's):
//   - Its props arrive one by one (the holder hands each write over, `kind` first), and three of them
//     are made into the WebView (`bridge` — a JavaScript interface and a document-start script —,
//     `userAgent`, `ephemeral`). So the page is made at the END of the node's first commit — a
//     main-looper turn after the instance — from every prop that commit wrote, its `url` the first
//     page. The instance's view is a plain FrameLayout that takes the WebView in then.
//   - Later commits are applied the same way, once per commit: `stops` and `externalLinks` take
//     effect for the next navigation, a `url` write loads it (a cleared one loads nothing). A later
//     write of a creation prop that changes it is ignored, with one log line per prop.
//   - A call flushes what is pending first: it sees every prop written before it.
//   - `destroy` (the node released) tears the page down; a flush after it does nothing.
//

package io.letary.lecodes.plugins.browser

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.services.Reply

object LeCodesBrowserPlugin {

    const val PLUGIN_ID = "browser"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        BrowserChannel.register(engine) { _, events -> BrowserSheet(engine, appContext, events) }
        WebViewChannel.register(engine) { params, events -> WebViewInstance(appContext, params, events) }
        UIWebViewNodeGlue.register(engine) { events -> WebViewNodeInstance(appContext, events) }
    }
}

// ---- the View ---------------------------------------------------------------------------------

/** The view "webView": a WebViewPage made from the View's params, its WebView the View's. */
internal class WebViewInstance(context: Context, params: WebViewParams, events: WebViewEvents) : WebViewPlugin {
    private val page = WebViewPage(context, params, events.sink(), PageCodes(WebViewCode.INVALID, WebViewCode.FAILED))

    override val view: View get() = page.view

    override fun destroy() = page.destroy()

    override fun load(url: String, headers: Map<String, String>?, reply: Reply<Unit, WebViewCode>) = page.load(url, headers, reply)
    override fun loadHtml(html: String, baseUrl: String?, reply: Reply<Unit, WebViewCode>) = page.loadHtml(html, baseUrl, reply)
    override fun setStops(stops: List<String>, reply: Reply<Unit, WebViewCode>) = page.setStops(stops, reply)
    override fun reload(reply: Reply<Unit, WebViewCode>) = page.reload(reply)
    override fun stopLoading(reply: Reply<Unit, WebViewCode>) = page.stopLoading(reply)
    override fun goBack(reply: Reply<Unit, WebViewCode>) = page.goBack(reply)
    override fun goForward(reply: Reply<Unit, WebViewCode>) = page.goForward(reply)
    override fun canGoBack(reply: Reply<Boolean, WebViewCode>) = page.canGoBack(reply)
    override fun evaluate(js: String, reply: Reply<Any, WebViewCode>) = page.evaluate(js, reply)
    override fun postMessage(data: Any, reply: Reply<Unit, WebViewCode>) = page.postMessage(data, reply)
    override fun clearData(reply: Reply<Unit, WebViewCode>) = page.clearData(reply)
}

// ---- the host node ----------------------------------------------------------------------------

/** The host node "webView": a box of the layout holding a WebViewPage (the header's rules). */
internal class WebViewNodeInstance(private val context: Context, private val events: UIWebViewNodeEvents) : UIWebViewNodeInstance {
    private enum class Prop { URL, STOPS, EXTERNAL_LINKS }

    private val box = FrameLayout(context)
    override val view: View get() = box
    /** Every prop as written last, in the View's params' fields: what the page is made from. */
    private var props = WebViewParams()
    private val dirty = mutableSetOf<Prop>()
    private var flushQueued = true
    private var page: WebViewPage<UIWebViewNodeCode>? = null
    /** The creation props a write after the page was made changed — logged once each. */
    private val ignored = mutableSetOf<String>()
    private var destroyed = false

    init {
        // The end of the first commit: its props are in by then.
        main.post { flush() }
    }

    override fun setUrl(value: String?) { props = props.copy(url = value); mark(Prop.URL) }
    override fun setStops(value: List<String>?) { props = props.copy(stops = value); mark(Prop.STOPS) }
    override fun setExternalLinks(value: WebViewPropsExternalLinks?) {
        props = props.copy(externalLinks = value?.let { if (it == WebViewPropsExternalLinks.BLOCK) WebViewParamsExternalLinks.BLOCK else WebViewParamsExternalLinks.OPEN })
        mark(Prop.EXTERNAL_LINKS)
    }
    override fun setBridge(value: Boolean?) {
        if (creating("bridge", (value ?: false) != (props.bridge ?: false))) props = props.copy(bridge = value)
    }
    override fun setUserAgent(value: String?) {
        if (creating("userAgent", value != props.userAgent)) props = props.copy(userAgent = value)
    }
    override fun setEphemeral(value: Boolean?) {
        if (creating("ephemeral", (value ?: false) != (props.ephemeral ?: false))) props = props.copy(ephemeral = value)
    }

    /** A creation prop: taken while the page is not made yet; after, a write that changes it is
     *  ignored, with one log line per prop. */
    private fun creating(prop: String, changes: Boolean): Boolean {
        if (page == null && !destroyed) return true
        if (changes && ignored.add(prop)) {
            Log.w("LeCodes", "UIWebViewNode: `$prop` is read when the page is made, at the node's first commit — the later write is ignored")
        }
        return false
    }

    override fun destroy() {
        destroyed = true
        page?.destroy()
        page = null
    }

    /** A live prop changed: applied with the rest of its commit, a main-looper turn later. */
    private fun mark(prop: Prop) {
        dirty.add(prop)
        if (flushQueued) return
        flushQueued = true
        main.post { flush() }
    }

    /** Apply what was written since the last flush — the first one makes the page from every prop.
     *  The page; null once destroyed. */
    private fun flush(): WebViewPage<UIWebViewNodeCode>? {
        flushQueued = false
        if (destroyed) return null
        val changed = dirty.toSet()
        dirty.clear()
        val p = page ?: return WebViewPage(context, props, events.sink(), CODES).also { made ->
            box.addView(made.view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            page = made
        }
        if (Prop.STOPS in changed) p.stops = props.stops ?: emptyList()
        if (Prop.EXTERNAL_LINKS in changed) p.openExternal = props.externalLinks != WebViewParamsExternalLinks.BLOCK
        if (Prop.URL in changed) props.url?.let { p.open(it) }
        return p
    }

    // The calls see every prop written before them.

    override fun load(url: String, headers: Map<String, String>?, reply: Reply<Unit, UIWebViewNodeCode>) {
        val p = flush() ?: return reply.fail(GONE)
        p.load(url, headers, reply)
    }
    override fun loadHtml(html: String, baseUrl: String?, reply: Reply<Unit, UIWebViewNodeCode>) {
        val p = flush() ?: return reply.fail(GONE)
        p.loadHtml(html, baseUrl, reply)
    }
    override fun setStops(stops: List<String>, reply: Reply<Unit, UIWebViewNodeCode>) {
        val p = flush() ?: return reply.fail(GONE)
        props = props.copy(stops = stops)
        p.setStops(stops, reply)
    }
    override fun reload(reply: Reply<Unit, UIWebViewNodeCode>) {
        val p = flush() ?: return reply.fail(GONE)
        p.reload(reply)
    }
    override fun stopLoading(reply: Reply<Unit, UIWebViewNodeCode>) {
        val p = flush() ?: return reply.fail(GONE)
        p.stopLoading(reply)
    }
    override fun goBack(reply: Reply<Unit, UIWebViewNodeCode>) {
        val p = flush() ?: return reply.fail(GONE)
        p.goBack(reply)
    }
    override fun goForward(reply: Reply<Unit, UIWebViewNodeCode>) {
        val p = flush() ?: return reply.fail(GONE)
        p.goForward(reply)
    }
    override fun canGoBack(reply: Reply<Boolean, UIWebViewNodeCode>) {
        val p = flush() ?: return reply.fail(GONE)
        p.canGoBack(reply)
    }
    override fun evaluate(js: String, reply: Reply<Any, UIWebViewNodeCode>) {
        val p = flush() ?: return reply.fail(GONE)
        p.evaluate(js, reply)
    }
    override fun postMessage(data: Any, reply: Reply<Unit, UIWebViewNodeCode>) {
        val p = flush() ?: return reply.fail(GONE)
        p.postMessage(data, reply)
    }
    override fun clearData(reply: Reply<Unit, UIWebViewNodeCode>) {
        val p = flush() ?: return reply.fail(GONE)
        p.clearData(reply)
    }

    private companion object {
        val CODES = PageCodes(UIWebViewNodeCode.INVALID, UIWebViewNodeCode.FAILED)
        const val GONE = "the host node is gone"
        val main by lazy { Handler(Looper.getMainLooper()) }
    }
}
