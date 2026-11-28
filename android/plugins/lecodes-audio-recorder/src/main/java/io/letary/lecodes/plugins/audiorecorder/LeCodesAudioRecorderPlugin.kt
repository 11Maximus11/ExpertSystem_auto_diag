//
//  LeCodesAudioRecorderPlugin.kt — lecodes-plugins/audio-recorder
//
//  The "audioRecorder" service: audio recording to a file over android.media.MediaRecorder. A
//  session is one recording. The microphone permission is the contract's (`@permission
//  microphone`): the generated glue asks the host before `start` reaches the service; the merged
//  manifest carries RECORD_AUDIO.
//

package io.letary.lecodes.plugins.audiorecorder

import android.content.Context
import io.letary.lecodes.LecodesEngine

object LeCodesAudioRecorderPlugin {

    const val PLUGIN_ID = "audio-recorder"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        AudioRecorderChannel.register(engine) { _, events -> AudioRecorderService(appContext, events) }
    }
}
