import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Persisted dark/light choice, shared by every MaterialApp branch in
/// main.dart. Dark is the default per the design handoff.
class ThemeController extends ValueNotifier<ThemeMode> {
  ThemeController(super.value);

  static const _key = 'themeMode';

  static Future<ThemeController> load() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString(_key);
    return ThemeController(saved == 'light' ? ThemeMode.light : ThemeMode.dark);
  }

  Future<void> toggle() async {
    value = value == ThemeMode.dark ? ThemeMode.light : ThemeMode.dark;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_key, value == ThemeMode.dark ? 'dark' : 'light');
  }
}
