import Foundation

// MARK: - Channels ViewModel

@Observable
@MainActor
public final class ChannelsViewModel {
    public var channels: [Channel] = []
    public var isLoading: Bool = false
    public var error: String?

    private var rpcClient: RpcClient?

    public init() {}

    public func configure(rpcClient: RpcClient) {
        self.rpcClient = rpcClient
    }

    public func clearConfiguration() {
        rpcClient = nil
    }

    var isRpcClientConfigured: Bool {
        rpcClient != nil
    }

    // MARK: - Actions

    public func loadChannels() {
        guard let rpc = rpcClient else { return }
        isLoading = true
        error = nil

        Task {
            do {
                let raw = try await rpc.listChannels()
                channels = raw
                isLoading = false
            } catch {
                self.error = error.localizedDescription
                isLoading = false
            }
        }
    }

    public func enableChannel(_ channel: Channel) {
        guard channel.actionable, let rpc = rpcClient else { return }
        Task {
            do {
                try await rpc.enableChannel(channelId: channel.id)
                loadChannels()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    public func disableChannel(_ channel: Channel) {
        guard channel.actionable, let rpc = rpcClient else { return }
        Task {
            do {
                try await rpc.disableChannel(channelId: channel.id)
                loadChannels()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    public func testChannel(_ channel: Channel) {
        guard channel.actionable, let rpc = rpcClient else { return }
        Task {
            do {
                try await rpc.testChannel(channelId: channel.id)
            } catch {
                self.error = "Test failed: \(error.localizedDescription)"
            }
        }
    }
}
