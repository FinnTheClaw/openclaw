package ai.openclaw.wear

import android.content.Context
import android.media.AudioManager
import android.speech.tts.TextToSpeech
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowTextToSpeech

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WearReplySpeakerTest {
  @Test
  fun deniedFocusDoesNotDispatchReadySpeech() {
    val context = RuntimeEnvironment.getApplication()
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val speaker = WearReplySpeaker(context)
    try {
      val engine = shadowOf(checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance()))
      engine.onInitListener.onInit(TextToSpeech.SUCCESS)
      shadowOf(manager).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)

      speaker.speak("Must not speak")

      assertTrue(engine.spokenTextList.isEmpty())
      assertFalse(speaker.isSpeaking.value)
    } finally {
      speaker.shutdown()
    }
  }

  @Test
  fun deniedFocusDoesNotDispatchDeferredInitializationSpeech() {
    val context = RuntimeEnvironment.getApplication()
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val speaker = WearReplySpeaker(context)
    try {
      val engine = shadowOf(checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance()))
      speaker.speak("Pending before initialization")
      shadowOf(manager).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
      engine.onInitListener.onInit(TextToSpeech.SUCCESS)

      assertTrue(engine.spokenTextList.isEmpty())
      assertFalse(speaker.isSpeaking.value)

      shadowOf(manager).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
      speaker.speak("Allowed")
      assertEquals(listOf("Allowed"), engine.spokenTextList)
    } finally {
      speaker.shutdown()
    }
  }
}
