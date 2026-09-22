import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct GatewayHealthMonitorTests {
    @Test func stoppedThirdCheckCannotDisconnect() async {
        let probe = HealthCancellationProbe()
        let monitor = GatewayHealthMonitor(
            config: .init(intervalSeconds: 0, timeoutSeconds: 0, maxFailures: 3))
        monitor.start(
            check: { await probe.check() },
            onFailure: { count in await probe.failed(count) })
        await probe.waitUntilSuspended()
        monitor.stop()
        await probe.resume()
        // Drain the resumed main-actor task after the controlled check boundary.
        for _ in 0..<20 { await Task.yield() }
        let failures = await probe.failureCounts
        #expect(failures.isEmpty)
    }
}

private actor HealthCancellationProbe {
    private var checks = 0
    private var suspended = false
    private var waiter: CheckedContinuation<Void, Never>?
    private var checkContinuation: CheckedContinuation<Bool, Never>?
    private(set) var failureCounts: [Int] = []

    func check() async -> Bool {
        self.checks += 1
        if self.checks < 3 { return false }
        return await withCheckedContinuation { continuation in
            self.checkContinuation = continuation
            self.suspended = true
            self.waiter?.resume()
            self.waiter = nil
        }
    }

    func waitUntilSuspended() async {
        if self.suspended { return }
        await withCheckedContinuation { self.waiter = $0 }
    }

    func resume() {
        self.checkContinuation?.resume(returning: false)
        self.checkContinuation = nil
    }

    func failed(_ count: Int) { self.failureCounts.append(count) }
}
