import AVFoundation
import ImageIO
import Photos
import PhotosUI
import UniformTypeIdentifiers

/// Reads the Photos library for the paired page: access, recent items, and items exported to files the page reads in base64
/// pieces; and exports what the owner picks in the system photo picker or Files browser (ShellSystemPickers) the same way.
/// Thumbnails are ShellAssetSchemeHandler's, drawn by `thumbnails`. Mirrors SHELL_PHOTOS_HANDLER and ShellPhotosRequest in src/shared/shell.ts.
final class ShellPhotoLibrary: NSObject, PHPhotoLibraryChangeObserver {
    // Mirrors ShellPhotosRequest, PHOTO_ACCESS, ShellAsset and ShellAssetExport in src/shared/shell.ts.
    private static let opKey = "op"
    private static let offsetKey = "offset"
    private static let limitKey = "limit"
    private static let idKey = "id"
    private static let tokenKey = "token"
    private static let lengthKey = "length"
    // Mirrors ShellVideoShrink.
    private static let shrinkKey = "shrink"
    private static let shortSideKey = "shortSide"
    private static let videoBitrateKey = "videoBitrate"
    private static let audioBitrateKey = "audioBitrate"
    private static let maxFrameRateKey = "maxFrameRate"
    /// Mirrors SHELL_ASSET_READ_BYTES.
    private static let readMax = 4 * 1024 * 1024
    /// Mirrors SHELL_PHOTOS_PAGE_MAX.
    private static let pageMax = 200
    private static let folderName = "AssetExports"
    /// JPEG quality for HEIC photos converted for sending.
    private static let jpegQuality: CGFloat = 0.9
    private static let jpegExtension = "jpg"
    private static let movieExtension = "mp4"
    /// Name for an item whose original name PhotoKit doesn't give.
    private static let fallbackName = "media"
    /// MIME type of a file whose type the system doesn't know.
    private static let unknownMime = "application/octet-stream"

    enum LibraryError: LocalizedError {
        case malformed, notAllowed, notFound, notExported, noPresenter, unknownExport, pickerOpen

        var errorDescription: String? {
            switch self {
            case .malformed: return "The photo library request is malformed."
            case .notAllowed: return "ChattyPop may not read Photos."
            case .notFound: return "The photo or video is no longer in the library."
            case .notExported: return "Could not prepare the photo or video for sending."
            case .noPresenter: return "Nothing is on screen to show the photo choice from."
            case .unknownExport: return "The prepared photo or video is gone; pick it again."
            case .pickerOpen: return "Something else is open over ChattyPop; close it and try again."
            }
        }
    }

    /// Files exported for the page, deleted once read to the end.
    private let exports: ShellAssetExports
    private let pickers = ShellSystemPickers()
    /// The grid's thumbnails, which know the items `recent` listed.
    let thumbnails = ShellThumbnails()
    /// Called on the main queue when the readable library changes.
    var changed: (() -> Void)?
    private var observing = false
    /// The library's photos and videos, newest first, fetched once until it changes: a fetch costs about 130 ms on a large library.
    private let fetchLock = NSLock()
    private var fetched: PHFetchResult<PHAsset>?

    override init() {
        exports = ShellAssetExports(folder: FileManager.default.temporaryDirectory.appendingPathComponent(Self.folderName, isDirectory: true))
        super.init()
        observeIfAllowed()
    }

