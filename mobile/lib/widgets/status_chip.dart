import 'package:flutter/material.dart';

/// Small colored pill for a session's status, shared by the sessions list
/// and session detail screens so the color mapping stays in one place.
class StatusChip extends StatelessWidget {
  final String status;

  const StatusChip({super.key, required this.status});

  Color _color() {
    switch (status) {
      case 'active':
        return Colors.green;
      case 'idle':
        return Colors.grey;
      case 'interrupted':
        return Colors.orange;
      case 'continuing':
        return Colors.blue;
      case 'ended':
        return Colors.grey.shade800;
      default:
        return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext context) {
    final color = _color();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color),
      ),
      child: Text(
        status,
        style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600),
      ),
    );
  }
}
