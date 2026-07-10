import 'package:flutter/material.dart';

import '../theme.dart';

/// The design's 36×20 auto-continue toggle: accent track when on, border
/// color when off, 16px white knob, 0.15s slide — replaces the Material
/// [Switch] on Session Detail.
class MiniToggle extends StatelessWidget {
  final bool value;
  final ValueChanged<bool>? onChanged;

  const MiniToggle({super.key, required this.value, this.onChanged});

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return GestureDetector(
      onTap: onChanged == null ? null : () => onChanged!(!value),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        width: 36,
        height: 20,
        padding: const EdgeInsets.all(2),
        decoration: BoxDecoration(
          color: value ? tokens.accent : tokens.border,
          borderRadius: BorderRadius.circular(999),
        ),
        child: AnimatedAlign(
          duration: const Duration(milliseconds: 150),
          curve: Curves.easeOut,
          alignment: value ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            width: 16,
            height: 16,
            decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle),
          ),
        ),
      ),
    );
  }
}