    deinit {
        if observing { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
    }

    /// Answers one ShellPhotosRequest. `reply`, on the main queue, gets the result or the reason it failed.
    func receive(_ body: Any, presenter: UIViewController?, reply: @escaping (Any?, String?) -> Void) {
        let finish = { (value: Any?, error: Error?) in
            DispatchQueue.main.async { reply(error == nil ? value : nil, error?.localizedDescription) }
        }
        guard let fields = body as? [String: Any], let op = fields[Self.opKey] as? String else { return finish(nil, LibraryError.malformed) }
        switch op {
        case "access":
            finish(Self.accessName(Self.status), nil)
        case "request":
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] status in
                DispatchQueue.main.async { self?.observeIfAllowed() }
                finish(Self.accessName(status), nil)
            }
        case "manage":
            guard let presenter else { return finish(nil, LibraryError.noPresenter) }
            guard Self.status == .limited else { return finish(Self.accessName(Self.status), nil) }
            PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: presenter) { _ in finish(Self.accessName(Self.status), nil) }
        case "recent":
            guard let offset = (fields[Self.offsetKey] as? NSNumber)?.intValue, offset >= 0,
                  let limit = (fields[Self.limitKey] as? NSNumber)?.intValue, limit > 0 else { return finish(nil, LibraryError.malformed) }
            guard Self.readable else { return finish(nil, LibraryError.notAllowed) }
            DispatchQueue.global(qos: .userInitiated).async { [self] in finish(recent(offset: offset, limit: min(limit, Self.pageMax)), nil) }
        case "export":
            guard let id = fields[Self.idKey] as? String, !id.isEmpty else { return finish(nil, LibraryError.malformed) }
            guard Self.readable else { return finish(nil, LibraryError.notAllowed) }
            export(id, shrink: Self.shrinkTarget(fields[Self.shrinkKey])) { result in
                switch result {
                case .success(let file): finish(file, nil)
                case .failure(let error): finish(nil, error)
                }
            }
        case "read":
            guard let token = fields[Self.tokenKey] as? String,
                  let offset = (fields[Self.offsetKey] as? NSNumber)?.intValue, offset >= 0,
                  let length = (fields[Self.lengthKey] as? NSNumber)?.intValue, length > 0 else { return finish(nil, LibraryError.malformed) }
            DispatchQueue.global(qos: .userInitiated).async { [exports] in
                switch exports.read(token, offset: offset, length: min(length, Self.readMax)) {
                case .success(let data): finish(data.base64EncodedString(), nil)
                case .failure(let error): finish(nil, error)
                }
            }
        case "release":
            guard let token = fields[Self.tokenKey] as? String else { return finish(nil, LibraryError.malformed) }
            exports.release(token)
            finish(nil, nil)
        case "pick":
            guard let limit = (fields[Self.limitKey] as? NSNumber)?.intValue, limit > 0 else { return finish(nil, LibraryError.malformed) }
            guard let presenter else { return finish(nil, LibraryError.noPresenter) }
            guard pickers.canPresent(from: presenter) else { return finish(nil, LibraryError.pickerOpen) }
            let shrink = Self.shrinkTarget(fields[Self.shrinkKey])
            pickers.pickPhotos(from: presenter, limit: limit) { [self] items in
                exportPicked(items[...], shrink: shrink, made: []) { result in
                    switch result {
                    case .success(let files): finish(files, nil)
                    case .failure(let error): finish(nil, error)
                    }
                }
            }
        case "browse":
            guard let presenter else { return finish(nil, LibraryError.noPresenter) }
            guard pickers.canPresent(from: presenter) else { return finish(nil, LibraryError.pickerOpen) }
            pickers.browseFiles(from: presenter) { [self] urls in
                // Taken before returning: the system may clear its copies once this does.
                var files: [[String: Any]] = []
                for url in urls {
                    let kind = (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType
                    switch exports.add(taking: url, name: url.lastPathComponent, type: kind?.preferredMIMEType ?? Self.unknownMime) {
                    case .success(let file): files.append(file)
                    case .failure(let error):
                        files.forEach { exports.release($0[Self.tokenKey] as? String ?? "") }
                        urls.forEach { try? FileManager.default.removeItem(at: $0) }
                        return finish(nil, error)
                    }
                }
                finish(files, nil)
            }
        default:
            finish(nil, LibraryError.malformed)
        }
    }

    private static var status: PHAuthorizationStatus { PHPhotoLibrary.authorizationStatus(for: .readWrite) }
    private static var readable: Bool { status == .authorized || status == .limited }

    private static func accessName(_ status: PHAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "full"
        case .limited: return "limited"
        case .notDetermined: return "undetermined"
        default: return "denied"
        }
    }

    /// Registers for library changes once reading is allowed: registering before would ask the owner.
    private func observeIfAllowed() {
        guard !observing, Self.readable else { return }
        observing = true
        PHPhotoLibrary.shared().register(self)
    }

    func photoLibraryDidChange(_ changeInstance: PHChange) {
        fetchLock.withLock { fetched = nil }
        thumbnails.reset()
        DispatchQueue.main.async { [weak self] in self?.changed?() }
    }

    private func recent(offset: Int, limit: Int) -> [String: Any] {
        let signpost = ShellThumbnails.signposter.beginInterval("recent", id: ShellThumbnails.signposter.makeSignpostID(), "offset \(offset)")
        defer { ShellThumbnails.signposter.endInterval("recent", signpost) }
        let all: PHFetchResult<PHAsset>
        if let cached = fetchLock.withLock({ fetched }) {
            all = cached
        } else {
            // Fetched outside the lock: PhotoKit may call photoLibraryDidChange, which takes it, on this thread.
            let options = PHFetchOptions()
            options.predicate = NSPredicate(format: "mediaType == %d || mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            all = PHAsset.fetchAssets(with: options)
            // Uncached until observed: without the observer nothing would clear it.
            if observing { fetchLock.withLock { fetched = all } }
        }
        guard offset < all.count else { return ["assets": [], "total": all.count] }
        let range = IndexSet(integersIn: offset..<min(offset + limit, all.count))
        let listed = all.objects(at: range)
        thumbnails.listed(listed, first: offset == 0)
        let assets = listed.map { asset -> [String: Any] in
            let video = asset.mediaType == .video
            return ["id": asset.localIdentifier, "kind": video ? "video" : "photo", "duration": video ? asset.duration : 0]
        }
        return ["assets": assets, "total": all.count]
    }

    // MARK: Export

    /// An export request's `shrink`, when whole and positive.
    private static func shrinkTarget(_ value: Any?) -> ShellVideoShrinker.Target? {
        guard let fields = value as? [String: Any] else { return nil }
        let number = { (key: String) -> Int? in (fields[key] as? NSNumber).map(\.intValue).flatMap { $0 > 0 ? $0 : nil } }
        guard let shortSide = number(shortSideKey), let videoBitrate = number(videoBitrateKey),
              let audioBitrate = number(audioBitrateKey), let maxFrameRate = number(maxFrameRateKey) else { return nil }
        return ShellVideoShrinker.Target(shortSide: shortSide, videoBitrate: videoBitrate, audioBitrate: audioBitrate, maxFrameRate: maxFrameRate)
    }

    private func export(_ id: String, shrink: ShellVideoShrinker.Target?, done: @escaping (Result<[String: Any], Error>) -> Void) {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else { return done(.failure(LibraryError.notFound)) }
        let resources = PHAssetResource.assetResources(for: asset)
        let original = resources.first { $0.type == .photo || $0.type == .video }?.originalFilename ?? Self.fallbackName
        let stem = (original as NSString).deletingPathExtension
        switch asset.mediaType {
        case .image: exportPhoto(asset, stem: stem, done: done)
        case .video: exportVideo(asset, stem: stem, shrink: shrink, done: done)
        default: done(.failure(LibraryError.notFound))
        }
    }

    /// Picked items exported in turn into `made`; when one fails, those already made are released.
    private func exportPicked(_ items: ArraySlice<NSItemProvider>, shrink: ShellVideoShrinker.Target?, made: [[String: Any]],
                              done: @escaping (Result<[[String: Any]], Error>) -> Void) {
        guard let item = items.first else { return done(.success(made)) }
        exportProvided(item, shrink: shrink) { [self] result in
            switch result {
            case .success(let file): exportPicked(items.dropFirst(), shrink: shrink, made: made + [file], done: done)
            case .failure(let error):
                made.forEach { exports.release($0[Self.tokenKey] as? String ?? "") }
                done(.failure(error))
            }
        }
    }

    /// One picked item as the picker hands it over, written as `export` writes a library item. A photo (a Live Photo's still
    /// included) is checked first: a video registers no image type.
    private func exportProvided(_ item: NSItemProvider, shrink: ShellVideoShrinker.Target?, done: @escaping (Result<[String: Any], Error>) -> Void) {
        let stem = item.suggestedName.map { ($0 as NSString).deletingPathExtension } ?? Self.fallbackName
        let types = item.registeredTypeIdentifiers.compactMap(UTType.init)
        if let kind = types.first(where: { $0.conforms(to: .image) }) {
            item.loadDataRepresentation(forTypeIdentifier: kind.identifier) { [self] data, error in
                guard let data else { return done(.failure(error ?? LibraryError.notExported)) }
                done(writePhoto(data, kind: kind, stem: stem))
            }
        } else if let kind = types.first(where: { $0.conforms(to: .movie) }) {
            item.loadFileRepresentation(forTypeIdentifier: kind.identifier) { [self] url, error in
                guard let url else { return done(.failure(error ?? LibraryError.notExported)) }
                // The picker deletes its file when this returns, so the video is read from a copy, deleted once written.
                let copy = exports.newFile(extension: url.pathExtension)
                do {
                    try FileManager.default.copyItem(at: url, to: copy)
                } catch {
                    return done(.failure(error))
                }
                writeVideo(AVURLAsset(url: copy), stem: stem, shrink: shrink) { result in
                    try? FileManager.default.removeItem(at: copy)
                    done(result)
                }
            }
        } else {
            done(.failure(LibraryError.notExported))
        }
    }

    /// The photo as edited (writePhoto).
    private func exportPhoto(_ asset: PHAsset, stem: String, done: @escaping (Result<[String: Any], Error>) -> Void) {
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.version = .current
        options.deliveryMode = .highQualityFormat
        PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { [self] data, uti, _, _ in
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                guard let data, let kind = uti.flatMap(UTType.init) else { return done(.failure(LibraryError.notExported)) }
                done(writePhoto(data, kind: kind, stem: stem))
            }
        }
    }

    /// JPEG, PNG and GIF go as they are; anything else (HEIC) is re-saved as JPEG, its metadata and orientation kept.
    private func writePhoto(_ data: Data, kind: UTType, stem: String) -> Result<[String: Any], Error> {
        let kept: [UTType] = [.jpeg, .png, .gif]
        if kept.contains(where: { kind.conforms(to: $0) }), let ext = kind.preferredFilenameExtension, let mime = kind.preferredMIMEType {
            return exports.add(data: data, name: "\(stem).\(ext)", type: mime)
        }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return .failure(LibraryError.notExported) }
        let jpeg = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(jpeg, UTType.jpeg.identifier as CFString, 1, nil) else { return .failure(LibraryError.notExported) }
        CGImageDestinationAddImageFromSource(destination, source, 0, [kCGImageDestinationLossyCompressionQuality: Self.jpegQuality] as CFDictionary)
        guard CGImageDestinationFinalize(destination), let mime = UTType.jpeg.preferredMIMEType else { return .failure(LibraryError.notExported) }
        return exports.add(data: jpeg as Data, name: "\(stem).\(Self.jpegExtension)", type: mime)
    }

    /// The video as edited (writeVideo).
    private func exportVideo(_ asset: PHAsset, stem: String, shrink: ShellVideoShrinker.Target?, done: @escaping (Result<[String: Any], Error>) -> Void) {
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        options.version = .current
        options.deliveryMode = .highQualityFormat
        PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { [self] video, _, _ in
            guard let video else { return done(.failure(LibraryError.notExported)) }
            writeVideo(video, stem: stem, shrink: shrink, done: done)
        }
    }

    /// An unedited H.264 original that needs no shrinking is copied as it is. With `shrink`, anything else is re-encoded to it
    /// (ShellVideoShrinker); without, exported as H.264 MP4 at full size.
    private func writeVideo(_ video: AVAsset, stem: String, shrink: ShellVideoShrinker.Target?, done: @escaping (Result<[String: Any], Error>) -> Void) {
        nonisolated(unsafe) let source = video
        let exports = exports
        Task {
            guard let mime = UTType.mpeg4Movie.preferredMIMEType else { return done(.failure(LibraryError.notExported)) }
            let name = "\(stem).\(Self.movieExtension)"
            let fits = await { () async -> Bool in
                guard let shrink, let side = try? await ShellVideoShrinker.shortSide(of: source) else { return true }
                return side <= shrink.shortSide
            }()
            if fits, let file = source as? AVURLAsset, await Self.isH264(file),
               let kind = UTType(filenameExtension: file.url.pathExtension), kind.conforms(to: .movie),
               let originalMime = kind.preferredMIMEType {
                return done(exports.add(copying: file.url, name: "\(stem).\(file.url.pathExtension)", type: originalMime))
            }
            let url = exports.newFile(extension: Self.movieExtension)
            if let shrink {
                do {
                    try await ShellVideoShrinker.shrink(source, to: url, target: shrink)
                    return done(exports.add(moved: url, name: name, type: mime))
                } catch {
                    try? FileManager.default.removeItem(at: url)
                    return done(.failure(error))
                }
            }
            guard let session = AVAssetExportSession(asset: source, presetName: AVAssetExportPresetHighestQuality) else {
                return done(.failure(LibraryError.notExported))
            }
            session.outputURL = url
            session.outputFileType = .mp4
            session.shouldOptimizeForNetworkUse = true
            // Read only after it finishes, on its own callback.
            nonisolated(unsafe) let finished = session
            session.exportAsynchronously {
                guard finished.status == .completed else {
                    try? FileManager.default.removeItem(at: url)
                    return done(.failure(finished.error ?? LibraryError.notExported))
                }
                done(exports.add(moved: url, name: name, type: mime))
            }
        }
    }

    private static func isH264(_ asset: AVAsset) async -> Bool {
        guard let tracks = try? await asset.loadTracks(withMediaType: .video), !tracks.isEmpty else { return false }
        for track in tracks {
            guard let formats = try? await track.load(.formatDescriptions), !formats.isEmpty,
                  formats.allSatisfy({ CMFormatDescriptionGetMediaSubType($0) == kCMVideoCodecType_H264 }) else { return false }
        }
        return true
    }
}

