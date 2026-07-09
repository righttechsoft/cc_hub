import 'package:shared_preferences/shared_preferences.dart';

/// Persisted connection settings for reaching the cc_hub server.
class AppSettings {
  final String lanUrl;
  final String? workerUrl;
  final String token;

  AppSettings({
    required this.lanUrl,
    this.workerUrl,
    required this.token,
  });

  static const _lanUrlKey = 'lanUrl';
  static const _workerUrlKey = 'workerUrl';
  static const _tokenKey = 'token';

  /// Loads persisted settings, or null if none have been saved yet.
  static Future<AppSettings?> load() async {
    final prefs = await SharedPreferences.getInstance();
    final lanUrl = prefs.getString(_lanUrlKey);
    final token = prefs.getString(_tokenKey);
    if (lanUrl == null || lanUrl.isEmpty || token == null || token.isEmpty) {
      return null;
    }
    return AppSettings(
      lanUrl: lanUrl,
      workerUrl: prefs.getString(_workerUrlKey),
      token: token,
    );
  }

  Future<void> save() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_lanUrlKey, lanUrl);
    if (workerUrl != null && workerUrl!.isNotEmpty) {
      await prefs.setString(_workerUrlKey, workerUrl!);
    } else {
      await prefs.remove(_workerUrlKey);
    }
    await prefs.setString(_tokenKey, token);
  }
}
