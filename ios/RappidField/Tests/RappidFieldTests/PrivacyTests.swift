import XCTest
@testable import RappidField

final class PrivacyTests: XCTestCase {
    func testPolicyConstantsSayNoToEveryLocationCapability() {
        XCTAssertFalse(LocationPolicy.usesCoreLocation)
        XCTAssertFalse(LocationPolicy.requestsLocationPermission)
        XCTAssertFalse(LocationPolicy.requestsPreciseLocation)
        XCTAssertFalse(LocationPolicy.requestsBackgroundLocation)
        XCTAssertFalse(LocationPolicy.tracksAnyone)
    }

    /// The promise that matters: iOS cannot show a prompt for a purpose string
    /// the bundle does not declare.
    func testAppBundleDeclaresNoLocationOrCameraPurpose() throws {
        let bundle = Bundle(for: AppModel.self)
        let info = try XCTUnwrap(bundle.infoDictionary)

        for key in info.keys {
            XCTAssertFalse(key.hasPrefix("NSLocation"), "\(key) must not be declared")
            XCTAssertFalse(key.hasPrefix("NSCamera"), "\(key) must not be declared")
            XCTAssertFalse(key.hasPrefix("NSMotion"), "\(key) must not be declared")
            XCTAssertFalse(key.hasPrefix("NSContacts"), "\(key) must not be declared")
            XCTAssertFalse(key.hasPrefix("NSUserTracking"), "\(key) must not be declared")
            XCTAssertFalse(key.hasPrefix("NSBluetooth"), "\(key) must not be declared")
        }

        let backgroundModes = info["UIBackgroundModes"] as? [String] ?? []
        XCTAssertFalse(backgroundModes.contains("location"))
        XCTAssertTrue(backgroundModes.isEmpty, "this prototype runs in the foreground only")
    }

    func testDiscoveryPreferenceChangesNothingAboutCollection() {
        var settings = PrivacySettings.default
        XCTAssertFalse(settings.discoveryModeRequested)
        settings.discoveryModeRequested = true

        // Turning the switch on records an opinion; the policy is unmoved.
        XCTAssertFalse(LocationPolicy.requestsLocationPermission)
        XCTAssertFalse(LocationPolicy.usesCoreLocation)
        XCTAssertTrue(LocationPolicy.futureIntent.lowercased().contains("coarse"))
        XCTAssertTrue(LocationPolicy.futureIntent.lowercased().contains("when-in-use"))
        XCTAssertTrue(LocationPolicy.futureIntent.lowercased().contains("never in the background"))
    }

    func testPersistedStateIsAShortAndHonestList() {
        XCTAssertEqual(PersistedState.allCases.count, 5)
        for item in PersistedState.allCases {
            XCTAssertTrue(item.rawValue.hasPrefix("field."))
            XCTAssertFalse(item.explanation.isEmpty)
        }
        XCTAssertTrue(
            PersistedState.deviceInstallID.explanation.lowercased().contains("not a hardware"),
            "the install id must be described for what it is"
        )
    }

    func testPrivacySettingsRoundTrip() throws {
        var settings = PrivacySettings.default
        settings.hapticsEnabled = false
        settings.motifMotionEnabled = false
        settings.discoveryModeRequested = true
        let data = try JSONEncoder().encode(settings)
        XCTAssertEqual(try JSONDecoder().decode(PrivacySettings.self, from: data), settings)
    }
}
