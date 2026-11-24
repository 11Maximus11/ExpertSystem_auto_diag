//
//  SpeechService.kt — lecodes-plugins/speech
//
//  One listening: a SpeechRecognizer with the free-form intent, its RecognitionListener as events.
//  The service ends an utterance itself (onResults after a pause); a continuous listening starts
//  the next one. The channel (the calls, the options, the codes) is Speech.gen.kt, generated from
//  contract.d.ts; a call arrives with the microphone permission granted. Main thread.
//

package io.letary.lecodes.plugins.speech

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
import java.util.Locale

class SpeechService(
    private val context: Context,
    private val events: SpeechEvents,
) : SpeechPlugin {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var intent: Intent? = null
    private var continuous = false
    private var interim = true
    /** What the app asked for: STOP finishes the utterance, ABORT drops it; null = still listening. */
    private var ending: Ending? = null
    private enum class Ending { STOP, ABORT }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() = events.speechStart()
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() = events.speechEnd()
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partialResults: Bundle?) {
            if (!interim) return
            val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
            if (text.isNotEmpty()) events.result(SpeechResult(transcript = text, isFinal = false, confidence = null))
        }

        override fun onResults(results: Bundle?) {
            val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
            val confidence = results?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)?.firstOrNull()?.toDouble()?.takeIf { it >= 0 }
            if (ending != Ending.ABORT) events.result(SpeechResult(transcript = text, isFinal = true, confidence = confidence))
            utteranceDone()
        }

        override fun onError(error: Int) {
            if (ending == Ending.ABORT) return finish()
            when (error) {
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT ->
                    if (continuous && ending == null) utteranceDone() else fail(SpeechErrorCode.NO_SPEECH, "no speech was heard")
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER ->
                    fail(SpeechErrorCode.NETWORK, "the recognition service could not be reached")
                SpeechRecognizer.ERROR_AUDIO -> fail(SpeechErrorCode.AUDIO, "the microphone could not be read")
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> fail(SpeechErrorCode.DENIED, "the microphone permission was refused")
                else -> fail(SpeechErrorCode.FAILED, "recognizer error $error")
            }
        }
    }

    // ── the calls ────────────────────────────────────────────────────────────

    override fun start(options: SpeechOptions?, reply: Reply<Unit, SpeechCode>) {
        if (recognizer != null) return reply.reject(SpeechCode.BUSY)
        if (!SpeechRecognizer.isRecognitionAvailable(context)) return reply.reject(SpeechCode.UNAVAILABLE)
        val onDevice = options?.onDevice ?: false
        val r = try {
            if (onDevice && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) return reply.reject(SpeechCode.UNAVAILABLE)
                SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            } else SpeechRecognizer.createSpeechRecognizer(context)
        } catch (e: Exception) {
            return reply.reject(SpeechCode.UNAVAILABLE)
        }
        continuous = options?.continuous ?: false
        interim = options?.interimResults ?: true
        ending = null
        intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, options?.language ?: Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, interim)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            if (onDevice) putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }
        r.setRecognitionListener(listener)
        recognizer = r
        try {
            r.startListening(intent)
        } catch (e: Exception) {
            r.destroy()
            recognizer = null
            return reply.reject(SpeechCode.FAILED)
        }
        reply.resolve()
    }

    override fun stop(reply: Reply<Unit, SpeechCode>) {
        recognizer?.let { ending = Ending.STOP; it.stopListening() }   // onResults follows
        reply.resolve()
    }

    override fun abort(reply: Reply<Unit, SpeechCode>) {
        recognizer?.let { ending = Ending.ABORT; it.cancel(); finish() }   // cancel() calls nothing back
        reply.resolve()
    }

    override fun supportedLanguages(reply: Reply<List<String>, SpeechCode>) {
        // Android 13+: the recognition service says itself (its on-device languages, installed or
        // not, and its online ones). Before that, or when it cannot say: the language-details
        // broadcast, sent to each app that answers it BY PACKAGE — an implicit broadcast reaches no
        // other app's receiver since Android 8. What is known after two seconds is the answer.
        val found = sortedSetOf<String>()
        var probe: SpeechRecognizer? = null
        val release = { probe?.destroy(); probe = null }
        var settled = false
        val done = { if (!settled) { settled = true; release(); reply.resolve(found.toList()) } }
        mainHandler.postDelayed({ done() }, 2000)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && SpeechRecognizer.isRecognitionAvailable(context)) {
            val recognizer = try { SpeechRecognizer.createSpeechRecognizer(context) } catch (e: Exception) { null }
            if (recognizer != null) {
                probe = recognizer
                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                try {
                    recognizer.checkRecognitionSupport(intent, context.mainExecutor, object : RecognitionSupportCallback {
                        override fun onSupportResult(support: RecognitionSupport) {
                            release()
                            found.addAll(support.installedOnDeviceLanguages)
                            found.addAll(support.pendingOnDeviceLanguages)
                            found.addAll(support.supportedOnDeviceLanguages)
                            found.addAll(support.onlineLanguages)
                            if (found.isNotEmpty()) done() else broadcastLanguages(found, done)
                        }
                        override fun onError(error: Int) {
                            release()
                            broadcastLanguages(found, done)
                        }
                    })
                    return
                } catch (e: Exception) {
                    release()
                }
            }
        }
        broadcastLanguages(found, done)
    }

    /** ACTION_GET_LANGUAGE_DETAILS to every app with a receiver for it (the manifest's <queries>
     *  makes them visible), their EXTRA_SUPPORTED_LANGUAGES into [found]; [done] once all answered. */
    private fun broadcastLanguages(found: MutableSet<String>, done: () -> Unit) {
        val action = RecognizerIntent.ACTION_GET_LANGUAGE_DETAILS
        val packages = try {
            context.packageManager.queryBroadcastReceivers(Intent(action), 0).map { it.activityInfo.packageName }.distinct()
        } catch (e: Exception) {
            emptyList()
        }
        var waiting = packages.size
        if (waiting == 0) return done()
        for (pkg in packages) {
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context?, data: Intent?) {
                    getResultExtras(true)?.getStringArrayList(RecognizerIntent.EXTRA_SUPPORTED_LANGUAGES)?.let { found.addAll(it) }
                    if (--waiting == 0) done()
                }
            }
            try {
                context.sendOrderedBroadcast(Intent(action).setPackage(pkg), null, receiver, mainHandler, 0, null, null)
            } catch (e: Exception) {
                if (--waiting == 0) done()
            }
        }
    }

    override fun close() {
        ending = Ending.ABORT
        recognizer?.cancel()
        tearDown()
    }

    // ── plumbing ─────────────────────────────────────────────────────────────

    private fun utteranceDone() {
        val r = recognizer ?: return
        if (ending == null && continuous) {
            try { r.startListening(intent) } catch (e: Exception) { fail(SpeechErrorCode.FAILED, "the recognizer could not restart") }
        } else finish()
    }

    private fun fail(code: SpeechErrorCode, message: String) {
        events.error(code = code, message = message)
        finish()
    }

    private fun finish() {
        if (recognizer == null) return
        tearDown()
        events.end()
    }

    private fun tearDown() {
        recognizer?.destroy()
        recognizer = null
        intent = null
    }
}
