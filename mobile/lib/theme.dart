import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Design-token radii (theme-independent — same in dark and light).
const double kRadiusCard = 4; // cards, inputs
const double kRadiusChip = 3; // pills/chips
const double kRadiusFab = 6; // FAB
const double kRadiusSend = 6; // send button

/// IBM Plex Sans — body/titles.
TextStyle hubSans({
  required double size,
  FontWeight weight = FontWeight.w400,
  Color? color,
  double? letterSpacing,
  double? height,
}) => GoogleFonts.ibmPlexSans(
  fontSize: size,
  fontWeight: weight,
  color: color,
  letterSpacing: letterSpacing,
  height: height,
);

/// IBM Plex Mono — paths, timestamps, raw JSON, counters, tag chips, clock.
TextStyle hubMono({
  required double size,
  FontWeight weight = FontWeight.w400,
  Color? color,
  double? letterSpacing,
}) => GoogleFonts.ibmPlexMono(
  fontSize: size,
  fontWeight: weight,
  color: color,
  letterSpacing: letterSpacing,
);

/// Design tokens for the Utilitarian visual direction (see mobile design
/// handoff README: dark is default, light is the alternate). All colors
/// used throughout the app should come from here rather than raw [Colors]
/// literals or [ColorScheme], so both themes stay pixel-accurate to spec.
class HubTokens extends ThemeExtension<HubTokens> {
  final Color bg;
  final Color surface;
  final Color surface2;
  final Color border;
  final Color text;
  final Color dim;
  final Color faint;
  final Color accent;
  final Color accentInk;
  final Color stIdle;
  final Color stEnded;
  final Color stRunning;
  final Color stWarn;

  /// Bottom nav / composer footer background. Derived per the prototype:
  /// dark uses `surface`, light uses `bg` (no separation from the screen).
  final Color navBg;

  /// Limit/warning banner fill + border (`--st-warn` at the prototype's
  /// exact per-theme alpha — dark 14%/32%, light 16%/34%).
  final Color warnBg;
  final Color warnBorder;

  const HubTokens({
    required this.bg,
    required this.surface,
    required this.surface2,
    required this.border,
    required this.text,
    required this.dim,
    required this.faint,
    required this.accent,
    required this.accentInk,
    required this.stIdle,
    required this.stEnded,
    required this.stRunning,
    required this.stWarn,
    required this.navBg,
    required this.warnBg,
    required this.warnBorder,
  });

  static final HubTokens dark = HubTokens(
    bg: const Color(0xFF0B0D10),
    surface: const Color(0xFF14181D),
    surface2: const Color(0xFF1B2027),
    border: const Color(0xFF232A33),
    text: const Color(0xFFEEF2F6),
    dim: const Color(0xFF8A95A2),
    faint: const Color(0xFF586470),
    accent: const Color(0xFF2F8FFF),
    accentInk: const Color(0xFF04121F),
    stIdle: const Color(0xFFF0B429),
    stEnded: const Color(0xFFFF5C72),
    stRunning: const Color(0xFF23C98A),
    stWarn: const Color(0xFFF0B429),
    navBg: const Color(0xFF14181D), // surface
    warnBg: const Color(0xFFF0B429).withValues(alpha: 0.14),
    warnBorder: const Color(0xFFF0B429).withValues(alpha: 0.32),
  );

  static final HubTokens light = HubTokens(
    bg: const Color(0xFFEAEEF3),
    surface: const Color(0xFFFFFFFF),
    surface2: const Color(0xFFE4E9F0),
    border: const Color(0xFFD0D8E2),
    text: const Color(0xFF0F151B),
    dim: const Color(0xFF5B6572),
    faint: const Color(0xFF95A0AC),
    accent: const Color(0xFF1667E0),
    accentInk: const Color(0xFFFFFFFF),
    stIdle: const Color(0xFFB7791F),
    stEnded: const Color(0xFFE0384F),
    stRunning: const Color(0xFF12996B),
    stWarn: const Color(0xFFB7791F),
    navBg: const Color(0xFFEAEEF3), // bg
    warnBg: const Color(0xFFB7791F).withValues(alpha: 0.16),
    warnBorder: const Color(0xFFB7791F).withValues(alpha: 0.34),
  );

  @override
  HubTokens copyWith({
    Color? bg,
    Color? surface,
    Color? surface2,
    Color? border,
    Color? text,
    Color? dim,
    Color? faint,
    Color? accent,
    Color? accentInk,
    Color? stIdle,
    Color? stEnded,
    Color? stRunning,
    Color? stWarn,
    Color? navBg,
    Color? warnBg,
    Color? warnBorder,
  }) {
    return HubTokens(
      bg: bg ?? this.bg,
      surface: surface ?? this.surface,
      surface2: surface2 ?? this.surface2,
      border: border ?? this.border,
      text: text ?? this.text,
      dim: dim ?? this.dim,
      faint: faint ?? this.faint,
      accent: accent ?? this.accent,
      accentInk: accentInk ?? this.accentInk,
      stIdle: stIdle ?? this.stIdle,
      stEnded: stEnded ?? this.stEnded,
      stRunning: stRunning ?? this.stRunning,
      stWarn: stWarn ?? this.stWarn,
      navBg: navBg ?? this.navBg,
      warnBg: warnBg ?? this.warnBg,
      warnBorder: warnBorder ?? this.warnBorder,
    );
  }

