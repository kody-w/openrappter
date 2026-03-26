import Foundation

// MARK: - Response Models

struct FrameCounterResponse: Decodable, Sendable {
    let frame: Int
    let started_at: String?
    let total_frames_run: Int?
}

struct StatsResponse: Decodable, Sendable {
    let total_agents: Int?
    let total_posts: Int?
    let total_comments: Int?
    let active_agents: Int?
    let last_updated: String?
}

// MARK: - Fleet ViewModel

@Observable
@MainActor
public final class FleetViewModel {

    // Fleet state
    public var currentFrame: Int = 0
    public var totalPosts: Int = 0
    public var totalComments: Int = 0
    public var fleetOnline: Bool = false
    public var lastFrameTime: Date?

    // Redline detection
    public var isRedline: Bool = false

    // Errors (silent — just set online=false)
    public var fleetError: String?

    // Frame history for redline calculation
    private var frameHistory: [(frame: Int, time: Date)] = []

    private var refreshTask: Task<Void, Never>?

    // MARK: - URLs

    private let frameCounterURL = URL(string: "https://raw.githubusercontent.com/kody-w/rappterbook/main/state/frame_counter.json")!
    private let statsURL = URL(string: "https://raw.githubusercontent.com/kody-w/rappterbook/main/state/stats.json")!

    // MARK: - Lifecycle

    public init() {}

    /// Start the 60-second refresh loop.
    public func startRefreshing() {
        stopRefreshing()
        // Fetch immediately
        Task { await fetchFleet() }
        // Then every 60 seconds
        refreshTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { break }
                await fetchFleet()
            }
        }
    }

    /// Stop the refresh loop.
    public func stopRefreshing() {
        refreshTask?.cancel()
        refreshTask = nil
    }

    // MARK: - Fetch

    private func fetchFleet() async {
        do {
            // Fetch frame counter
            let frameData = try await fetchJSON(from: frameCounterURL)
            let frameResponse = try JSONDecoder().decode(FrameCounterResponse.self, from: frameData)

            // Fetch stats
            let statsData = try await fetchJSON(from: statsURL)
            let statsResponse = try JSONDecoder().decode(StatsResponse.self, from: statsData)

            await MainActor.run {
                let previousFrame = self.currentFrame
                self.currentFrame = frameResponse.frame
                self.totalPosts = statsResponse.total_posts ?? 0
                self.totalComments = statsResponse.total_comments ?? 0
                self.fleetOnline = true
                self.fleetError = nil
                self.lastFrameTime = Date()

                // Track frame history for redline
                self.updateFrameHistory(newFrame: frameResponse.frame, previousFrame: previousFrame)
            }
        } catch {
            await MainActor.run {
                self.fleetOnline = false
                self.fleetError = error.localizedDescription
            }
        }
    }

    // MARK: - Redline Detection

    /// Track frame changes. If more than 2 distinct frames in the last hour, flag redline.
    private func updateFrameHistory(newFrame: Int, previousFrame: Int) {
        let now = Date()
        // Only record if frame actually changed
        if newFrame != previousFrame && previousFrame != 0 {
            frameHistory.append((frame: newFrame, time: now))
        }

        // Prune entries older than 1 hour
        let oneHourAgo = now.addingTimeInterval(-3600)
        frameHistory.removeAll { $0.time < oneHourAgo }

        // Redline if more than 2 frame changes in the last hour
        isRedline = frameHistory.count > 2
    }

    // MARK: - Network Helper

    private func fetchJSON(from url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return data
    }
}
