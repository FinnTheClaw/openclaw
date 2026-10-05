package ai.openclaw.app

import ai.openclaw.app.i18n.verbatimText
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NodeRuntimeExpiryIntervalTest {
  private val runtimes = mutableListOf<NodeRuntime>()

  @Before
  fun clearPlainPrefs() {
    RuntimeEnvironment
      .getApplication()
      .getSharedPreferences("openclaw.node", android.content.Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
  }

  @After
  fun cancelApprovalTimers() {
    runtimes.forEach { runtime -> schedule(runtime, emptyList()) }
  }

  @Test
  fun approvalFirstDeadlineAdvancesToSecondDeadline() = runBlocking {
    val runtime = runtime()
    val now = System.currentTimeMillis()
    schedule(runtime, listOf(approval("first", now + 250), approval("second", now + 850)))
    awaitIds(runtime, listOf("second"))
    awaitIds(runtime, emptyList())
  }

  @Test
  fun approvalThreeDeadlinesAdvanceInOrder() = runBlocking {
    val runtime = runtime()
    val now = System.currentTimeMillis()
    schedule(runtime, listOf(approval("one", now + 250), approval("two", now + 800), approval("three", now + 1_350)))
    awaitIds(runtime, listOf("two", "three"))
    awaitIds(runtime, listOf("three"))
    awaitIds(runtime, emptyList())
  }

  @Test
  fun approvalIsNotPrunedBeforeItsDeadline() = runBlocking {
    val runtime = runtime()
    schedule(runtime, listOf(approval("one", System.currentTimeMillis() + 900)))
    delay(100)
    assertEquals(listOf("one"), ids(runtime))
  }

  @Test
  fun approvalLaterReplacementCancelsEarlierTimer() = runBlocking {
    val runtime = runtime()
    val now = System.currentTimeMillis()
    schedule(runtime, listOf(approval("old", now + 250)))
    schedule(runtime, listOf(approval("new", now + 1_000)))
    delay(450)
    assertEquals(listOf("new"), ids(runtime))
    awaitIds(runtime, emptyList())
  }

  @Test
  fun approvalEarlierReplacementCancelsLaterTimer() = runBlocking {
    val runtime = runtime()
    val now = System.currentTimeMillis()
    schedule(runtime, listOf(approval("old", now + 1_000)))
    schedule(runtime, listOf(approval("new", now + 250)))
    awaitIds(runtime, emptyList())
  }

  @Test
  fun approvalResolvingFirstStillPrunesSecond() = runBlocking {
    val runtime = runtime()
    val now = System.currentTimeMillis()
    schedule(runtime, listOf(approval("first", now + 250), approval("second", now + 800)))
    runtime.javaClass
      .getDeclaredMethod("markExecApprovalResolved", String::class.java, GatewayExecApprovalNotice::class.java)
      .apply { isAccessible = true }
      .invoke(runtime, "first", null)
    assertEquals(listOf("second"), ids(runtime))
    awaitIds(runtime, emptyList())
  }

  @Test
  fun approvalEmptySnapshotRetiresTimer() {
    val runtime = runtime()
    schedule(runtime, listOf(approval("one", System.currentTimeMillis() + 900)))
    assertTrue(field<Job?>(runtime, "execApprovalExpiryPruneJob") != null)
    schedule(runtime, emptyList())
    assertNull(field<Job?>(runtime, "execApprovalExpiryPruneJob"))
    assertEquals(emptyList<String>(), ids(runtime))
  }

  @Test
  fun approvalWithoutDeadlineNeedsNoTimer() = runBlocking {
    val runtime = runtime()
    schedule(runtime, listOf(approval("one", null)))
    assertNull(field<Job?>(runtime, "execApprovalExpiryPruneJob"))
    delay(100)
    assertEquals(listOf("one"), ids(runtime))
  }

  @Test
  fun approvalAlreadyExpiredAtSchedulingIsPruned() = runBlocking {
    val runtime = runtime()
    schedule(runtime, listOf(approval("one", System.currentTimeMillis() - 1)))
    awaitIds(runtime, emptyList())
  }

  @Test
  fun approvalStaleTimerCannotPruneRenewedSameId() = runBlocking {
    val runtime = runtime()
    val now = System.currentTimeMillis()
    schedule(runtime, listOf(approval("same", now + 250)))
    schedule(runtime, listOf(approval("same", now + 1_000)))
    delay(450)
    assertEquals(listOf("same"), ids(runtime))
    awaitIds(runtime, emptyList())
  }

  private fun runtime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.expiry.interval.test." + UUID.randomUUID(),
        android.content.Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs)).also(runtimes::add)
  }

  private fun approval(id: String, expiresAtMs: Long?): GatewayExecApprovalSummary =
    GatewayExecApprovalSummary(
      id = id,
      commandText = verbatimText("echo ok"),
      commandPreview = "echo",
      warningText = null,
      allowedDecisions = listOf("allow-once", "deny"),
      host = "gateway",
      nodeId = null,
      agentId = "main",
      createdAtMs = 100,
      expiresAtMs = expiresAtMs,
    )

  private fun schedule(runtime: NodeRuntime, rows: List<GatewayExecApprovalSummary>) {
    synchronized(field<Any>(runtime, "execApprovalsStateLock")) {
      field<MutableStateFlow<GatewayExecApprovalInboxState>>(runtime, "mutableExecApprovalInbox").value = GatewayExecApprovalInboxState(approvals = rows)
      invoke(runtime, "scheduleExecApprovalExpiryPrune", List::class.java, rows)
    }
  }

  private fun ids(runtime: NodeRuntime): List<String> = runtime.execApprovalInbox.value.approvals.map { it.id }

  private suspend fun awaitIds(runtime: NodeRuntime, expected: List<String>) {
    withTimeout(5_000) {
      while (ids(runtime) != expected) delay(10)
    }
    assertEquals(expected, ids(runtime))
  }

  private fun invoke(runtime: NodeRuntime, name: String, parameter: Class<*>, value: Any): Any? =
    runtime.javaClass
      .getDeclaredMethod(name, parameter)
      .apply { isAccessible = true }
      .invoke(runtime, value)

  private fun <T> field(runtime: NodeRuntime, name: String): T {
    @Suppress("UNCHECKED_CAST")
    return runtime.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(runtime) as T
  }
}
