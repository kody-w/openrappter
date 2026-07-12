import Foundation

print("OpenRappter Bar — Test Suite")
print("========================================\n")

await runTestHarnessTests()
try runAppConstantsTests()
try runRpcTypesTests()
try await runGatewayConnectionTests()
await runRpcClientContractTests()
await runProcessManagerTests()
await runAppViewModelTests()
await runHeartbeatMonitorTests()
await runSessionStoreTests()

printResults()
exitWithCode()
