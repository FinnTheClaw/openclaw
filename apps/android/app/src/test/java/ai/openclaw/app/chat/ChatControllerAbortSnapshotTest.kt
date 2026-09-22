package ai.openclaw.app.chat

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerAbortSnapshotTest {
  @Test
  fun abortKeepsSelectionBeforeItsCoroutineStarts() =
    runTest {
      val requests = mutableListOf<String>()
      val controller =
        createChatController { method, params ->
          when (method) {
            "chat.send" -> """{"runId":"run-a","status":"started"}"""
            "chat.abort" -> {
              requests += checkNotNull(params)
              "{}"
            }
            else -> emptyChatGatewayResponse(method)
          }
        }
      controller.prepareMainSessionKey("agent:main:session-a")
      controller.load(controller.sessionKey.value)
      runCurrent()
      assertTrue(controller.sendMessageAwaitAcceptance("status", "off", emptyList()))

      controller.abort()
      controller.switchSession("agent:other:session-b")
      runCurrent()

      val request = chatControllerTestJson.parseToJsonElement(requests.single()).jsonObject
      assertEquals("agent:main:session-a", request.getValue("sessionKey").jsonPrimitive.content)
      assertEquals("run-a", request.getValue("runId").jsonPrimitive.content)
      assertEquals("agent:other:session-b", controller.sessionKey.value)
    }

  @Test
  fun abortWithoutPendingRunsDoesNotDispatch() =
    runTest {
      val requests = mutableListOf<String>()
      val controller =
        createChatController { method, _ ->
          requests += method
          emptyChatGatewayResponse(method)
        }
      runCurrent()
      controller.abort()
      controller.switchSession("agent:other:session-b")
      runCurrent()
      assertTrue("chat.abort" !in requests)
    }
}
