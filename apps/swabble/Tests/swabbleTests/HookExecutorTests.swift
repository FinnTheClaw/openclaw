import Foundation
@testable import Swabble
import XCTest

final class HookExecutorTests: XCTestCase {
    func testMinimumCharactersBeforeProcessAdmission() async throws {
        for text in ["", "a", "abc", "👨‍👩‍👧‍👦"] {
            var cfg = SwabbleConfig()
            cfg.hook.minCharacters = 4
            cfg.hook.command = "/nonexistent-swabble-hook"
            try await HookExecutor(config: cfg).run(job: HookJob(text: text, timestamp: Date()))
        }
    }

    func testMinimumBoundaryRunsAndShortJobDoesNotConsumeCooldown() async throws {
        let output = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: output) }
        var cfg = SwabbleConfig()
        cfg.hook.minCharacters = 4
        cfg.hook.cooldownSeconds = 60
        cfg.hook.command = "/bin/sh"
        cfg.hook.args = ["-c", "printf '%s' \"$SWABBLE_TEXT\" >> \"$HOOK_TEST_OUTPUT\""]
        cfg.hook.env = ["HOOK_TEST_OUTPUT": output.path]
        let executor = HookExecutor(config: cfg)
        try await executor.run(job: HookJob(text: "abc", timestamp: Date()))
        try await executor.run(job: HookJob(text: "abcd", timestamp: Date()))
        try await executor.run(job: HookJob(text: "later", timestamp: Date()))
        XCTAssertEqual(try String(contentsOf: output, encoding: .utf8), "abcd")
    }
}
