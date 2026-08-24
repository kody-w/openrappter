// Dumps the locally rendered dna-prompt.mid as hex, so the Swift port can be
// diffed byte-for-byte against the host runtime's rendering.
//
//   swiftc -O -o Tools/parity-dump Sources/Core/Canonical.swift \
//       Sources/Core/MidiDNA.swift Tools/main.swift && ./Tools/parity-dump

import Foundation

let traits: [(String, [String: Int])] = [
    ("canopy", ["autonomy": 180, "continuity": 720, "curiosity": 430, "resonance": 500, "safety": 880]),
    ("current", ["autonomy": 480, "continuity": 540, "curiosity": 600, "resonance": 640, "safety": 560]),
    ("forge", ["autonomy": 860, "continuity": 330, "curiosity": 880, "resonance": 700, "safety": 300]),
]

for (path, birth) in traits {
    let hex = Digest.sha256Hex("rappid-field/fixture/1:\(path)")
    let rappid = "rappid:@field/\(path)-companion:\(hex)"
    let params = MidiDNA.parameters(rappid: rappid, birthTraitsMilli: birth)
    let prompt = MidiDNA.dnaPrompt(rappid: rappid, birthTraitsMilli: birth, parameters: params)
    let midi = MidiDNA.render(notes: prompt, parameters: params)
    print("\(path) \(midi.count) \(Digest.sha256Hex(midi))")
    print(Digest.hex(midi))
}
