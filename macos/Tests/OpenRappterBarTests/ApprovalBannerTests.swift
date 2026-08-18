import Foundation
@testable import OpenRappterBarLib

/// The surface you approve from has to say why.
///
/// The safety policy works out precisely why a command needs a person —
/// `LD_PRELOAD=/tmp/x.so ls` is an environment assignment that changes what the
/// binary loads, not an ordinary `ls` — and the gateway sends that as
/// `description` on the approval event. `ApprovalDetailView` rendered it.
///
/// `ApprovalBannerView` did not, and the banner is where the Approve button
/// lives. So the decision could be made from a truncated command with no
/// explanation, while the explanation sat unused one screen away.
func runApprovalBannerTests() async {
    await suite("Approval banner") {

        await test("carries the description from the gateway event to the model") {
            let model = await ApprovalViewModel()
            await model.handleApprovalEvent([
                "id": "token_1",
                "command": "LD_PRELOAD=/tmp/evil.so ls",
                "description": "Environment assignment before the command can change what it loads",
            ])
            let approvals = await model.pendingApprovals
            try expectEqual(approvals.count, 1)
            try expectEqual(approvals[0].command, "LD_PRELOAD=/tmp/evil.so ls")
            try expectEqual(
                approvals[0].description,
                "Environment assignment before the command can change what it loads"
            )
        }

        await test("an event without a description still produces an approval") {
            // The reason is optional on the wire; a missing one must not drop
            // the approval entirely, which would leave a command waiting with
            // nothing on screen to say so.
            let model = await ApprovalViewModel()
            await model.handleApprovalEvent([
                "id": "token_2",
                "command": "curl https://example.com",
            ])
            let approvals = await model.pendingApprovals
            try expectEqual(approvals.count, 1)
            try expect(approvals[0].description == nil, "description should be nil")
        }

        await test("the banner renders the description, not just the command") {
            // A view test without a renderer: assert the source of the surface
            // that owns the Approve button reads the field. Rendering is what
            // was missing — the model already had the value.
            let path = #filePath
                .replacingOccurrences(
                    of: "Tests/OpenRappterBarTests/ApprovalBannerTests.swift",
                    with: "Sources/OpenRappterBar/Views/Approval/ApprovalBannerView.swift"
                )
            let source = try String(contentsOfFile: path, encoding: .utf8)
            try expect(
                source.contains("first.description"),
                "ApprovalBannerView must render the approval's description"
            )
            try expect(
                source.contains("onApprove"),
                "this test is only meaningful while the banner can approve"
            )
        }
    }
}