  @override
  HubTokens lerp(ThemeExtension<HubTokens>? other, double t) {
    if (other is! HubTokens) return this;
    return HubTokens(
      bg: Color.lerp(bg, other.bg, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      surface2: Color.lerp(surface2, other.surface2, t)!,
      border: Color.lerp(border, other.border, t)!,
      text: Color.lerp(text, other.text, t)!,
      dim: Color.lerp(dim, other.dim, t)!,
      faint: Color.lerp(faint, other.faint, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      accentInk: Color.lerp(accentInk, other.accentInk, t)!,
      stIdle: Color.lerp(stIdle, other.stIdle, t)!,
      stEnded: Color.lerp(stEnded, other.stEnded, t)!,
      stRunning: Color.lerp(stRunning, other.stRunning, t)!,
      stWarn: Color.lerp(stWarn, other.stWarn, t)!,
      navBg: Color.lerp(navBg, other.navBg, t)!,
      warnBg: Color.lerp(warnBg, other.warnBg, t)!,
      warnBorder: Color.lerp(warnBorder, other.warnBorder, t)!,
    );
  }
}

/// Builds the app's dark or light [ThemeData], deriving scaffold/appbar/nav/
/// input/button/card/dialog/snackbar colors from [HubTokens] so no screen
/// needs to reach for a raw [Colors] literal.
ThemeData buildTheme({required bool dark}) {
  final tokens = dark ? HubTokens.dark : HubTokens.light;
  final brightness = dark ? Brightness.dark : Brightness.light;
  final base = ThemeData(brightness: brightness, useMaterial3: true);

  return base.copyWith(
    extensions: [tokens],
    scaffoldBackgroundColor: tokens.bg,
    canvasColor: tokens.surface,
    dividerColor: tokens.border,
    colorScheme: base.colorScheme.copyWith(
      brightness: brightness,
      surface: tokens.surface,
      onSurface: tokens.text,
      primary: tokens.accent,
      onPrimary: tokens.accentInk,
      error: tokens.stEnded,
    ),
    textTheme: GoogleFonts.ibmPlexSansTextTheme(
      base.textTheme,
    ).apply(bodyColor: tokens.text, displayColor: tokens.text),
    appBarTheme: AppBarTheme(
      backgroundColor: tokens.bg,
      foregroundColor: tokens.text,
      elevation: 0,
      scrolledUnderElevation: 0,
      surfaceTintColor: Colors.transparent,
      titleTextStyle: hubSans(
        size: 19,
        weight: FontWeight.w700,
        color: tokens.text,
        letterSpacing: -0.19,
      ),
      iconTheme: IconThemeData(color: tokens.text),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: tokens.surface,
      hintStyle: hubSans(size: 12.5, color: tokens.faint),
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(kRadiusCard),
        borderSide: BorderSide(color: tokens.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(kRadiusCard),
        borderSide: BorderSide(color: tokens.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(kRadiusCard),
        borderSide: BorderSide(color: tokens.accent),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: tokens.accent,
        foregroundColor: tokens.accentInk,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(kRadiusCard)),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: tokens.accent),
    ),
    checkboxTheme: CheckboxThemeData(
      fillColor: WidgetStateProperty.resolveWith(
        (states) => states.contains(WidgetState.selected) ? tokens.accent : Colors.transparent,
      ),
      side: BorderSide(color: tokens.border),
    ),
    cardTheme: CardThemeData(
      color: tokens.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(kRadiusCard),
        side: BorderSide(color: tokens.border),
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: tokens.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(kRadiusCard)),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: tokens.surface2,
      contentTextStyle: hubSans(size: 12, color: tokens.text),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(kRadiusCard)),
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: tokens.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(kRadiusCard),
        side: BorderSide(color: tokens.border),
      ),
    ),
    iconTheme: IconThemeData(color: tokens.text),
  );
}

/// Red, longer-lived snackbar for failures, so errors look unmistakably
/// different from info toasts.
void showErrorSnack(BuildContext context, String message) {
  final tokens = context.tokens;
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(message, style: hubSans(size: 12, color: Colors.white)),
      backgroundColor: tokens.stEnded,
      duration: const Duration(seconds: 6),
    ),
  );
}

/// Convenience accessor: `context.tokens.accent` instead of
/// `Theme.of(context).extension<HubTokens>()!.accent`.
extension HubThemeX on BuildContext {
  HubTokens get tokens => Theme.of(this).extension<HubTokens>()!;
}
