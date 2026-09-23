import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CronJobEditorSmokeTests {
    private func makeEditor(job: CronJob? = nil, channelsStore: ChannelsStore? = nil) -> CronJobEditor {
        CronJobEditor(
            job: job,
            isSaving: .constant(false),
            error: .constant(nil),
            channelsStore: channelsStore ?? ChannelsStore(isPreview: true),
            onCancel: {},
            onSave: { _ in })
    }

    @Test func `cron job editor preserves advanced delivery routes`() {
        let channelsStore = ChannelsStore(isPreview: true)
        let job = CronJob(
            id: "job-1",
            agentId: "ops",
            name: "Daily summary",
            description: nil,
            enabled: true,
            deleteAfterRun: nil,
            createdAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_000_000,
            schedule: .every(everyMs: 3_600_000, anchorMs: 1_700_000_000_000),
            sessionTarget: .isolated,
            wakeMode: .nextHeartbeat,
            payload: .agentTurn(
                message: "Summarize the last day",
                thinking: "low",
                timeoutSeconds: 120,
                deliver: nil,
                channel: nil,
                to: nil,
                bestEffortDeliver: nil),
            delivery: CronDelivery(
                mode: .announce,
                channel: "whatsapp",
                to: "+15551234567",
                bestEffort: true,
                threadId: AnyCodable(42),
                completionDestination: [
                    "mode": AnyCodable("webhook"),
                    "to": AnyCodable("https://example.test/complete"),
                ],
                failureDestination: [
                    "mode": AnyCodable("announce"),
                    "channel": AnyCodable("telegram"),
                    "to": AnyCodable("ops"),
                    "accountId": AnyCodable("alerts"),
                ]),
            state: CronJobState(
                nextRunAtMs: 1_700_000_100_000,
                runningAtMs: nil,
                lastRunAtMs: 1_700_000_050_000,
                lastStatus: "ok",
                lastError: nil,
                lastDurationMs: 1000))

        let view = self.makeEditor(job: job, channelsStore: channelsStore)
        let delivery = view.buildDelivery()
        #expect(delivery["threadId"] as? Int == 42)
        #expect((delivery["completionDestination"] as? [String: Any])?["to"] as? String ==
            "https://example.test/complete")
        #expect((delivery["failureDestination"] as? [String: Any])?["accountId"] as? String == "alerts")
    }

    @Test func `cron job editor includes delete after run for at schedule`() {
        let view = self.makeEditor()

        var root: [String: Any] = [:]
        view.applyDeleteAfterRun(to: &root, scheduleKind: CronJobEditor.ScheduleKind.at, deleteAfterRun: true)
        let raw = root["deleteAfterRun"] as? Bool
        #expect(raw == true)
    }

    @Test func `cron duration parsing rejects overflow without changing valid values`() {
        let cases: [(String, Int?)] = [
            ("9999999999999999999d", nil), // MACOS-R4-01-C01
            ("9223372036854774784ms", 9223372036854774784), // C02
            ("9223372036854775808ms", nil), // C03
            ("9999999999999999999h", nil), // C04
            ("9999999999999999999m", nil), // C05
            ("9999999999999999999s", nil), // C06
            (String(repeating: "9", count: 307) + "d", nil), // C07
            ("15m", 900_000), // C08
            ("0ms", nil), // C09
            ("1.2.3s", nil), // C10
        ]
        for (input, expected) in cases {
            #expect(CronJobEditor.parseDurationMs(input) == expected)
        }
        #expect(CronJobEditor.parseDurationMs("-1ms") == nil) // C09 negative control
        #expect(CronJobEditor.parseDurationMs("0.5ms") == 0) // Existing sub-ms rounding
    }
}
