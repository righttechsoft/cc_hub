import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api_client.dart';
import '../connection.dart';
import '../models.dart';
import '../relative_time.dart';
import '../store.dart';
import '../theme.dart';

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

  Widget _pendingCard(BuildContext context, Permission perm, HubStore store, int now) {
    final tokens = context.tokens;
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
                    style: hubSans(size: 13, weight: FontWeight.w700, color: tokens.text),
                  ),
                ),
                Text('${remainingSec}s', style: hubMono(size: 11, color: tokens.dim)),
              ],
            ),
            const SizedBox(height: 2),
            Text(instanceLabel, style: hubMono(size: 10.5, color: tokens.dim)),
            const SizedBox(height: 8),
            if (perm.toolInput != null && perm.toolInput!.isNotEmpty)
              Container(
                width: double.infinity,
                constraints: const BoxConstraints(maxHeight: 160),
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: tokens.surface2,
                  borderRadius: BorderRadius.circular(kRadiusCard),
                ),
                child: SingleChildScrollView(
                  child: Text(
                    _prettyToolInput(perm.toolInput),
                    style: hubMono(size: 11, color: tokens.dim),
                  ),
                ),
              ),
            const SizedBox(height: 8),
            TextField(
              controller: _controllerFor(perm.id),
              style: hubSans(size: 12.5, color: tokens.text),
              decoration: const InputDecoration(labelText: 'Message (optional)'),
            ),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(onPressed: () => _decide(perm, 'deny'), child: const Text('Deny')),
                const SizedBox(width: 8),
                FilledButton(onPressed: () => _decide(perm, 'allow'), child: const Text('Allow')),
              ],
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final store = context.watch<HubStore>();
    final pending = [...store.pending]..sort((a, b) => a.createdAt.compareTo(b.createdAt));
    final now = DateTime.now().millisecondsSinceEpoch;

    return Scaffold(
      appBar: AppBar(title: const Text('Permissions')),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          if (pending.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 16),
              child: Text('No pending permissions', style: hubSans(size: 13, color: tokens.dim)),
            )
          else
            ...pending.map((perm) => _pendingCard(context, perm, store, now)),
          const Divider(height: 32),
          Text(
            'History',
            style: hubSans(size: 14, weight: FontWeight.w700, color: tokens.text),
          ),
          const SizedBox(height: 8),
          if (_loadingHistory)
            const Center(child: CircularProgressIndicator())
          else if (_history.isEmpty)
            Text('No decided permissions yet', style: hubSans(size: 13, color: tokens.dim))
          else
            ..._history.map(
              (perm) => ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                title: Text(
                  perm.toolName,
                  style: hubSans(size: 13, weight: FontWeight.w600, color: tokens.text),
                ),
                subtitle: Text(
                  '${perm.status}${perm.decidedBy != null ? ' by ${perm.decidedBy}' : ''}',
                  style: hubSans(size: 11.5, color: tokens.dim),
                ),
                trailing: Text(
                  formatRelativeTime(perm.decidedAt ?? perm.createdAt),
                  style: hubMono(size: 10, color: tokens.faint),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
