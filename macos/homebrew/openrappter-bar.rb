# Homebrew Cask for OpenRappter Bar
# To use: brew tap kody-w/tap && brew install --cask openrappter-bar
#
# This file lives in the repo as a reference. To publish:
# 1. Create a repo: github.com/kody-w/homebrew-tap
# 2. Copy this file to Casks/openrappter-bar.rb in that repo
# 3. Update the version and sha256 after each release
#
# Step 3 is manual and was missed for three releases: the published tap served
# 1.10.4 from 18 July while 1.11.0, 1.12.0 and 1.13.0 shipped DMGs, so
# `brew install --cask openrappter-bar` handed people a build from three
# versions back. Every Bar release note tells them to install exactly that way.
#
# Deliberately not guarded by a test. The Bar's version comes from the release
# tag, not from any file in this repository, so an offline check would have
# nothing trustworthy to compare against — and a tag-derived one is unreliable
# in the shallow clones CI uses. A guard that cannot actually tell whether this
# file is current would give assurance it has not earned.
#
# The check that would work is the one release-bar.yml should do at publish
# time: it already builds the DMG and computes the sha256, so it is the only
# place that knows both values without guessing.

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
