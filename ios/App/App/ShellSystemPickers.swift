import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Presents the system photo picker and Files browser for the paired page (ShellPhotoLibrary's `pick` and `browse`) and
/// hands back what the owner chose; ShellPhotoLibrary exports it. One shows at a time. Used on the main queue only.
final class ShellSystemPickers: NSObject, PHPickerViewControllerDelegate, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    /// Answers the picker on screen; nil when none is.
    private var pending: ((Chosen) -> Void)?

    enum Chosen {
        /// Picked photos and videos in the order picked, or none on cancel.
        case photos([NSItemProvider])
        /// Copies of the chosen files in the app's temporary folder, or none on cancel.
        case files([URL])
    }

    /// Whether `presenter` can show a picker now: nothing else is on screen over it.
    func canPresent(from presenter: UIViewController) -> Bool {
        presenter.presentedViewController == nil
    }

    /// The photo picker: photos and videos, at most `limit`, numbered in the order picked. It needs no library access.
    func pickPhotos(from presenter: UIViewController, limit: Int, chosen: @escaping ([NSItemProvider]) -> Void) {
        var configuration = PHPickerConfiguration()
        configuration.filter = .any(of: [.images, .videos])
        configuration.selectionLimit = limit
        configuration.selection = .ordered
        // As stored: ShellPhotoLibrary converts HEIC and HEVC itself, so the picker needn't transcode first.
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        present(picker, from: presenter) { if case .photos(let items) = $0 { chosen(items) } else { chosen([]) } }
    }

    /// The Files browser ("On My iPhone", iCloud Drive and other providers), any number of files, each copied into the app.
    func browseFiles(from presenter: UIViewController, chosen: @escaping ([URL]) -> Void) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        picker.allowsMultipleSelection = true
        picker.delegate = self
        present(picker, from: presenter) { if case .files(let urls) = $0 { chosen(urls) } else { chosen([]) } }
    }

    private func present(_ picker: UIViewController, from presenter: UIViewController, answer: @escaping (Chosen) -> Void) {
        // A picker gone without a word answers none, so its page isn't left waiting.
        finish(.files([]))
        pending = answer
        // Covers a swipe down, should a picker not report it as a cancel.
        picker.presentationController?.delegate = self
        presenter.present(picker, animated: true)
    }

    private func finish(_ chosen: Chosen) {
        guard let answer = pending else { return }
        pending = nil
        answer(chosen)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        finish(.photos(results.map(\.itemProvider)))
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish(.files(urls))
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish(.files([]))
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        finish(presentationController.presentedViewController is PHPickerViewController ? .photos([]) : .files([]))
    }
}
