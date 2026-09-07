import Foundation
@testable import OpenRappterBarLib

@MainActor
func runApprovalIntegrationTests() async {
    await suite("Approval integration") {
        await test("repeated approval events update one pending request") {
            let model = ApprovalViewModel()
            model.handleApprovalEvent(["id": "one", "command": "example", "description": "First reason"])
            model.handleApprovalEvent(["id": "one", "command": "example", "description": "Current reason"])
            try expectEqual(model.pendingApprovals.count, 1)
            try expectEqual(model.pendingApprovals.first?.description, "Current reason")
        }

        await test("both live chat layouts mount the approval controls") {
            let root = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            let source = try String(contentsOf: root.appendingPathComponent(
                "Sources/OpenRappterBar/Views/Chat/ChatContainerView.swift"), encoding: .utf8)
            try expect(source.contains("ApprovalBannerView("))
            try expect(source.components(separatedBy: "approvalBanner").count >= 4,
                       "compact and full layouts must use the shared approval banner")
        }

        await test("the application gives Settings the same approval queue") {
            let root = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            let source = try String(contentsOf: root.appendingPathComponent(
                "Sources/OpenRappterBarApp/AppDelegate.swift"), encoding: .utf8)
            try expect(source.contains("approvalViewModel: viewModel.approvalViewModel"),
                       "Settings must render the queue receiving live gateway events")
        }

        await test("a live event immediately reaches the shared Settings model") {
            let app = AppViewModel(processManager: ProcessManager(gatewayDetector: { false }), eventBus: EventBus())
            let settings = SettingsViewModel(approvalViewModel: app.approvalViewModel)
            app.handleEvent(event: "approval", payload: [
                "id": "shared", "command": "example", "description": "A decision is needed",
            ])
            try expect(settings.approvalViewModel === app.approvalViewModel)
            try expectEqual(settings.approvalViewModel.pendingApprovals.map(\.id), ["shared"])
            try expectEqual(settings.approvalViewModel.pendingApprovals.first?.description, "A decision is needed")
            await app.shutdown()
        }

        await test("an event during refresh does not resurrect expired approvals") {
            let mock = MockWebSocket()
            let connection = GatewayConnection(host: "127.0.0.1", port: 1, transportFactory: { _ in mock })
            mock.enqueueReceive(try makeHelloOk())
            try await connection.connect()
            let model = ApprovalViewModel()
            model.configure(rpcClient: RpcClient(connection: connection))
            model.handleApprovalEvent(["id": "expired", "command": "old-command"])
            let refresh = model.loadPending()
            let sent = try await mock.waitForSentCount(2)
            let request = try JSONSerialization.jsonObject(with: sent.last!) as! [String: Any]
            model.handleApprovalEvent(["id": "new", "command": "new-command"])
            mock.enqueueReceive(try JSONSerialization.data(withJSONObject: [
                "type": "res", "id": request["id"] as! String, "ok": true, "payload": [],
            ] as [String: Any]))
            await refresh.value
            await connection.disconnect()
            try expectEqual(model.pendingApprovals.map(\.id), ["new"])
        }
    }
}
