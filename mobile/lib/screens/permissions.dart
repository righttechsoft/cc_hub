import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api_client.dart';
import '../connection.dart';
import '../models.dart';
import '../relative_time.dart';
import '../store.dart';

/// Pending permissions (with a 30s advisory countdown) plus recent decided
/// history. The countdown is advisory only — the hook's actual timeout is
/// enforced server-side; a `permission_decided` frame removes the card
/// automatically regardless of what this clock shows.
class PermissionsScreen extends StatefulWidget {
  const PermissionsScreen({super.key});

  @override
  State<PermissionsScreen> createState() => _PermissionsScreenState();
}

class _PermissionsScreenState extends State<PermissionsScreen> {
  static const _windowMs = 30000;

  Timer? _ticker;
  List<Permission> _history = [];
  bool _loadingHistory = true;
  final Map<int, TextEditingController> _messageControllers = {};

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
    _loadHistory();
  }

  Future<void> _loadHistory() async {
    try {
      final list = await context.read<ApiClient>().listPermissions();
      if (!mounted) return;
      setState(() {
        _history = list.where((p) => p.status != 'pending').toList()
          ..sort((a, b) => (b.decidedAt ?? b.createdAt).compareTo(a.decidedAt ?? a.createdAt));
        _loadingHistory = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loadingHistory = false);
    }
  }

  TextEditingController _controllerFor(int id) =>
      _messageControllers.putIfAbsent(id, () => TextEditingController());

  Future<void> _decide(Permission perm, String behavior) async {
    final message = _messageControllers[perm.id]?.text.trim();
    final store = context.read<HubStore>();
    try {
      await context.read<ApiClient>().decidePermission(
            perm.id,
            behavior,
            message: (message == null || message.isEmpty) ? null : message,
          );
      _messageControllers.remove(perm.id)?.dispose();
    } on ApiException catch (e) {
      if (e.statusCode == 409) {
        store.removePending(perm.id);
        if (mounted) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(const SnackBar(content: Text('already decided')));
        }
      } else if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  String _prettyToolInput(String? raw) {
    if (raw == null || raw.isEmpty) return '';
    try {
      final decoded = jsonDecode(raw);
      return const JsonEncoder.withIndent('  ').convert(decoded);
    } catch (_) {
      return raw;
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    for (final c in _messageControllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<HubStore>();
    final pending = [...store.pending]..sort((a, b) => a.createdAt.compareTo(b.createdAt));
    final now = DateTime.now().millisecondsSinceEpoch;

    return Scaffold(
      appBar: AppBar(title: const Text('Permissions')),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          if (pending.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Text('No pending permissions'),
            )
          else
            ...pending.map((perm) {
              final remainingMs = (perm.createdAt + _windowMs) - now;
              final remainingSec = (remainingMs / 1000).clamp(0, _windowMs / 1000).floor();
              final instanceLabel = store.sessions[perm.sessionId]?.instanceName ?? perm.sessionId;
              return Card(
                margin: const EdgeInsets.only(bottom: 12),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              perm.toolName,
                              style: const TextStyle(fontWeight: FontWeight.bold),
                            ),
                          ),
                          Text('${remainingSec}s'),
                        ],
                      ),
                      Text(instanceLabel, style: Theme.of(context).textTheme.bodySmall),
                      const SizedBox(height: 8),
                      if (perm.toolInput != null && perm.toolInput!.isNotEmpty)
                        Container(
                          width: double.infinity,
                          constraints: const BoxConstraints(maxHeight: 160),
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            color: Theme.of(context).colorScheme.surfaceContainerHighest,
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: SingleChildScrollView(
                            child: Text(
                              _prettyToolInput(perm.toolInput),
                              style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                            ),
                          ),
                        ),
                      const SizedBox(height: 8),
                      TextField(
                        controller: _controllerFor(perm.id),
                        decoration: const InputDecoration(labelText: 'Message (optional)'),
                      ),
                      const SizedBox(height: 8),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          TextButton(
                            onPressed: () => _decide(perm, 'deny'),
                            child: const Text('Deny'),
                          ),
                          const SizedBox(width: 8),
                          FilledButton(
                            onPressed: () => _decide(perm, 'allow'),
                            child: const Text('Allow'),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              );
            }),
          const Divider(height: 32),
          Text('History', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          if (_loadingHistory)
            const Center(child: CircularProgressIndicator())
          else if (_history.isEmpty)
            const Text('No decided permissions yet')
          else
            ..._history.map(
              (perm) => ListTile(
                dense: true,
                title: Text(perm.toolName),
                subtitle: Text(
                  '${perm.status}${perm.decidedBy != null ? ' by ${perm.decidedBy}' : ''}',
                ),
                trailing: Text(formatRelativeTime(perm.decidedAt ?? perm.createdAt)),
              ),
            ),
        ],
      ),
    );
  }
}
