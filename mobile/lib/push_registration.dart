import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'api_client.dart';

/// Fetches the APNs device token from the iOS side (prompting for
/// notification permission on first run) and registers it with the hub.
/// Best-effort: failures are logged and retried on the next app resume.
Future<void> registerPushToken(ApiClient api) async {
  if (kIsWeb || !Platform.isIOS) return;
  try {
    final token = await const MethodChannel('cc_hub/push')
        .invokeMethod<String>('getToken')
        .timeout(const Duration(seconds: 30));
    if (token == null || token.isEmpty) return;
    await api.registerPush(token);
  } catch (e) {
    debugPrint('push registration failed: $e');
  }
}
