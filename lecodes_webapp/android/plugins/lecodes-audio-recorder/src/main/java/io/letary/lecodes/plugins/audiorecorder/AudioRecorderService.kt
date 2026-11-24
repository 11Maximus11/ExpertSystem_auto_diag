//
//  AudioRecorderService.kt — lecodes-plugins/audio-recorder
//
//  One recording: MediaRecorder into a cache .m4a (AAC), its amplitude polled ten times a second
//  for the `level` event, stopped by the app or by its own limit (`maxDuration`). The file is kept
//  until `stop()` hands it over or `cancel()`. The channel (the calls, the options, the codes) is
//  AudioRecorder.gen.kt, generated from contract.d.ts; a call arrives with the microphone
//  permission granted. Main thread.
//

package io.letary.lecodes.plugins.audiorecorder

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import io.letary.lecodes.services.PluginFile
import io.letary.lecodes.services.Reply
import io.letary.lecodes.services.resolve
import java.io.File

class AudioRecorderService(
    private val context: Context,
    private val events: AudioRecorderEvents,
) : AudioRecorderPlugin {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var recorder: MediaRecorder? = null
    private var file: File? = null
    /** Milliseconds recorded before the running segment, and when the running segment began (0 = paused). */
    private var recordedMs = 0L
    private var segmentStart = 0L
    /** The recording stopped on its own: the file is complete and waits for stop(). */
    private var finished = false

    private val meter = object : Runnable {
        override fun run() {
            val r = recorder ?: return
            if (segmentStart == 0L) return
            val amplitude = runCatching { r.maxAmplitude }.getOrDefault(0)
            events.level(value = (amplitude / 32767.0).coerceIn(0.0, 1.0))
            mainHandler.postDelayed(this, 100)
        }
    }

    // ── the calls ────────────────────────────────────────────────────────────

    override fun start(options: RecordOptions?, reply: Reply<Unit, AudioRecorderCode>) {
        if (recorder != null || file != null) return reply.reject(AudioRecorderCode.BUSY)
        val out = File(context.cacheDir, "lecodes-recording-${System.currentTimeMillis()}.m4a")
        @Suppress("DEPRECATION")
        val r = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else MediaRecorder()
        try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioChannels(1)
            r.setAudioSamplingRate((options?.sampleRate ?: 44100.0).toInt())
            r.setAudioEncodingBitRate(((options?.bitrate ?: 64.0) * 1000).toInt())
            r.setOutputFile(out.absolutePath)
            val limit = options?.maxDuration ?: 0.0
            if (limit > 0) {
                r.setMaxDuration(limit.toInt())
                r.setOnInfoListener { _, what, _ ->
                    if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) finish(EndReason.MAX_DURATION)
                }
            }
            r.setOnErrorListener { _, _, _ -> finish(EndReason.FAILED) }
            r.prepare()
            r.start()
        } catch (e: Exception) {
            r.release()
            out.delete()
            return reply.reject(AudioRecorderCode.FAILED)
        }
        recorder = r
        file = out
        recordedMs = 0
        segmentStart = SystemClock.elapsedRealtime()
        finished = false
        mainHandler.post(meter)
        reply.resolve()
    }

    override fun pause(reply: Reply<Unit, AudioRecorderCode>) {
        val r = recorder ?: return reply.reject(AudioRecorderCode.NOT_RECORDING)
        if (finished) return reply.reject(AudioRecorderCode.NOT_RECORDING)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return reply.reject(AudioRecorderCode.FAILED)   // no pause before Android 7
        if (segmentStart != 0L) {
            try { r.pause() } catch (e: Exception) { return reply.reject(AudioRecorderCode.FAILED) }
            recordedMs += SystemClock.elapsedRealtime() - segmentStart
            segmentStart = 0
            mainHandler.removeCallbacks(meter)
        }
        reply.resolve()
    }

    override fun resume(reply: Reply<Unit, AudioRecorderCode>) {
        val r = recorder ?: return reply.reject(AudioRecorderCode.NOT_RECORDING)
        if (finished) return reply.reject(AudioRecorderCode.NOT_RECORDING)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return reply.reject(AudioRecorderCode.FAILED)
        if (segmentStart == 0L) {
            try { r.resume() } catch (e: Exception) { return reply.reject(AudioRecorderCode.FAILED) }
            segmentStart = SystemClock.elapsedRealtime()
            mainHandler.post(meter)
        }
        reply.resolve()
    }

    override fun stop(reply: Reply<Recording, AudioRecorderCode>) {
        val out = file ?: return reply.reject(AudioRecorderCode.NOT_RECORDING)
        val stoppedCleanly = stopRecorder()
        val bytes = if (stoppedCleanly && out.exists()) out.readBytes() else ByteArray(0)
        val seconds = recordedMs / 1000.0
        discard()
        if (bytes.isEmpty()) return reply.reject(AudioRecorderCode.FAILED)
        reply.resolve(Recording(file = PluginFile(bytes, "recording.m4a"), mimeType = "audio/mp4", duration = seconds))
    }

    override fun cancel(reply: Reply<Unit, AudioRecorderCode>) {
        stopRecorder()
        discard()
        reply.resolve()
    }

    override fun close() {
        stopRecorder()
        discard()
    }

    // ── plumbing ─────────────────────────────────────────────────────────────

    /** The recording stopped on its own: keep the file, tell the app. */
    private fun finish(reason: EndReason) {
        if (finished) return
        val clean = stopRecorder()
        finished = true
        events.ended(reason = if (clean) reason else EndReason.FAILED)
    }

    /** Stops and releases the recorder; false when nothing could be written (stop() throws for a
     *  recording with no valid data). */
    private fun stopRecorder(): Boolean {
        val r = recorder ?: return true
        mainHandler.removeCallbacks(meter)
        if (segmentStart != 0L) {
            recordedMs += SystemClock.elapsedRealtime() - segmentStart
            segmentStart = 0
        }
        val clean = runCatching { r.stop() }.isSuccess
        r.release()
        recorder = null
        return clean
    }

    private fun discard() {
        file?.delete()
        file = null
        finished = false
    }
}
