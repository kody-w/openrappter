import Foundation

print("OpenRappter Bar — Test Suite")
print("========================================\n")

try runRpcTypesTests()
try await runGatewayConnectionTests()
await runProcessManagerTests()
await runAppViewModelTests()

printResults()
exitWithCode()
