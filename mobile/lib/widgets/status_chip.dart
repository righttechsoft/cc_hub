import 'package:flutter/material.dart';

import '../theme.dart';

/// How a status is rendered: [label] is bare colored uppercase text (used in
/// the Sessions list row, which already has its own left color bar), [pill]
/// is a bordered mono chip with a status-colored dot (used in Session
/// Detail's sub-row).
enum StatusChipStyle { label, pill }

/// Status treatment shared by the sessions list and session detail screens.
///
/// The design's Utilitarian direction ships 3 statuses (idle/ended/running);
/// cc_hub has 5. Mapping: active->running, idle->idle, ended->ended,
/// interrupted->warn, continuing->accent (its own tone, not in the design).
class StatusChip extends StatelessWidget {
  final String status;
  final StatusChipStyle style;

  const StatusChip({super.key, required this.status, this.style = StatusChipStyle.label});

  static Color colorFor(String status, HubTokens tokens) {
    switch (status) {
      case 'active':
        return tokens.stRunning;
      case 'idle':
        return tokens.stIdle;
      case 'ended':
        return tokens.stEnded;
      case 'interrupted':
        return tokens.stWarn;
      case 'continuing':
        return tokens.accent;
      default:
        return tokens.dim;
    }
  }

  static String labelFor(String status) {
    switch (status) {
      case 'active':
        return 'RUNNING';
      case 'interrupted':
        return 'INTERRUPTED';
      default:
        return status.toUpperCase();
    }
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final color = colorFor(status, tokens);
    final label = labelFor(status);

    if (style == StatusChipStyle.label) {
      return Text(
        label,
        style: hubSans(size: 9.5, weight: FontWeight.w700, color: color, letterSpacing: 0.76),
      );
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        border: Border.all(color: tokens.border),
        borderRadius: BorderRadius.circular(kRadiusChip),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 5),
          Text(label, style: hubMono(size: 10, weight: FontWeight.w600, color: color, letterSpacing: 0.5)),
        ],
      ),
    );
  }
}
