package ai.openclaw.app.chat

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerFinalizedMultipartTest {
  private fun terminal(
    runId: String,
    parts: List<Pair<String, String>>,
    state: String = "final",
  ): String =
    buildJsonObject {
      put("sessionKey", JsonPrimitive("agent:other:session-a"))
      put("runId", JsonPrimitive(runId))
      put("seq", JsonPrimitive(1))
      put("state", JsonPrimitive(state))
      put(
        "message",
        buildJsonObject {
          put("role", JsonPrimitive("assistant"))
          put(
            "content",
            JsonArray(
              parts.map { (type, text) ->
                buildJsonObject {
                  put("type", JsonPrimitive(type))
                  put("text", JsonPrimitive(text))
                }
              },
            ),
          )
        },
      )
    }.toString()

  private fun TestScope.deliverFinal(parts: List<Pair<String, String>>): List<String> {
    val notifications = mutableListOf<String>()
    val controller =
      createChatController(
        cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
        currentDefaultAgentId = { "main" },
        onAssistantReplyFinalized = { _, _, text -> notifications += text },
      )
    controller.prepareMainSessionKey("agent:main:session-b")
    controller.handleGatewayEvent("health", null)
    controller.handleGatewayEvent("chat", terminal("multipart-final", parts))
    return notifications
  }

  @Test fun twoPlainBlocksReachFinalCallback() = runTest {
    assertEquals(listOf("Part one\n\nPart two"), deliverFinal(listOf("text" to "Part one", "text" to "Part two")))
  }

  @Test fun threeBlocksStayOrdered() = runTest {
    assertEquals(listOf("One\n\nTwo\n\nThree"), deliverFinal(listOf("text" to "One", "text" to "Two", "text" to "Three")))
  }

  @Test fun leadingEmptyBlockDoesNotHideLaterText() = runTest {
    assertEquals(listOf("Later"), deliverFinal(listOf("text" to "", "text" to "Later")))
  }

  @Test fun middleEmptyBlockDoesNotAddParagraph() = runTest {
    assertEquals(listOf("First\n\nLast"), deliverFinal(listOf("text" to "First", "text" to "", "text" to "Last")))
  }

  @Test fun imagePartIsNotNotificationProse() = runTest {
    assertEquals(listOf("Before\n\nAfter"), deliverFinal(listOf("text" to "Before", "image" to "secret-image-metadata", "text" to "After")))
  }

  @Test fun reasoningPartIsNotNotificationProse() = runTest {
    assertEquals(listOf("Answer A\n\nAnswer B"), deliverFinal(listOf("text" to "Answer A", "reasoning" to "hidden thinking", "text" to "Answer B")))
  }

  @Test fun whitespaceBoundariesRemainReadable() = runTest {
    assertEquals(listOf("hello\n\nworld"), deliverFinal(listOf("text" to "  hello ", "text" to "\n world  ")))
  }

  @Test fun singleBlockKeepsExistingFinalValue() = runTest {
    assertEquals(listOf("Done"), deliverFinal(listOf("text" to " Done ")))
  }

  @Test fun deltaStreamingStillUsesExistingFirstTextParser() = runTest {
    val notifications = mutableListOf<String>()
    val controller =
      createChatController(
        cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
        currentDefaultAgentId = { "main" },
        onAssistantReplyFinalized = { _, _, text -> notifications += text },
      ) { method, _ ->
        if (method == "chat.send") """{"runId":"delta-run","status":"started"}"""
        else emptyChatGatewayResponse(method)
      }
    controller.prepareMainSessionKey("agent:main:main")
    controller.load(controller.sessionKey.value)
    runCurrent()
    controller.sendMessageAwaitAcceptance("status", "off", emptyList())
    val delta =
      buildJsonObject {
        put("sessionKey", JsonPrimitive("agent:main:main"))
        put("runId", JsonPrimitive("delta-run"))
        put("seq", JsonPrimitive(1))
        put("state", JsonPrimitive("delta"))
        put(
          "message",
          buildJsonObject {
            put("role", JsonPrimitive("assistant"))
            put("content", JsonArray(listOf(
              buildJsonObject { put("type", JsonPrimitive("text")); put("text", JsonPrimitive("First")) },
              buildJsonObject { put("type", JsonPrimitive("text")); put("text", JsonPrimitive("Second")) },
            )))
          },
        )
      }.toString()
    controller.handleGatewayEvent("chat", delta)
    assertEquals("First", controller.streamingAssistantText.value)
    assertEquals(emptyList<String>(), notifications)
  }

  @Test fun duplicateTerminalDoesNotRepeatFinalCallback() = runTest {
    val notifications = mutableListOf<String>()
    val controller =
      createChatController(
        cacheScope = { ChatCacheScope(gatewayId = "gateway-a", connectionGeneration = 1) },
        currentDefaultAgentId = { "main" },
        onAssistantReplyFinalized = { _, _, text -> notifications += text },
      )
    controller.prepareMainSessionKey("agent:main:session-b")
    controller.handleGatewayEvent("health", null)
    val event = terminal("run-once", listOf("text" to "A", "text" to "B"))
    controller.handleGatewayEvent("chat", event)
    controller.handleGatewayEvent("chat", event)
    assertEquals(listOf("A\n\nB"), notifications)
  }
}
