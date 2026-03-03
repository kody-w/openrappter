import AppKit
import Combine

/// Animated dinosaur tamagotchi for the menu bar.
/// Cycles through emoji states: idle (looking around), happy (after poke), sleeping, etc.
@MainActor
public final class DinoStatusIcon {

    public init() {}

    // MARK: - Dino States

    public enum Mood: String, CaseIterable {
        case idle
        case lookLeft
        case lookRight
        case happy
        case sleeping
        case thinking
        case excited
    }

    /// Emoji frames for each mood — the dino "animates" by cycling these
    private static let frames: [Mood: [String]] = [
        .idle:      ["🦖"],
        .lookLeft:  ["🦖", "👀🦖"],
        .lookRight: ["🦖", "🦖👀"],
        .happy:     ["🦖✨", "🦖💚", "🦖✨"],
        .sleeping:  ["🦖💤", "🦖😴", "🦖💤"],
        .thinking:  ["🦖💭", "🦖🤔", "🦖💭"],
        .excited:   ["🦖🎉", "🦖⚡", "🦖🔥", "🦖⚡"],
    ]

    // MARK: - State

    private weak var button: NSStatusBarButton?
    private var timer: Timer?
    private var idleTimer: Timer?
    private var frameIndex = 0
    private var currentMood: Mood = .idle
    private var pokeCount = 0
    private var lastPokeTime: Date = .distantPast

    /// How often frames change (seconds)
    private let frameInterval: TimeInterval = 1.5

    /// How often the dino looks around on its own (seconds)
    private let idleInterval: TimeInterval = 8.0

    // MARK: - Public API

    /// Attach to a status bar button
    public func attach(to button: NSStatusBarButton) {
        self.button = button
        updateDisplay()
        startIdleBehavior()
    }

    /// Called when user clicks the dino — tamagotchi poke!
    public func poke() {
        pokeCount += 1
        lastPokeTime = Date()

        // React based on how much they poke
        if pokeCount >= 5 && pokeCount.isMultiple(of: 5) {
            setMood(.excited, duration: 3.0)
        } else {
            setMood(.happy, duration: 2.0)
        }
    }

    /// Update mood based on connection state
    public func setConnectionState(connected: Bool) {
        if connected {
            setMood(.happy, duration: 2.0)
        } else {
            setMood(.sleeping, duration: 0) // stays until reconnected
        }
    }

    /// Flash thinking when processing a request
    public func setThinking(_ thinking: Bool) {
        if thinking {
            setMood(.thinking, duration: 0)
        } else {
            setMood(.idle, duration: 0)
        }
    }

    /// Stop all timers
    public func stop() {
        timer?.invalidate()
        timer = nil
        idleTimer?.invalidate()
        idleTimer = nil
    }

    // MARK: - Mood Control

    private func setMood(_ mood: Mood, duration: TimeInterval) {
        currentMood = mood
        frameIndex = 0
        updateDisplay()

        // Start animation if multi-frame
        startAnimation()

        // Return to idle after duration (0 = stay until changed)
        if duration > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + duration) { [weak self] in
                guard let self, self.currentMood == mood else { return }
                self.currentMood = .idle
                self.frameIndex = 0
                self.updateDisplay()
            }
        }
    }

    // MARK: - Animation

    private func startAnimation() {
        timer?.invalidate()
        let frames = Self.frames[currentMood] ?? ["🦖"]
        guard frames.count > 1 else {
            timer = nil
            return
        }

        timer = Timer.scheduledTimer(withTimeInterval: frameInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.advanceFrame()
            }
        }
    }

    private func advanceFrame() {
        let frames = Self.frames[currentMood] ?? ["🦖"]
        frameIndex = (frameIndex + 1) % frames.count
        updateDisplay()
    }

    // MARK: - Idle Behavior (Looking Around)

    private func startIdleBehavior() {
        idleTimer?.invalidate()
        idleTimer = Timer.scheduledTimer(withTimeInterval: idleInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.doIdleAction()
            }
        }
    }

    private func doIdleAction() {
        // Only do idle animations when actually idle
        guard currentMood == .idle else { return }

        // Randomly look left or right
        let action = Int.random(in: 0...4)
        switch action {
        case 0:
            setMood(.lookLeft, duration: 2.0)
        case 1:
            setMood(.lookRight, duration: 2.0)
        case 2:
            // Rare: fall asleep briefly
            setMood(.sleeping, duration: 4.0)
        default:
            // Stay idle — just chill
            break
        }
    }

    // MARK: - Display

    private func updateDisplay() {
        guard let button else { return }
        let frames = Self.frames[currentMood] ?? ["🦖"]
        let safeIndex = frameIndex % frames.count
        let emoji = frames[safeIndex]

        // Use attributed string for emoji in menu bar
        button.image = nil
        button.title = emoji
        button.font = NSFont.systemFont(ofSize: 14)
    }
}
