# Homebrew Cask for OpenRappter Bar
# To use: brew tap kody-w/tap && brew install --cask openrappter-bar
#
# This file lives in the repo as a reference. To publish:
# 1. Create a repo: github.com/kody-w/homebrew-tap
# 2. Copy this file to Casks/openrappter-bar.rb in that repo
# 3. Update the version and sha256 after each release

cask "openrappter-bar" do
  version "1.0.0"
  sha256 :no_check # Update with actual SHA256 after first release

  url "https://github.com/kody-w/openrappter/releases/download/v#{version}-bar/OpenRappter-Bar-#{version}.dmg"
  name "OpenRappter Bar"
  desc "macOS menu bar companion for the OpenRappter AI agent gateway"
  homepage "https://github.com/kody-w/openrappter"

  depends_on macos: ">= :sonoma"

  app "OpenRappter Bar.app"

  zap trash: [
    "~/Library/Preferences/com.openrappter.bar.plist",
    "~/.openrappter",
  ]

  caveats <<~EOS
    This app is not signed or notarized.
    On first launch, right-click the app → Open, then click "Open" in the dialog.
  EOS
end
