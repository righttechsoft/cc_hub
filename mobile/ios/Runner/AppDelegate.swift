import Flutter
import UIKit
import UserNotifications

/// Notification category for a permission-request push (pinned payload —
/// see cc_hub mobile push handoff): `aps.category = "PERMISSION_REQUEST"`,
/// root keys `type`, `requestId`, `sessionId`, `instance`.
private let kPermissionCategoryId = "PERMISSION_REQUEST"
private let kPendingPermissionDefaultsKey = "pendingPermissionRequestId"

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private var apnsToken: String?
  private var pendingTokenResult: FlutterResult?
  /// Kept so a permission push's default-tap action can call back into Dart
  /// (`openPermission`) when the engine is already warm. Nil until the
  /// implicit engine initializes; the tap is still handled fail-soft via the
  /// UserDefaults stash + `takePendingPermission` for a cold launch.
  private var pushChannel: FlutterMethodChannel?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    registerNotificationCategories()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  private func registerNotificationCategories() {
    let allow = UNNotificationAction(identifier: "ALLOW", title: "Allow", options: [])
    let deny = UNNotificationAction(identifier: "DENY", title: "Deny", options: [.destructive])
    let category = UNNotificationCategory(
      identifier: kPermissionCategoryId,
      actions: [allow, deny],
      intentIdentifiers: [],
      options: []
    )
    UNUserNotificationCenter.current().setNotificationCategories([category])
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    guard let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "cc_hub.push") else { return }
    let channel = FlutterMethodChannel(name: "cc_hub/push", binaryMessenger: registrar.messenger())
    pushChannel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      switch call.method {
      case "getToken":
        self?.requestToken(result: result)
      case "takePendingPermission":
        // Cold-launch case: Dart claims (reads + clears) whatever requestId
        // a prior notification tap stashed, once on startup/resume.
        let defaults = UserDefaults.standard
        let pending = defaults.string(forKey: kPendingPermissionDefaultsKey)
        defaults.removeObject(forKey: kPendingPermissionDefaultsKey)
        result(pending)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  private func requestToken(result: @escaping FlutterResult) {
    if let token = apnsToken {
      result(token)
      return
    }
    pendingTokenResult = result
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
      DispatchQueue.main.async {
        if granted {
          UIApplication.shared.registerForRemoteNotifications()
        } else {
          self.pendingTokenResult?(nil)
          self.pendingTokenResult = nil
        }
      }
    }
  }

  override func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    super.application(application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    apnsToken = token
    pendingTokenResult?(token)
    pendingTokenResult = nil
  }

  override func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    super.application(application, didFailToRegisterForRemoteNotificationsWithError: error)
    pendingTokenResult?(nil)
    pendingTokenResult = nil
  }

  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    if #available(iOS 14.0, *) {
      completionHandler([.banner, .sound])
    } else {
      completionHandler([.alert, .sound])
    }
  }

  /// Handles both the ALLOW/DENY quick actions (decide without opening the
  /// app) and the default tap (open the app to the permission popup) on a
  /// `PERMISSION_REQUEST` push. `completionHandler()` is called exactly once
  /// on every path — iOS grants ~30s background time for this callback.
  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    let actionId = response.actionIdentifier

    if actionId == "ALLOW" || actionId == "DENY" {
      guard let requestId = AppDelegate.requestIdString(from: userInfo) else {
        completionHandler()
        return
      }
      decidePermission(requestId: requestId, behavior: actionId == "ALLOW" ? "allow" : "deny") {
        completionHandler()
      }
      return
    }

    if actionId == UNNotificationDefaultActionIdentifier,
      (userInfo["type"] as? String) == "permission_request",
      let requestId = AppDelegate.requestIdString(from: userInfo)
    {
      // Stash for a cold launch (Dart claims it via `takePendingPermission`)
      // and also nudge a warm engine directly so the popup appears without
      // waiting for a resume lifecycle event.
      UserDefaults.standard.set(requestId, forKey: kPendingPermissionDefaultsKey)
      pushChannel?.invokeMethod("openPermission", arguments: requestId)
    }

    completionHandler()
  }

  private static func requestIdString(from userInfo: [AnyHashable: Any]) -> String? {
    if let n = userInfo["requestId"] as? NSNumber { return n.stringValue }
    if let s = userInfo["requestId"] as? String { return s }
    return nil
  }

  /// POSTs the Allow/Deny decision to the hub, trying the LAN URL first and
  /// falling back to the relay/worker URL (if configured) on any failure.
  /// Reads settings from `UserDefaults.standard` using the `flutter.`-prefixed
  /// keys shared_preferences uses on iOS (see mobile/lib/settings.dart).
  /// Fully fail-soft — no UI is available in this path, so errors are
  /// swallowed and `completion()` always fires.
  private func decidePermission(requestId: String, behavior: String, completion: @escaping () -> Void) {
    let defaults = UserDefaults.standard
    guard let token = defaults.string(forKey: "flutter.token"), !token.isEmpty else {
      completion()
      return
    }
    var bases: [String] = []
    if let lan = defaults.string(forKey: "flutter.lanUrl"), !lan.isEmpty { bases.append(lan) }
    if let relay = defaults.string(forKey: "flutter.workerUrl"), !relay.isEmpty { bases.append(relay) }
    guard !bases.isEmpty else {
      completion()
      return
    }
    postDecision(bases: bases, index: 0, requestId: requestId, behavior: behavior, token: token, completion: completion)
  }

  private func postDecision(
    bases: [String],
    index: Int,
    requestId: String,
    behavior: String,
    token: String,
    completion: @escaping () -> Void
  ) {
    guard index < bases.count else {
      completion()
      return
    }
    guard let url = AppDelegate.decisionURL(base: bases[index], requestId: requestId) else {
      postDecision(bases: bases, index: index + 1, requestId: requestId, behavior: behavior, token: token, completion: completion)
      return
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.timeoutInterval = index == 0 ? 6 : 12
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["behavior": behavior])

    let task = URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
      let ok = error == nil && (200..<300).contains((response as? HTTPURLResponse)?.statusCode ?? 0)
      if ok || index + 1 >= bases.count {
        completion()
      } else {
        self?.postDecision(
          bases: bases, index: index + 1, requestId: requestId, behavior: behavior, token: token,
          completion: completion
        )
      }
    }
    task.resume()
  }

  private static func decisionURL(base: String, requestId: String) -> URL? {
    var trimmed = base.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.hasSuffix("/") { trimmed.removeLast() }
    return URL(string: "\(trimmed)/api/v1/permissions/\(requestId)/decision")
  }
}
