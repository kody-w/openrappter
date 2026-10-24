# Homebrew Cask for OpenRappter. Publish by copying to Casks/openrappter.rb in github.com/kody-w/homebrew-tap
# and filling the sha256 from the release's .dmg.sha256 asset.
cask "openrappter" do
  version "2.0.1"
  sha256 "REPLACE_WITH_SHA256_FROM_RELEASE"

  url "https://github.com/kody-w/openrappter/releases/download/v#{version}-app/OpenRappter-#{version}.dmg"
  name "OpenRappter"
  desc "A creature in your Mac's notch: hold a key and talk, it thinks with your Copilot sign-in"
  homepage "https://kody-w.github.io/openrappter/"

  depends_on macos: :sonoma

  app "OpenRappter.app"

  # The app installs a LaunchAgent (label from Mind.swift installService) that keeps the kernel running
  # from ~/.openrappter; boot it out and drop its plist on uninstall, not only on zap.
  uninstall quit:      "com.openrappter.app",
            launchctl: "com.openrappter.kernel"

  zap trash: [
    "~/Library/LaunchAgents/com.openrappter.kernel.plist",
    "~/.openrappter",
  ]
end
