// swift-tools-version: 5.9
import PackageDescription

// Test the app's actual Foundation cache sources, the video shrinker's rate rule and the photo fetch cache, without
// Capacitor or a paired desktop.
let package = Package(
    name: "ChattyPopEmojiCache",
    platforms: [.macOS(.v13), .iOS(.v17)],
    products: [.library(name: "ChattyPopEmojiCache", targets: ["ChattyPopEmojiCache"])],
    targets: [
        .target(name: "ChattyPopEmojiCache", path: "App/App", exclude: [
            "AppDelegate.swift", "SceneDelegate.swift", "SharedPairing.swift", "ShellAssetSchemeHandler.swift",
            "ShellAttachmentViewer.swift", "ShellMediaSaver.swift", "ShellNetworkMonitor.swift", "ShellPhotoLibrary.swift",
            "ShellSystemPickers.swift", "ShellThumbnails.swift", "ShellViewController.swift",
            "Info.plist", "App.entitlements", "Assets.xcassets", "Base.lproj", "public", "capacitor.config.json", "config.xml"
        ], sources: ["ShellEmojiTypes.swift", "ShellEmojiStore.swift", "ShellEmojiDownloader.swift", "ShellEmojiCache.swift",
                     "ShellVideoShrinker.swift", "ShellFetchCache.swift"]),
        .testTarget(name: "ChattyPopEmojiCacheTests", dependencies: ["ChattyPopEmojiCache"], path: "EmojiCacheTests")
    ]
)
