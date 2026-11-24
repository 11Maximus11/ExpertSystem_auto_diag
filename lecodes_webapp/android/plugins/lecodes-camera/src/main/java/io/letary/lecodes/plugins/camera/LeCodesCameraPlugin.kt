//
//  LeCodesCameraPlugin.kt — lecodes-plugins/camera
//
//  The plugin's two surfaces, one camera preview class under both (CameraPreview.kt) — the Kotlin
//  twin of CameraPlugin.swift:
//   - the VIEW "camera" (CameraViewInstance): the fullscreen preview the app pushes or opens; its
//     params are read once, at creation, and its view is the preview itself;
//   - the HOST NODE "camera" (CameraNodeInstance): the preview as a box of a screen's layout, laid
//     out and painted by the core's holder (UINodeHost); its prop `facingMode` is LIVE.
//  WHEN and WITH WHAT to show either is app (TS) code. The channels are the contract's
//  (../contract.d.ts): CameraViewPlugin.gen.kt is generated from it (one file for both surfaces).
//
//  The camera permission (CameraPlugin.swift's rules):
//   - the View's is asked by the SDK's wrapper BEFORE the View is presented, so the View starts at
//     once;
//   - the node's is asked HERE, through the engine's permissions (the SDK's same service): a node is
//     no destination, nothing presents it. The camera opens a main-looper turn after the instance is
//     made — the node's first commit hands its props over right after the `kind` write that made it,
//     so the camera opened is the one `facingMode` says — once the permission is granted; denied (or
//     no activity to ask on), the node sends `error` and stays an empty preview.
//

package io.letary.lecodes.plugins.camera

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.View
import io.letary.lecodes.LecodesEngine
import io.letary.lecodes.services.Permissions
import io.letary.lecodes.services.PluginCode
import io.letary.lecodes.services.PluginFile
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve

object LeCodesCameraPlugin {

    const val PLUGIN_ID = "camera"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        CameraViewChannel.register(engine) { params, events -> CameraViewInstance(appContext, params, events) }
        UICameraNodeGlue.register(engine) { events -> CameraNodeInstance(appContext, engine.permissions, events) }
    }
}

/** `takePhoto` of both surfaces: the frame as a JPEG File, [failed] without one. */
private fun <C : PluginCode> CameraPreview.takePhoto(reply: Reply<PluginFile, C>, failed: C) {
    takePhoto { bytes ->
        if (bytes == null) reply.reject(failed)
        else reply.resolve(PluginFile(bytes, "image.jpg"))
    }
}

// ---- the View ---------------------------------------------------------------------------------

/** The view "camera": a CameraPreview started at once, on the camera of the View's params. */
internal class CameraViewInstance(context: Context, params: CameraParams, events: CameraViewEvents) : CameraViewPlugin {
    private val preview = CameraPreview(context, params.facingMode.mode()).also {
        it.onError = { message -> events.error(message) }
        it.start()
    }

    override val view: View get() = preview

    override fun takePhoto(reply: Reply<PluginFile, CameraViewCode>) = preview.takePhoto(reply, CameraViewCode.FAILED)

    override fun setFacingMode(mode: Facing, reply: Reply<Unit, CameraViewCode>) {
        preview.cameraSetFacingMode(mode.mode())
        reply.resolve()
    }

    override fun destroy() = preview.shutdown()
}

// ---- the host node ----------------------------------------------------------------------------

/** The host node "camera": a CameraPreview as the node's box, opened after the first commit and the
 *  permission (the header's rules). */
internal class CameraNodeInstance(
    context: Context,
    private val permissions: Permissions,
    private val events: UICameraNodeEvents,
) : UICameraNodeInstance {
    private val preview = CameraPreview(context).also { it.onError = { message -> events.error(message) } }
    private var destroyed = false

    override val view: View get() = preview

    init {
        main.post { askThenStart() }
    }

    private fun askThenStart() {
        if (destroyed) return
        permissions.request(Permissions.Kind.CAMERA, onError = { message -> if (!destroyed) events.error(message) }) { state ->
            if (destroyed) return@request
            if (state == Permissions.State.GRANTED) preview.start()
            else events.error("The camera permission was denied")
        }
    }

    /** A write switches the camera (before the start: picks the one it opens). */
    override fun setFacingMode(value: Facing?) = preview.cameraSetFacingMode(value.mode())

    override fun takePhoto(reply: Reply<PluginFile, UICameraNodeCode>) = preview.takePhoto(reply, UICameraNodeCode.FAILED)

    override fun setFacingMode(mode: Facing, reply: Reply<Unit, UICameraNodeCode>) {
        preview.cameraSetFacingMode(mode.mode())
        reply.resolve()
    }

    /** The node released: the camera closes for good. */
    override fun destroy() {
        destroyed = true
        preview.shutdown()
    }

    private companion object {
        val main by lazy { Handler(Looper.getMainLooper()) }
    }
}
