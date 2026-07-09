import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api_client.dart';
import '../connection.dart';
import '../models.dart';
import '../relative_time.dart';
import '../settings.dart';
import '../store.dart';
import 'chat.dart';
import 'kb.dart';
import 'permissions.dart';
import 'sessions.dart';
import 'setup.dart';

/// Main tabbed shell: Sessions | Chat | KB, with a connection status pill,
/// a permission banner, and a limit-state banner above the tabs, plus a
/// Settings entry in the AppBar overflow menu that reopens SetupScreen
/// prefilled with the currently saved settings.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _selectedIndex = 0;

  static const _tabs = [SessionsScreen(), ChatScreen(), KbScreen()];

  Future<void> _openSettings() async {
    final current = await AppSettings.load();
    if (!mounted) return;
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => SetupScreen(initial: current)));
  }

  Future<void> _decideOldest(BuildContext context, Permission perm, String behavior) async {
    final api = context.read<ApiClient>();
    final store = context.read<HubStore>();
    try {
      await api.decidePermission(perm.id, behavior);
    } on ApiException catch (e) {
      if (e.statusCode == 409) {
        store.removePending(perm.id);
        if (context.mounted) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(const SnackBar(content: Text('already decided')));
        }
      } else if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  String _sessionLabel(HubStore store, String sessionId) {
    final name = store.sessions[sessionId]?.instanceName;
    if (name != null && name.isNotEmpty) return name;
    return sessionId.length > 8 ? sessionId.substring(0, 8) : sessionId;
  }

  Widget _connectionPill(ConnectionManager connection) {
    final String label;
    final Color color;
    switch (connection.wsStatus) {
      case WsStatus.up:
        label = connection.activeBaseIsRelay ? 'Relay' : 'LAN';
        color = connection.activeBaseIsRelay ? Colors.blue : Colors.green;
        break;
      case WsStatus.connecting:
        label = '…';
        color = Colors.grey;
        break;
      case WsStatus.down:
        label = 'Offline';
        color = Colors.red;
        break;
    }
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 8),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color),
      ),
      child: Text(
        label,
        style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<HubStore>();
    final connection = context.watch<ConnectionManager>();
    final pending = [...store.pending]..sort((a, b) => a.createdAt.compareTo(b.createdAt));
    final limit = store.limit;

    return Scaffold(
      appBar: AppBar(
        title: const Text('cc_hub'),
        actions: [
          _connectionPill(connection),
          PopupMenuButton<String>(
            onSelected: (value) {
              if (value == 'settings') _openSettings();
            },
            itemBuilder: (context) => const [
              PopupMenuItem(value: 'settings', child: Text('Settings')),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          if (pending.isNotEmpty)
            MaterialBanner(
              backgroundColor: Colors.amber.shade100,
              content: Text(
                'Permission: ${pending.first.toolName} — ${_sessionLabel(store, pending.first.sessionId)}'
                '${pending.length > 1 ? ' (+${pending.length - 1} more)' : ''}',
              ),
              actions: [
                TextButton(
                  onPressed: () => _decideOldest(context, pending.first, 'deny'),
                  child: const Text('Deny'),
                ),
                TextButton(
                  onPressed: () => _decideOldest(context, pending.first, 'allow'),
                  child: const Text('Allow'),
                ),
                TextButton(
                  onPressed: () => Navigator.of(
                    context,
                  ).push(MaterialPageRoute(builder: (_) => const PermissionsScreen())),
                  child: const Text('View'),
                ),
              ],
            ),
          if (limit != null && limit.state != 'ok')
            MaterialBanner(
              backgroundColor: Colors.orange.shade100,
              content: Text(
                'Limit: ${limit.state}'
                '${limit.resetsAt != null ? ' — resets ${formatRelativeTime(limit.resetsAt!)}' : ''}',
              ),
              actions: [TextButton(onPressed: () {}, child: const Text('OK'))],
            ),
          Expanded(child: IndexedStack(index: _selectedIndex, children: _tabs)),
        ],
      ),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _selectedIndex,
        onTap: (index) => setState(() => _selectedIndex = index),
        items: const [
          BottomNavigationBarItem(icon: Icon(Icons.list_alt), label: 'Sessions'),
          BottomNavigationBarItem(icon: Icon(Icons.chat_bubble_outline), label: 'Chat'),
          BottomNavigationBarItem(icon: Icon(Icons.menu_book_outlined), label: 'KB'),
        ],
      ),
    );
  }
}
