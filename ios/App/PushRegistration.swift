import UIKit
import CompanionCore

/// Apple's token lifecycle is independent of the foreground event stream.
/// Tokens are obtained again each launch and are never cached on disk.
@MainActor
final class PushRegistrationDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        NotificationCoordinator.shared.receivedDeviceToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Provider errors may include identifiers; keep the UI and logs generic.
        NotificationCoordinator.shared.failedDeviceRegistration()
    }
}
