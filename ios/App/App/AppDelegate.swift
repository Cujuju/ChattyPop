import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Accepts application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Called before the app becomes inactive.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Called when the app enters the background.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called before the app returns to the foreground.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Called when the app becomes active.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called before application termination.
    }

    // The push plugin (@capacitor/push-notifications) gets APNs registration results only through these.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
