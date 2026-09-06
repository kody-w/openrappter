# Homebrew Cask for OpenRappter Bar
# To use: brew tap kody-w/tap && brew install --cask openrappter-bar
#
# Historical reference only; changing this file does not update the public tap.
# release-bar.yml generates a cask proposal only after the complete receipt gate
# and a checksum verification of the actual public DMG. The public tap must
# review that proposal behind its own required Release Constitution check.
# See macos/SIGNING.md. Never bump this to unbuilt/unreceipted artifact bytes.

cask "openrappter-bar" do
  version "1.13.0"
  sha256 "5fc4ad868a4b0e2d0b202a9b4a93a3e0bf48111a948c0b8cef0b318e1308bac1"

  url "https://github.com/kody-w/openrappter/releases/download/v#{version}-bar/OpenRappter-Bar-#{version}.dmg"
  name "OpenRappter Bar"
  desc "Menu bar companion for the OpenRappter AI agent gateway"
  homepage "https://github.com/kody-w/openrappter"

  depends_on macos: :sonoma

  app "OpenRappter Bar.app"

  zap trash: "~/Library/Preferences/com.openrappter.bar.plist"
end
