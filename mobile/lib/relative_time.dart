/// Hand-rolled relative time formatting ("3m ago", "in 5m") — no `intl`
/// dependency for something this small.
String formatRelativeTime(int epochMs, {DateTime? now}) {
  final reference = now ?? DateTime.now();
  final target = DateTime.fromMillisecondsSinceEpoch(epochMs);
  final diff = target.difference(reference);
  final future = diff > Duration.zero;
  final absSeconds = diff.abs().inSeconds;

  if (absSeconds < 5) {
    return future ? 'in a few seconds' : 'just now';
  }

  final int value;
  final String unit;
  if (absSeconds < 60) {
    value = absSeconds;
    unit = 's';
  } else if (absSeconds < 3600) {
    value = absSeconds ~/ 60;
    unit = 'm';
  } else if (absSeconds < 86400) {
    value = absSeconds ~/ 3600;
    unit = 'h';
  } else {
    value = absSeconds ~/ 86400;
    unit = 'd';
  }

  return future ? 'in $value$unit' : '$value$unit ago';
}
