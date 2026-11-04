import AppKit
import SwiftUI
import Vision
import XCTest
@testable import OpenRappterCore

@MainActor
final class OwnerViewRegressionTests: XCTestCase {
    private func render(_ model: CreatureModel) -> (NSWindow, NSView) {
        _ = NSApplication.shared
        let host = NSHostingView(rootView: Expanded(model: model).background(Color.black))
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 440, height: 340),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        return (window, host)
    }

    private func text(_ view: NSView) throws -> [VNRecognizedTextObservation] {
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.customWords = ["Got it", "Sign me in"] + (1...6).map { "Choice \($0)" }
        try VNImageRequestHandler(cgImage: XCTUnwrap(bitmap.cgImage)).perform([request])
        return request.results ?? []
    }

    private func words(_ observations: [VNRecognizedTextObservation]) -> String {
        observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }

    private func scrollView(_ view: NSView) throws -> NSScrollView {
        func descendants(_ view: NSView) -> [NSView] {
            [view] + view.subviews.flatMap(descendants)
        }
        return try XCTUnwrap(descendants(view).compactMap { $0 as? NSScrollView }.first)
    }

    private func click(_ observation: VNRecognizedTextObservation, in host: NSView, window: NSWindow) throws {
        let box = observation.boundingBox
        let point = NSPoint(x: box.midX * host.bounds.width,
                            y: (host.isFlipped ? 1 - box.midY : box.midY) * host.bounds.height)
        let location = host.convert(point, to: nil)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                                                        timestamp: ProcessInfo.processInfo.systemUptime,
                                                        windowNumber: window.windowNumber, context: nil,
                                                        eventNumber: 1, clickCount: 1, pressure: 1))
            window.sendEvent(event)
        }
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }

    private func type(_ text: String, in host: NSView, window: NSWindow) throws -> NSTextView {
        func descendants(_ view: NSView) -> [NSView] {
            [view] + view.subviews.flatMap(descendants)
        }
        let field = try XCTUnwrap(descendants(host).compactMap { $0 as? NSTextField }.first)
        XCTAssertTrue(window.makeFirstResponder(field))
        let editor = try XCTUnwrap(field.currentEditor() as? NSTextView)
        editor.selectAll(nil)
        editor.insertText(text, replacementRange: editor.selectedRange())
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        return editor
    }

    func testEveryApprovalOptionHasARealRenderedButton() throws {
        let model = CreatureModel()
        model.posture = .needsYou
        let options = (1...6).map { NeedOption(label: "Choice \($0)", action: "choice-\($0)") }
        model.need = Need(id: "many-options", title: "Choose what happens next.", opts: options)
        var selected: NeedOption?
        model.onAnswer = { _, option in selected = option }
        let (window, host) = render(model)
        defer { window.close() }
        let observations = try text(host)
        let visible = words(observations)
        for option in options {
            XCTAssertTrue(visible.contains(option.label),
                          "The owner must be able to reach \(option.label), not just the first three choices")
        }
        let last = try XCTUnwrap(observations.first { $0.topCandidates(1).first?.string == "Choice 6" })
        try click(last, in: host, window: window)
        XCTAssertEqual(selected, options.last)
    }

    func testLongAnswerHasFullScrollableRenderedHeight() throws {
        let model = CreatureModel()
        model.line = Array(repeating: "A useful detail that must remain readable.", count: 40).joined(separator: " ")
        let (window, host) = render(model)
        defer { window.close() }
        let document = try XCTUnwrap(try scrollView(host).documentView)
        XCTAssertTrue(words(try text(host)).contains("A useful detail"))
        XCTAssertGreaterThan(document.frame.height, 240,
                             "The full answer must be laid out inside the scroll area, not cut to four lines")
    }

    func testLongCardTitleAndContextHaveFullRenderedHeight() throws {
        let model = CreatureModel()
        model.posture = .needsYou
        let title = Array(repeating: "Please review this important request.", count: 15).joined(separator: " ")
        let context = Array(repeating: "The caller explains why this choice matters.", count: 20).joined(separator: " ")
        model.need = Need(id: "long-card", title: title, opts: [NeedOption(label: "Allow")])
        let (window, host) = render(model)
        defer { window.close() }
        XCTAssertTrue(words(try text(host)).contains("Please review"))
        XCTAssertGreaterThan(try XCTUnwrap(try scrollView(host).documentView).frame.height, 240)
        let contextModel = CreatureModel()
        contextModel.posture = .needsYou
        contextModel.need = Need(id: "context-card", title: "A request.", ctx: context, opts: [NeedOption(label: "Allow")])
        let (contextWindow, contextHost) = render(contextModel)
        defer { contextWindow.close() }
        XCTAssertTrue(words(try text(contextHost)).contains("The caller explains"))
        XCTAssertGreaterThan(try XCTUnwrap(try scrollView(contextHost).documentView).frame.height, 240)
    }

    func testActualSignInCardIsRenderedBeforeAnOptionalPermission() throws {
        var state = CreatureStateMachine()
        let effects = state.send(.findMind)
        guard case .findMind(let id) = effects.last else { return XCTFail("Expected lookup") }
        state.send(.needsChanged([CreatureStateMachine.permissionCard(.texts)]))
        state.send(.found(id, .success(MindHealth(status: "unauthenticated", version: "", model: "", agentCount: 0))))
        XCTAssertTrue(state.presentation.expanded)
        let model = CreatureModel()
        model.apply(state.presentation)
        let (window, host) = render(model)
        defer { window.close() }
        let visible = words(try text(host))
        XCTAssertTrue(visible.contains("Sign me in"), visible)
        XCTAssertFalse(visible.contains("Open the setting"), visible)
        XCTAssertFalse(visible.contains("To read your texts"), visible)
    }

    func testActualGotItButtonClosesTheReadableMessage() throws {
        var state = CreatureStateMachine()
        state.send(.showInput)
        let model = CreatureModel()
        model.apply(state.presentation)
        model.onDismissLine = {
            state.send(.dismissLine)
            model.apply(state.presentation)
        }
        let (window, host) = render(model)
        defer { window.close() }
        XCTAssertTrue(state.presentation.expanded)
        let button = try XCTUnwrap(try text(host).first { $0.topCandidates(1).first?.string == "Got it" })
        try click(button, in: host, window: window)
        XCTAssertFalse(state.presentation.expanded)
        XCTAssertFalse(model.canDismissLine)
    }

    func testTypingGoToSleepInTheActualFieldUsesTheQuitRoute() throws {
        var state = CreatureStateMachine()
        state.send(.showInput)
        let model = CreatureModel()
        model.apply(state.presentation)
        var effects: [CreatureEffect] = []
        model.onSubmit = {
            effects = state.send(.submit(.ask, $0))
            model.apply(state.presentation)
        }
        let (window, host) = render(model)
        defer { window.close() }
        let editor = try type("go to sleep", in: host, window: window)
        editor.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        XCTAssertTrue(effects.contains(.quit))
        XCTAssertTrue(state.presentation.expanded)
        XCTAssertEqual(model.line, "Going to sleep.")
        XCTAssertTrue(words(try text(host)).contains("Going to sleep."))
    }

    func testBusyTypingKeepsTheDraftInsteadOfSilentlyDroppingIt() throws {
        let model = CreatureModel()
        model.posture = .thinking
        model.line = "Still thinking about your last question."
        model.acceptsInput = false
        var submitted: [String] = []
        model.onSubmit = { submitted.append($0) }
        let (window, host) = render(model)
        defer { window.close() }
        let editor = try type("My next question", in: host, window: window)
        editor.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        XCTAssertTrue(submitted.isEmpty)
        XCTAssertEqual(editor.string, "My next question")
        model.acceptsInput = true
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        editor.doCommand(by: #selector(NSResponder.insertNewline(_:)))
        XCTAssertEqual(submitted, ["My next question"])
    }

    func testActualTypingPausesCompactingAndKeepsTheDraftAcrossViewReplacement() throws {
        var state = CreatureStateMachine()
        let shown = state.send(.showInput)
        guard let timeout = shown.compactMap({ effect -> CreatureWake? in
            if case .wait(8, let wake) = effect { return wake }; return nil
        }).first else { return XCTFail("Expected notice timer") }
        let model = CreatureModel()
        model.apply(state.presentation)
        model.onDraftChanged = {
            state.send(.draftChanged($0))
            model.apply(state.presentation)
        }
        let (window, host) = render(model)
        let editor = try type("My unfinished question", in: host, window: window)
        state.send(.wake(timeout))
        XCTAssertTrue(state.presentation.expanded, "A notice timer must not interrupt typing")
        XCTAssertEqual(editor.string, "My unfinished question")
        XCTAssertEqual(model.draft, "My unfinished question")
        window.close()
        let (replacement, replacementHost) = render(model)
        defer { replacement.close() }
        XCTAssertTrue(words(try text(replacementHost)).contains("My unfinished question"))
        XCTAssertEqual(model.draft, "My unfinished question")
    }
}
