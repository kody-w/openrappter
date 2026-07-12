import Foundation
@testable import OpenRappterBarLib

func runAppConstantsTests() throws {
    suite("App Constants") {
        test("uses the tagged bundle version") {
            try expectEqual(AppConstants.resolvedVersion("1.10.0"), "1.10.0")
        }

        test("supports multi-digit semantic versions") {
            try expectEqual(AppConstants.resolvedVersion("12.34.56"), "12.34.56")
            try expectEqual(
                AppConstants.resolvedVersion("100000000000000000000.0.0"),
                "100000000000000000000.0.0"
            )
        }

        test("falls back when the bundle version is absent") {
            try expectEqual(AppConstants.resolvedVersion(nil), AppConstants.developmentVersion)
        }

        test("falls back for malformed or noncanonical bundle versions") {
            for value in ["", "1.10", "01.10.0", "1.10.0-bar", "1.10.0;echo"] {
                try expectEqual(
                    AppConstants.resolvedVersion(value),
                    AppConstants.developmentVersion
                )
            }
        }
    }
}
