import Foundation
import Testing
@testable import OpenClawMacCLI

struct WizardCommandTests {
    @Test func `B01 explicit URL ignores configured remote token`() throws {
        var config = GatewayConfig()
        config.mode = "remote"
        config.remoteToken = "stored-remote-token" // pragma: allowlist secret
        let endpoint = try resolveWizardGatewayEndpoint(
            opts: WizardCliOptions.parse(["--url", "wss://other.example.test"]), config: config)
        #expect(endpoint.token == nil)
    }

    @Test func `B02 explicit URL ignores configured remote password`() throws {
        var config = GatewayConfig()
        config.mode = "remote"
        config.remotePassword = "stored-remote-password" // pragma: allowlist secret
        let endpoint = try resolveWizardGatewayEndpoint(
            opts: WizardCliOptions.parse(["--url", "wss://other.example.test"]), config: config)
        #expect(endpoint.password == nil)
    }

    @Test func `B03 explicit URL ignores configured local token`() throws {
        var config = GatewayConfig()
        config.mode = "local"
        config.token = "stored-local-token" // pragma: allowlist secret
        let endpoint = try resolveWizardGatewayEndpoint(
            opts: WizardCliOptions.parse(["--url", "wss://other.example.test"]), config: config)
        #expect(endpoint.token == nil)
    }

    @Test func `B04 explicit URL ignores configured local password`() throws {
        var config = GatewayConfig()
        config.mode = "local"
        config.password = "stored-local-password" // pragma: allowlist secret
        let endpoint = try resolveWizardGatewayEndpoint(
            opts: WizardCliOptions.parse(["--url", "wss://other.example.test"]), config: config)
        #expect(endpoint.password == nil)
    }

    @Test func `B05 explicit URL ignores both configured auth fields`() throws {
        var config = GatewayConfig()
        config.mode = "remote"
        config.remoteToken = "stored-token" // pragma: allowlist secret
        config.remotePassword = "stored-password" // pragma: allowlist secret
        let endpoint = try resolveWizardGatewayEndpoint(
            opts: WizardCliOptions.parse(["--url", "wss://other.example.test"]), config: config)
        #expect(endpoint.token == nil)
        #expect(endpoint.password == nil)
    }

    @Test func `B06 explicit token does not bring stored password`() throws {
        var config = GatewayConfig()
        config.mode = "remote"
        config.remotePassword = "stored-password" // pragma: allowlist secret
        let endpoint = try resolveWizardGatewayEndpoint(
            opts: WizardCliOptions.parse([
                "--url", "wss://other.example.test",
                "--token", "explicit-token", // pragma: allowlist secret
            ]), config: config)
        #expect(endpoint.token == "explicit-token") // pragma: allowlist secret
        #expect(endpoint.password == nil)
    }

    @Test func `B07 explicit password does not bring stored token`() throws {
        var config = GatewayConfig()
        config.mode = "remote"
        config.remoteToken = "stored-token" // pragma: allowlist secret
        let endpoint = try resolveWizardGatewayEndpoint(
            opts: WizardCliOptions.parse([
                "--url", "wss://other.example.test",
                "--password", "explicit-password", // pragma: allowlist secret
            ]), config: config)
        #expect(endpoint.token == nil)
        #expect(endpoint.password == "explicit-password") // pragma: allowlist secret
    }

    @Test func `B08 explicit URL keeps both explicit auth fields`() throws {
        let endpoint = try resolveWizardGatewayEndpoint(
            opts: WizardCliOptions.parse([
                "--url", "wss://other.example.test",
                "--token", "explicit-token", // pragma: allowlist secret
                "--password", "explicit-password", // pragma: allowlist secret
            ]), config: GatewayConfig())
        #expect(endpoint.token == "explicit-token") // pragma: allowlist secret
        #expect(endpoint.password == "explicit-password") // pragma: allowlist secret
    }

    @Test func `B09 config selected remote URL keeps configured auth`() throws {
        var config = GatewayConfig()
        config.mode = "remote"
        config.remoteUrl = "wss://configured.example.test"
        config.remoteToken = "stored-token" // pragma: allowlist secret
        config.remotePassword = "stored-password" // pragma: allowlist secret
        let endpoint = try resolveWizardGatewayEndpoint(opts: WizardCliOptions.parse([]), config: config)
        #expect(endpoint.url.absoluteString == config.remoteUrl)
        #expect(endpoint.token == config.remoteToken)
        #expect(endpoint.password == config.remotePassword)
    }

    @Test func `B10 config selected local URL keeps configured auth`() throws {
        var config = GatewayConfig()
        config.mode = "local"
        config.port = 19089
        config.token = "stored-token" // pragma: allowlist secret
        config.password = "stored-password" // pragma: allowlist secret
        let endpoint = try resolveWizardGatewayEndpoint(opts: WizardCliOptions.parse([]), config: config)
        #expect(endpoint.url.absoluteString == "ws://127.0.0.1:19089")
        #expect(endpoint.token == config.token)
        #expect(endpoint.password == config.password)
    }
}
