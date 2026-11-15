import XCTest
@testable import OpenRappterCore

@MainActor
final class DoorDiskTests: XCTestCase {
    let fm = FileManager.default
    func temp(_ s: String) -> URL { fm.temporaryDirectory.appendingPathComponent("\(s)-\(UUID().uuidString)") }
    func put(_ url: URL, _ bytes: Int) throws {
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(count: bytes).write(to: url)
    }
    func log(_ door: Door) -> String { (try? String(contentsOf: door.dir.appendingPathComponent("log.jsonl"), encoding: .utf8)) ?? "" }

    func testLowMeansUnderTenGigOrTenPercent() {
        XCTAssertTrue(Door.diskLow(free: 9_000_000_000, total: 2_000_000_000_000))
        XCTAssertTrue(Door.diskLow(free: 40_000_000_000, total: 500_000_000_000))
        XCTAssertFalse(Door.diskLow(free: 60_000_000_000, total: 500_000_000_000))
    }

    func testOnlyRebuildableCachesAreClearedNeverYourFiles() throws {
        let home = temp("home")
        try put(home.appendingPathComponent("Library/Caches/Homebrew/a.tar"), 300_000)
        try put(home.appendingPathComponent(".npm/_cacache/x/y"), 200_000)
        try put(home.appendingPathComponent("Documents/taxes.pdf"), 500_000)
        try put(home.appendingPathComponent("Library/Mobile Documents/note.txt"), 500_000)
        try put(home.appendingPathComponent("Library/Caches/com.apple.Safari/keep"), 100)
        // A link inside a cache folder pointing at your files is never followed.
        try fm.createSymbolicLink(at: home.appendingPathComponent("Library/Caches/pip"), withDestinationURL: home.appendingPathComponent("Documents"))
        let freed = Door.clearRebuildable(home: home)
        XCTAssertGreaterThanOrEqual(freed, 500_000)
        XCTAssertFalse(fm.fileExists(atPath: home.appendingPathComponent("Library/Caches/Homebrew/a.tar").path))
        XCTAssertTrue(fm.fileExists(atPath: home.appendingPathComponent("Library/Caches/Homebrew").path))
        XCTAssertTrue(fm.fileExists(atPath: home.appendingPathComponent("Documents/taxes.pdf").path))
        XCTAssertTrue(fm.fileExists(atPath: home.appendingPathComponent("Library/Mobile Documents/note.txt").path))
        XCTAssertTrue(fm.fileExists(atPath: home.appendingPathComponent("Library/Caches/com.apple.Safari/keep").path))
    }

    func testItTellsOnceADayAndNamesTheBiggestFolderWhenStillLow() throws {
        let home = temp("home"), door = Door(dir: temp("door"), watch: false)
        try put(home.appendingPathComponent("Library/Caches/Homebrew/a.tar"), 300_000)
        try put(home.appendingPathComponent("Library/Mobile Documents/big"), 900_000)
        let t = Date(timeIntervalSince1970: 1_800_000_000)
        door.keepDisk(now: t, home: home) { (5_000_000_000, 500_000_000_000) }
        let said = log(door)
        XCTAssertTrue(said.contains("The disk was nearly full (5.0 GB left)"), said)
        XCTAssertTrue(said.contains("biggest folder is iCloud Drive"), said)
        XCTAssertTrue(fm.fileExists(atPath: home.appendingPathComponent("Library/Mobile Documents/big").path))
        // An hour later, still low: looks, but does not say it again the same day.
        door.keepDisk(now: t.addingTimeInterval(3700), home: home) { (5_000_000_000, 500_000_000_000) }
        XCTAssertEqual(log(door).components(separatedBy: "nearly full").count, 2)
        // The next day it may say it again.
        door.keepDisk(now: t.addingTimeInterval(90_000), home: home) { (5_000_000_000, 500_000_000_000) }
        XCTAssertEqual(log(door).components(separatedBy: "nearly full").count, 3)
    }

    func testAHealthyDiskIsLeftAloneAndSaysNothing() throws {
        let home = temp("home"), door = Door(dir: temp("door"), watch: false)
        try put(home.appendingPathComponent("Library/Caches/Homebrew/a.tar"), 300_000)
        door.keepDisk(now: Date(), home: home) { (200_000_000_000, 500_000_000_000) }
        XCTAssertEqual(log(door), "")
        XCTAssertTrue(fm.fileExists(atPath: home.appendingPathComponent("Library/Caches/Homebrew/a.tar").path))
    }
}
