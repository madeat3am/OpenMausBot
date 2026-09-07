import AppKit
import Darwin
import Foundation
import UserNotifications

// A narrow OS adapter. It receives opaque aliases over stdin, has no bearer,
// opens no network connections, and never receives report or client text.
final class ReceiverDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let center = UNUserNotificationCenter.current()
    private let outputLock = NSLock()

    func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        outputLock.lock()
        defer { outputLock.unlock() }
        FileHandle.standardOutput.write(data + Data([10]))
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        center.delegate = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        var input = stat()
        let pipeInput = fstat(STDIN_FILENO, &input) == 0 &&
            (input.st_mode & S_IFMT == S_IFIFO || input.st_mode & S_IFMT == S_IFSOCK)
        // Launch Services may cold-launch this helper for a retained alert.
        // It has no receiver pipe then; allow the native response callback
        // to open the app before ending this short activation-only process.
        guard pipeInput else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { NSApplication.shared.terminate(nil) }
            return
        }
        DispatchQueue.global(qos: .utility).async { [self] in
            while let line = readLine() {
                guard line.utf8.count <= 4096,
                      let data = line.data(using: .utf8),
                      let command = try? JSONDecoder().decode(Command.self, from: data),
                      command.valid else {
                    emit(["kind": "error", "code": "INVALID_COMMAND"])
                    continue
                }
                Task { await submit(command) }
            }
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
        emit(["kind": "ready"])
    }

    struct Command: Decodable {
        let identifier: String
        let itemAlias: String
        let revision: Int
        var valid: Bool {
            identifier.range(of: "^poppy-[a-f0-9]{32}$", options: .regularExpression) != nil &&
            itemAlias.range(of: "^[A-Za-z0-9_-]{1,256}$", options: .regularExpression) != nil && revision > 0
        }
    }

    private func submit(_ command: Command) async {
        var settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
            settings = await center.notificationSettings()
        }
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
            emit(["kind": "failed", "identifier": command.identifier, "code": "NOTIFICATION_PERMISSION_DENIED"])
            return
        }
        // A crash between OS acceptance and the receiver's journal write
        // must reuse the existing OS notification, never submit a second one.
        let delivered = await center.deliveredNotifications()
        let pending = await center.pendingNotificationRequests()
        if !delivered.contains(where: { $0.request.identifier == command.identifier }) &&
            !pending.contains(where: { $0.identifier == command.identifier }) {
            let content = UNMutableNotificationContent()
            content.title = "Poppy needs your review."
            content.sound = .default
            content.userInfo = ["itemAlias": command.itemAlias, "revision": command.revision]
            do {
                try await center.add(UNNotificationRequest(identifier: command.identifier, content: content, trigger: nil))
            } catch {
                emit(["kind": "failed", "identifier": command.identifier, "code": "NOTIFICATION_SUBMISSION_FAILED"])
                return
            }
        }
        emit(["kind": "submitted", "identifier": command.identifier])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) { completionHandler([.banner, .list, .sound]) }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let alias = response.notification.request.content.userInfo["itemAlias"] as? String,
              let revision = response.notification.request.content.userInfo["revision"] as? Int,
              Command(identifier: response.notification.request.identifier, itemAlias: alias, revision: revision).valid
        else { return }
        // Native activation also works after the receiver or helper exits.
        // Only an opaque reference crosses the OS route. Desktop's main
        // process revalidates pairing, revision, and UI origin before opening.
        guard let url = URL(string: "openmausbot://poppy?item=\(alias)&revision=\(revision)") else { return }
        DispatchQueue.main.async { NSWorkspace.shared.open(url) }
    }
}

let application = NSApplication.shared
let delegate = ReceiverDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
