import Foundation

print("OpenRappter Bar — Test Suite")
print("========================================\n")

await runTestHarnessTests()
try runAppConstantsTests()
try runDesktopGatewayDiscoveryTests()
try runRpcTypesTests()
try await runGatewayConnectionTests()
await runRpcClientContractTests()
await runUsageContractTests()
await runProcessManagerTests()
await runAppViewModelTests()
await runHeartbeatMonitorTests()
await runSessionStoreTests()
await runOnboardingSpawnTests()
await runBonesInspectorTests()
await runBonesWindowTests()
await runChatTargetTests()

printResults()
exitWithCode()
