import Foundation

print("OpenRappter Bar — Test Suite")
print("========================================\n")

let suites: [(String, () async throws -> Void)] = [
    ("TestHarness", { await runTestHarnessTests() }),
    ("AppConstants", { try runAppConstantsTests() }),
    ("DesktopGatewayDiscovery", { try runDesktopGatewayDiscoveryTests() }),
    ("RpcTypes", { try runRpcTypesTests() }),
    ("GatewayConnection", { try await runGatewayConnectionTests() }),
    ("RpcClientContract", { await runRpcClientContractTests() }),
    ("UsageContract", { await runUsageContractTests() }),
    ("ProcessManager", { await runProcessManagerTests() }),
    ("ApprovalBanner", { await runApprovalBannerTests() }),
    ("ApprovalIntegration", { await runApprovalIntegrationTests() }),
    ("AppViewModel", { await runAppViewModelTests() }),
    ("HeartbeatMonitor", { await runHeartbeatMonitorTests() }),
    ("SessionStore", { await runSessionStoreTests() }),
    ("OnboardingSpawn", { await runOnboardingSpawnTests() }),
    ("BonesInspector", { await runBonesInspectorTests() }),
    ("BonesWindow", { await runBonesWindowTests() }),
    ("ChatTarget", { await runChatTargetTests() }),
    ("OnboardingEnvWrite", { await runOnboardingEnvWriteTests() }),
    ("GitHubAuthReliability", { await runGitHubAuthReliabilityTests() }),
    ("GitHubAuthReview", { await runGitHubAuthReviewTests() }),
    ("OnboardingRuntime", { await runOnboardingRuntimeTests() }),
    ("VerifiedRuntimeBootstrap", { await runVerifiedRuntimeBootstrapTests() }),
    ("ChatAbortFailure", { await runChatAbortFailureTests() }),
    ("ChatReliability", { await runChatReliabilityTests() }),
    ("ChatRace", { await runChatRaceTests() }),
    ("SuiteRegistration", { try runSuiteRegistrationTests() }),
]
let selected = Set((ProcessInfo.processInfo.environment["OPENRAPPTER_TEST_SUITES"] ?? "")
    .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
let unknown = selected.subtracting(suites.map(\.0))
if !unknown.isEmpty {
    print("Unknown test suites: \(unknown.sorted().joined(separator: ", "))")
    exit(2)
}
for (name, run) in suites where selected.isEmpty || selected.contains(name) {
    try await run()
}

printResults()
exitWithCode()
