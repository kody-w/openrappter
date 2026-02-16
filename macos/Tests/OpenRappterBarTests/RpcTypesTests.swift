import Foundation
@testable import OpenRappterBarLib

func runRpcTypesTests() throws {
    suite("AnyCodable") {
        test("string round-trip") {
            let value = AnyCodable("hello")
            let data = try JSONEncoder().encode(value)
            let decoded = try JSONDecoder().decode(AnyCodable.self, from: data)
            try expectEqual(decoded, AnyCodable("hello"))
        }

        test("int round-trip") {
            let value = AnyCodable(42)
            let data = try JSONEncoder().encode(value)
            let decoded = try JSONDecoder().decode(AnyCodable.self, from: data)
            try expectEqual(decoded, AnyCodable(42))
        }

        test("bool round-trip") {
            let value = AnyCodable(true)
            let data = try JSONEncoder().encode(value)
            let decoded = try JSONDecoder().decode(AnyCodable.self, from: data)
            try expectEqual(decoded, AnyCodable(true))
        }

        test("double round-trip") {
            let value = AnyCodable(3.14)
            let data = try JSONEncoder().encode(value)
            let decoded = try JSONDecoder().decode(AnyCodable.self, from: data)
            try expectEqual(decoded, AnyCodable(3.14))
        }

        test("null decoding") {
            let json = "null".data(using: .utf8)!
            let decoded = try JSONDecoder().decode(AnyCodable.self, from: json)
            try expect(decoded.value is NSNull, "Expected NSNull")
        }

        test("array decoding") {
            let json = "[1, \"two\", true]".data(using: .utf8)!
            let decoded = try JSONDecoder().decode(AnyCodable.self, from: json)
            let arr = decoded.value as? [Any]
            try expectNotNil(arr)
            try expectEqual(arr?.count, 3)
        }

        test("dictionary decoding") {
            let json = "{\"key\": \"value\", \"num\": 42}".data(using: .utf8)!
            let decoded = try JSONDecoder().decode(AnyCodable.self, from: json)
            let dict = decoded.value as? [String: Any]
            try expectNotNil(dict)
            try expectEqual(dict?["key"] as? String, "value")
            try expectEqual(dict?["num"] as? Int, 42)
        }
    }

    suite("Request Frame") {
        test("encodes correctly") {
            let frame = RpcRequestFrame(id: "req-1", method: "ping")
            let data = try JSONEncoder().encode(frame)
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            try expectEqual(json?["type"] as? String, "req")
            try expectEqual(json?["id"] as? String, "req-1")
            try expectEqual(json?["method"] as? String, "ping")
        }

        test("with params") {
            let frame = RpcRequestFrame(
                id: "req-2",
                method: "chat.send",
                params: ["message": AnyCodable("hello")]
            )
            let data = try JSONEncoder().encode(frame)
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            try expectEqual(json?["type"] as? String, "req")
            let params = json?["params"] as? [String: Any]
            try expectEqual(params?["message"] as? String, "hello")
        }
    }

    suite("Response Frame") {
        test("decodes success") {
            let json = """
            {"type":"res","id":"req-1","ok":true,"payload":{"pong":1234567890}}
            """.data(using: .utf8)!
            let frame = try JSONDecoder().decode(RpcResponseFrame.self, from: json)
            try expectEqual(frame.type, "res")
            try expectEqual(frame.id, "req-1")
            try expect(frame.ok)
            try expectNil(frame.error)
            let payload = frame.payload?.value as? [String: Any]
            try expectEqual(payload?["pong"] as? Int, 1234567890)
        }

        test("decodes error") {
            let json = """
            {"type":"res","id":"req-1","ok":false,"error":{"code":-32601,"message":"Method not found"}}
            """.data(using: .utf8)!
            let frame = try JSONDecoder().decode(RpcResponseFrame.self, from: json)
            try expect(!frame.ok)
            try expectEqual(frame.error?.code, -32601)
            try expectEqual(frame.error?.message, "Method not found")
        }
    }

    suite("Event Frame") {
        test("decodes correctly") {
            let json = """
            {"type":"event","event":"chat","payload":{"runId":"run_abc","sessionKey":"sess_1","state":"delta","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}],"timestamp":12345}}}
            """.data(using: .utf8)!
            let frame = try JSONDecoder().decode(RpcEventFrame.self, from: json)
            try expectEqual(frame.type, "event")
            try expectEqual(frame.event, "chat")
            let payload = frame.payload?.value as? [String: Any]
            try expectEqual(payload?["runId"] as? String, "run_abc")
            try expectEqual(payload?["state"] as? String, "delta")
        }
    }

    suite("Frame Discriminator") {
        test("parses response") {
            let json = """
            {"type":"res","id":"req-1","ok":true,"payload":null}
            """.data(using: .utf8)!
            let frame = try IncomingFrame.parse(data: json)
            if case .response(let res) = frame {
                try expectEqual(res.id, "req-1")
                try expect(res.ok)
            } else {
                try expect(false, "Expected response frame")
            }
        }

        test("parses event") {
            let json = """
            {"type":"event","event":"heartbeat","payload":{"timestamp":"2025-01-01T00:00:00Z"}}
            """.data(using: .utf8)!
            let frame = try IncomingFrame.parse(data: json)
            if case .event(let evt) = frame {
                try expectEqual(evt.event, "heartbeat")
            } else {
                try expect(false, "Expected event frame")
            }
        }

        test("parses unknown type") {
            let json = """
            {"type":"weird","data":{}}
            """.data(using: .utf8)!
            let frame = try IncomingFrame.parse(data: json)
            if case .unknown(let type) = frame {
                try expectEqual(type, "weird")
            } else {
                try expect(false, "Expected unknown frame")
            }
        }
    }

    suite("Error Detail") {
        test("encodes correctly") {
            let error = RpcErrorDetail(code: -32000, message: "Unauthorized")
            let data = try JSONEncoder().encode(error)
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            try expectEqual(json?["code"] as? Int, -32000)
            try expectEqual(json?["message"] as? String, "Unauthorized")
        }
    }
}
