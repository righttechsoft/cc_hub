import 'package:flutter/material.dart';

import '../theme.dart';

/// Square accent-filled tappable surface at a given size/radius — the FAB
/// (52×52, radius 6, glow shadow) and the composer send buttons (38×38,
/// radius 6) are both this shape, just sized differently.
class AccentSquareButton extends StatelessWidget {
  final double size;
  final double radius;
  final Widget child;
  final VoidCallback? onTap;
  final List<BoxShadow>? shadow;

  const AccentSquareButton({
    super.key,
    required this.size,
    required this.radius,
    required this.child,
    this.onTap,
    this.shadow,
  });

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final disabled = onTap == null;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: disabled ? tokens.accent.withValues(alpha: 0.5) : tokens.accent,
        borderRadius: BorderRadius.circular(radius),
        boxShadow: disabled ? null : shadow,
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(radius),
          onTap: onTap,
          child: Center(child: child),
        ),
      ),
    );
  }
}
