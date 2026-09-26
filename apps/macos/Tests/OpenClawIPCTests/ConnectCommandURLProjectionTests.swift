import Foundation
import Testing
@testable import OpenClawMacCLI

@Suite
struct ConnectCommandURLProjectionTests {
    private func url(_ raw: String) throws -> URL {
        try #require(URL(string: raw))
    }

    private func items(_ projected: String) throws -> [URLQueryItem] {
        try #require(URLComponents(string: projected)?.queryItems)
    }

    @Test func cleanWebSocketRoutes() throws {
        for raw in ["ws://gateway.example.test:18789/socket", "wss://gateway.example.test:443/socket?tenant=alpha"] {
            let input = try self.url(raw)
            #expect(gatewayURLForDisplay(input) == input.absoluteString)
        }
    }

    @Test func stripsUserAndPassword() throws {
        let input = try self.url("wss://alice:pass123@gateway.example.test/socket?tenant=alpha")
        let projected = gatewayURLForDisplay(input)
        #expect(!projected.contains("alice"))
        #expect(!projected.contains("pass123"))
        #expect(projected.contains("gateway.example.test/socket?tenant=alpha"))
    }

    @Test func stripsCanonicalSensitiveQueryNames() throws {
        let input = try self.url("wss://gateway.example.test/socket?token=one&password=two&tenant=alpha")
        let projected = try self.items(gatewayURLForDisplay(input))
        #expect(projected.map(\.name) == ["tenant"])
        #expect(projected.map(\.value) == ["alpha"])
    }

    @Test func stripsEverySensitiveAlias() throws {
        let names = ["access_token", "api_key", "apikey", "app_secret", "auth", "auth_token",
                     "authorization", "client_secret", "code", "credential", "hook_token", "id_token",
                     "jwt", "key", "pass", "passwd", "password", "private_key", "refresh_token",
                     "secret", "session", "signature", "token", "x_amz_security_token", "x_amz_signature"]
        let query = names.enumerated().map { "\($0.element)=s\($0.offset)" }.joined(separator: "&")
        let input = try self.url("wss://gateway.example.test/socket?\(query)&tenant=alpha")
        let projected = try self.items(gatewayURLForDisplay(input))
        #expect(projected.map(\.name) == ["tenant"])
    }

    @Test func normalizedCaseHyphenWhitespace() throws {
        let input = try self.url("wss://gateway.example.test/socket?TOKEN=a&access-token=b&%20password%20=c&tenant=alpha")
        let projected = try self.items(gatewayURLForDisplay(input))
        #expect(projected.map(\.name) == ["tenant"])
    }

    @Test func percentEncodedNameAndValue() throws {
        let input = try self.url("wss://gateway.example.test/socket?%74oken=secret%2Fvalue&tenant=alpha%2Fbeta")
        let projected = try self.items(gatewayURLForDisplay(input))
        #expect(projected.map(\.name) == ["tenant"])
        #expect(projected.map(\.value) == ["alpha/beta"])
    }

    @Test func preservesSafeDuplicateQueryItems() throws {
        let input = try self.url("wss://gateway.example.test/socket?tenant=a&token=secret&tenant=b&view=one%2Ftwo")
        let projected = try self.items(gatewayURLForDisplay(input))
        #expect(projected.map(\.name) == ["tenant", "tenant", "view"])
        #expect(projected.map(\.value) == ["a", "b", "one/two"])
    }

    @Test func stripsFragmentAndEmptySensitiveQuery() throws {
        let input = try self.url("wss://gateway.example.test/socket?token=secret#private")
        let projected = gatewayURLForDisplay(input)
        #expect(projected == "wss://gateway.example.test/socket")
    }

    @Test func retainsIPv6PortAndPath() throws {
        let input = try self.url("wss://user:pw@[2001:db8::1]:443/socket/v1?tenant=alpha&api_key=secret")
        let projected = gatewayURLForDisplay(input)
        #expect(projected == "wss://[2001:db8::1]:443/socket/v1?tenant=alpha")
    }

    @Test func doesNotMutateTransportInput() throws {
        let input = try self.url("wss://user:pw@gateway.example.test/socket?token=secret&tenant=alpha#frag")
        let before = input.absoluteString
        _ = gatewayURLForDisplay(input)
        #expect(input.absoluteString == before)
    }
}
