import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        ShellViewController.launchNotification = connectionOptions.notificationResponse

        window = UIWindow(windowScene: windowScene)
        window?.backgroundColor = ShellViewController.ground
        window?.rootViewController = ShellViewController()
        window?.makeKeyAndVisible()
        handleLinks(connectionOptions.urlContexts)

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        handleLinks(URLContexts)
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    private func handleLinks(_ contexts: Set<UIOpenURLContext>) {
        guard let window else { return }
        for context in contexts { ShellViewController.handleLink(context.url, in: window) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
