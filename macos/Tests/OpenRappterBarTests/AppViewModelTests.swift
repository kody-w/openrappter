import Foundation
import SwiftUI
@testable import OpenRappterBarLib

@MainActor
func runAppViewModelTests() async {
    suite("App ViewModel") {
        test("initial state is disconnected") {
            let vm = AppViewModel()
            try expectEqual(vm.connectionState, .disconnected)
            try expectEqual(vm.statusIcon, "xmark.circle")
            try expect(vm.activities.isEmpty, "Activities should be empty")
            try expectEqual(vm.chatInput, "")
            try expect(!vm.canSend, "Should not be able to send")
        }

        test("status icon when connected") {
            let vm = AppViewModel()
            vm.connectionState = .connected
            try expectEqual(vm.statusIcon, "checkmark.circle.fill")
        }

        test("status icon when connecting") {
            let vm = AppViewModel()
            vm.connectionState = .connecting
            try expectEqual(vm.statusIcon, "arrow.triangle.2.circlepath")
        }

        test("status icon when reconnecting") {
            let vm = AppViewModel()
            vm.connectionState = .reconnecting
            try expectEqual(vm.statusIcon, "arrow.clockwise")
        }

        test("canSend requires connection and input") {
            let vm = AppViewModel()
            vm.chatInput = "hello"
            try expect(!vm.canSend, "Should not send when disconnected")

            vm.connectionState = .connected
            try expect(vm.canSend, "Should send when connected with input")

            vm.chatInput = "   "
            try expect(!vm.canSend, "Should not send with whitespace-only input")
        }

        test("add activity creates item") {
            let vm = AppViewModel()
            vm.addActivity(type: .userMessage, text: "Hello")
            try expectEqual(vm.activities.count, 1)
            try expectEqual(vm.activities[0].text, "Hello")
            try expectEqual(vm.activities[0].type, .userMessage)
        }

        test("activity list capped at 20") {
            let vm = AppViewModel()
            for i in 0..<25 {
                vm.addActivity(type: .system, text: "Item \(i)")
            }
            try expectEqual(vm.activities.count, 20)
            try expectEqual(vm.activities[0].text, "Item 24")
        }

        test("chat delta updates streaming text via ChatViewModel") {
            let vm = AppViewModel()
            let dict: [String: Any] = [
                "runId": "run_1",
                "sessionKey": "sess_1",
                "state": "delta",
                "message": [
                    "role": "assistant",
                    "content": [["type": "text", "text": "Hello world"]],
                    "timestamp": 12345,
                ] as [String: Any],
            ]
            vm.handleEvent(event: "chat", payload: dict)
            try expectEqual(vm.chatViewModel.streamingText, "Hello world")
            if case .streaming = vm.chatViewModel.chatState {} else {
                try expect(false, "Expected streaming state")
            }
        }

        test("chat final adds message and clears streaming") {
            let vm = AppViewModel()
            vm.chatViewModel.streamingText = "partial"

            let dict: [String: Any] = [
                "runId": "run_1",
                "sessionKey": "sess_1",
                "state": "final",
                "message": [
                    "role": "assistant",
                    "content": [["type": "text", "text": "Complete response"]],
                    "timestamp": 12345,
                ] as [String: Any],
            ]
            vm.handleEvent(event: "chat", payload: dict)
            try expectEqual(vm.chatViewModel.streamingText, "")
            if case .idle = vm.chatViewModel.chatState {} else {
                try expect(false, "Expected idle state after final")
            }
            // Check activity log
            try expectEqual(vm.activities.count, 1)
            try expectEqual(vm.activities[0].text, "Complete response")
            try expectEqual(vm.activities[0].type, .assistantMessage)
            // Check ChatViewModel messages
            try expectEqual(vm.chatViewModel.messages.count, 1)
            try expectEqual(vm.chatViewModel.messages[0].content, "Complete response")
        }

        test("chat error sets error state") {
            let vm = AppViewModel()
            vm.chatViewModel.streamingText = "partial"

            let dict: [String: Any] = [
                "runId": "run_1",
                "sessionKey": "sess_1",
                "state": "error",
                "errorMessage": "Something went wrong",
            ]
            vm.handleEvent(event: "chat", payload: dict)
            try expectEqual(vm.chatViewModel.streamingText, "")
            if case .error(let msg) = vm.chatViewModel.chatState {
                try expectEqual(msg, "Something went wrong")
            } else {
                try expect(false, "Expected error state")
            }
            try expectEqual(vm.activities.count, 1)
            try expectEqual(vm.activities[0].type, .error)
        }

        test("heartbeat health initial state") {
            let vm = AppViewModel()
            try expectEqual(vm.heartbeatHealth, .healthy)
            try expectNil(vm.heartbeatLatency)
        }

        test("ChatViewModel initial state") {
            let vm = AppViewModel()
            try expect(vm.chatViewModel.messages.isEmpty, "Messages should be empty")
            try expectEqual(vm.chatViewModel.streamingText, "")
            try expectNil(vm.chatViewModel.currentSessionKey)
        }

        test("SessionsViewModel initial state") {
            let vm = AppViewModel()
            try expect(vm.sessionsViewModel.sessions.isEmpty, "Sessions should be empty")
            try expect(!vm.sessionsViewModel.isLoading, "Should not be loading")
        }
    }
}