/// Exported files waiting for the page, deleted once read to the end or released. A relaunch deletes them all.
/// Sendable through its lock.
final class ShellAssetExports: @unchecked Sendable {
    struct File {
        let url: URL
        let size: Int
    }

    private let folder: URL
    private let lock = NSLock()
    private var files: [String: File] = [:]

    init(folder: URL) {
        self.folder = folder
        // Leftovers of exports a quit left unread.
        try? FileManager.default.removeItem(at: folder)
    }

    func newFile(extension ext: String) -> URL {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
    }

    func add(data: Data, name: String, type: String) -> Result<[String: Any], Error> {
        let url = newFile(extension: (name as NSString).pathExtension)
        do {
            try data.write(to: url)
        } catch {
            return .failure(error)
        }
        return add(moved: url, name: name, type: type)
    }

    func add(copying source: URL, name: String, type: String) -> Result<[String: Any], Error> {
        let url = newFile(extension: source.pathExtension)
        do {
            try FileManager.default.copyItem(at: source, to: url)
        } catch {
            return .failure(error)
        }
        return add(moved: url, name: name, type: type)
    }

    /// Moves `source` (a copy the system made for the app) into the exports folder.
    func add(taking source: URL, name: String, type: String) -> Result<[String: Any], Error> {
        let url = newFile(extension: source.pathExtension)
        do {
            try FileManager.default.moveItem(at: source, to: url)
        } catch {
            return .failure(error)
        }
        return add(moved: url, name: name, type: type)
    }

    /// Takes a file already in the exports folder and names it for the page (ShellAssetExport).
    func add(moved url: URL, name: String, type: String) -> Result<[String: Any], Error> {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue else {
            try? FileManager.default.removeItem(at: url)
            return .failure(ShellPhotoLibrary.LibraryError.notExported)
        }
        let token = UUID().uuidString
        lock.withLock { files[token] = File(url: url, size: size) }
        return .success(["token": token, "name": name, "type": type, "size": size])
    }

    /// Up to `length` bytes of export `token` from `offset`; the read that reaches its end deletes it.
    func read(_ token: String, offset: Int, length: Int) -> Result<Data, Error> {
        guard let file = lock.withLock({ files[token] }) else { return .failure(ShellPhotoLibrary.LibraryError.unknownExport) }
        do {
            let handle = try FileHandle(forReadingFrom: file.url)
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(offset))
            let data = try handle.read(upToCount: length) ?? Data()
            if offset + data.count >= file.size { release(token) }
            return .success(data)
        } catch {
            release(token)
            return .failure(error)
        }
    }

    func release(_ token: String) {
        guard let file = lock.withLock({ files.removeValue(forKey: token) }) else { return }
        try? FileManager.default.removeItem(at: file.url)
    }
}
