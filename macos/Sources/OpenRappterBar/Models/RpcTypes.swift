import Foundation

// MARK: - AnyCodable

/// Type-erased JSON value wrapper for dynamic payloads.
public struct AnyCodable: Codable, Equatable, Sendable {
    public let value: Any

    public init(_ value: Any) {
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map(\.value)
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case is NSNull:
            try container.encodeNil()
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            throw EncodingError.invalidValue(value, .init(codingPath: encoder.codingPath, debugDescription: "Unsupported type"))
        }
    }

    public static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        switch (lhs.value, rhs.value) {
        case is (NSNull, NSNull):
            return true
        case let (l as Bool, r as Bool):
            return l == r
        case let (l as Int, r as Int):
            return l == r
        case let (l as Double, r as Double):
            return l == r
        case let (l as String, r as String):
            return l == r
        default:
            return false
        }
    }
}

// MARK: - JSON-RPC Frame Types

/// Outgoing request frame: { "type": "req", "id": "...", "method": "...", "params": {...} }
public struct RpcRequestFrame: Codable, Sendable {
    public let type: String
    public let id: String
    public let method: String
    public var params: [String: AnyCodable]?

    public init(id: String, method: String, params: [String: AnyCodable]? = nil) {
        self.type = "req"
        self.id = id
        self.method = method
        self.params = params
    }
}

/// Incoming response frame: { "type": "res", "id": "...", "ok": true/false, "payload": {...}, "error": {...} }
public struct RpcResponseFrame: Codable, Sendable {
    public let type: String
    public let id: String
    public let ok: Bool
    public let payload: AnyCodable?
    public let error: RpcErrorDetail?
}

/// Incoming event frame: { "type": "event", "event": "chat", "payload": {...} }
public struct RpcEventFrame: Codable, Sendable {
    public let type: String
    public let event: String
    public let payload: AnyCodable?
}

/// Error detail within a response frame.
public struct RpcErrorDetail: Codable, Sendable {
    public let code: Int
    public let message: String
    public let data: AnyCodable?

    public init(code: Int, message: String, data: AnyCodable? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }
}

// MARK: - Frame Discriminator

/// Determines the type of an incoming frame by peeking at the "type" field.
public enum IncomingFrame: Sendable {
    case response(RpcResponseFrame)
    case event(RpcEventFrame)
    case unknown(String)

    public static func parse(data: Data) throws -> IncomingFrame {
        // Peek at the "type" field
        let peek = try JSONDecoder().decode(FramePeek.self, from: data)
        switch peek.type {
        case "res":
            let frame = try JSONDecoder().decode(RpcResponseFrame.self, from: data)
            return .response(frame)
        case "event":
            let frame = try JSONDecoder().decode(RpcEventFrame.self, from: data)
            return .event(frame)
        default:
            return .unknown(peek.type)
        }
    }
}

private struct FramePeek: Codable {
    let type: String
}

// MARK: - Standard Error Codes

public enum RpcErrorCode {
    public static let parseError = -32700
    public static let invalidRequest = -32600
    public static let methodNotFound = -32601
    public static let invalidParams = -32602
    public static let internalError = -32603
    public static let unauthorized = -32000
    public static let rateLimited = -32001
}

// MARK: - Encoding Helpers

public extension RpcRequestFrame {
    func toData() throws -> Data {
        try JSONEncoder().encode(self)
    }
}
