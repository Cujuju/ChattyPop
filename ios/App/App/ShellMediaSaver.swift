import Foundation
import Photos
import UniformTypeIdentifiers

/// Saves camera captures the page sends in base64 pieces to the Photos library, asking only for add access.
final class ShellMediaSaver {
    // Mirrors ShellMediaPiece in src/shared/shell.ts.
    private static let idKey = "id"
    private static let indexKey = "index"
    private static let lastKey = "last"
    private static let typeKey = "type"
    private static let dataKey = "data"
    private static let folderName = "CameraCaptures"

    private enum SaveError: LocalizedError {
        case malformed, unsupportedType, outOfOrder, fileNotCreated, notAllowed, notSaved

        var errorDescription: String? {
            switch self {
            case .malformed: return "The capture piece is malformed."
            case .unsupportedType: return "The capture is neither a photo nor a video."
            case .outOfOrder: return "The capture piece is out of order."
            case .fileNotCreated: return "Could not create the capture's file."
            case .notAllowed: return "ChattyPop may not add to Photos."
            case .notSaved: return "Photos did not save the capture."
            }
        }
    }

    /// The capture being received: its file, written piece by piece.
    private struct Transfer {
        let id: String
        let url: URL
        let handle: FileHandle
        let resource: PHAssetResourceType
        var nextIndex: Int
    }

    /// Serial: file work stays off the main thread and in message order.
    private let queue = DispatchQueue(label: "com.cujuju.chattypop.media-saver")
    private let folder = FileManager.default.temporaryDirectory.appendingPathComponent(ShellMediaSaver.folderName, isDirectory: true)
    /// One capture at a time; the page sends them in turn. Touched only on `queue`.
    private var transfer: Transfer?

    init() {
        // Leftovers of captures cut short by a quit.
        queue.async { [folder] in try? FileManager.default.removeItem(at: folder) }
    }

    /// Takes one piece. `done`, on the main queue, gets nil once it's written (the last piece: once saved), else the reason it failed.
    func receive(_ body: Any, done: @escaping (String?) -> Void) {
        let finish = { (error: Error?) in DispatchQueue.main.async { done(error?.localizedDescription) } }
        guard let piece = body as? [String: Any],
              let id = piece[Self.idKey] as? String, !id.isEmpty,
              let index = (piece[Self.indexKey] as? NSNumber)?.intValue,
              let last = (piece[Self.lastKey] as? NSNumber)?.boolValue,
              let type = piece[Self.typeKey] as? String,
              let base64 = piece[Self.dataKey] as? String else { return finish(SaveError.malformed) }
        queue.async { [self] in
            do {
                try write(id: id, index: index, type: type, base64: base64)
                guard last else { return finish(nil) }
                let file = try end()
                save(file, finish)
            } catch {
                discard()
                finish(error)
            }
        }
    }

    private func write(id: String, index: Int, type: String, base64: String) throws {
        guard let data = Data(base64Encoded: base64) else { throw SaveError.malformed }
        if index == 0 {
            // A new capture replaces one cut short.
            discard()
            transfer = try begin(id: id, type: type)
        }
        guard var current = transfer, current.id == id, current.nextIndex == index else { throw SaveError.outOfOrder }
        try current.handle.write(contentsOf: data)
        current.nextIndex += 1
        transfer = current
    }

    private func begin(id: String, type: String) throws -> Transfer {
        guard let kind = UTType(mimeType: type), let ext = kind.preferredFilenameExtension else { throw SaveError.unsupportedType }
        let resource: PHAssetResourceType
        if kind.conforms(to: .image) {
            resource = .photo
        } else if kind.conforms(to: .movie) {
            resource = .video
        } else {
            throw SaveError.unsupportedType
        }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw SaveError.fileNotCreated }
        return Transfer(id: id, url: url, handle: try FileHandle(forWritingTo: url), resource: resource, nextIndex: 0)
    }

    private func end() throws -> Transfer {
        guard let done = transfer else { throw SaveError.outOfOrder }
        transfer = nil
        try done.handle.close()
        return done
    }

    private func discard() {
        guard let unfinished = transfer else { return }
        transfer = nil
        try? unfinished.handle.close()
        try? FileManager.default.removeItem(at: unfinished.url)
    }

    /// Adds the finished file as a new asset. iOS asks for add access on the first save.
    private func save(_ file: Transfer, _ finish: @escaping (Error?) -> Void) {
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                try? FileManager.default.removeItem(at: file.url)
                return finish(SaveError.notAllowed)
            }
            PHPhotoLibrary.shared().performChanges({
                let options = PHAssetResourceCreationOptions()
                options.shouldMoveFile = true
                PHAssetCreationRequest.forAsset().addResource(with: file.resource, fileURL: file.url, options: options)
            }, completionHandler: { saved, error in
                // Moved into the library on success; removed here otherwise.
                try? FileManager.default.removeItem(at: file.url)
                finish(saved ? nil : (error ?? SaveError.notSaved))
            })
        }
    }
}
