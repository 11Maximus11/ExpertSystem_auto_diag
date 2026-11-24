//
//  LeCodesSpeechPlugin.kt — lecodes-plugins/speech
//
//  The "speech" service: speech recognition over android.speech.SpeechRecognizer (the device's
//  RecognitionService — Google's on most phones, none on some). The microphone permission is the
//  contract's (`@permission speech microphone`; both are RECORD_AUDIO here): the generated glue
//  asks the host before `start` reaches the service.
//

package io.letary.lecodes.plugins.speech

import android.content.Context
import io.letary.lecodes.LecodesEngine

object LeCodesSpeechPlugin {

    const val PLUGIN_ID = "speech"

    fun register(engine: LecodesEngine, context: Context) {
        val appContext = context.applicationContext
        SpeechChannel.register(engine) { _, events -> SpeechService(appContext, events) }
    }
}
