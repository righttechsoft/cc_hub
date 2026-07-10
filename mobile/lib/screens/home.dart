import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api_client.dart';
import '../connection.dart';
import '../models.dart';
import '../relative_time.dart';
import '../settings.dart';
import '../store.dart';
import '../theme.dart';
import '../theme_controller.dart';
import 'chat.dart';
import 'kb.dart';
import 'new_session.dart';
import 'permissions.dart';
import 'sessions.dart';
import 'setup.dart';

/// Main tabbed shell: Sessions | Chat | KB, with a connection status pill,
/// a limit-state chip, a theme toggle, and a permission banner above the
/// tabs, plus a Settings entry in the AppBar overflow menu that reopens
/// SetupScreen prefilled with the currently saved settings.
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

  Widget _connectionPill(BuildContext context, ConnectionManager connection) {
    final tokens = context.tokens;
    final String label;
    final Color color;
    switch (connection.wsStatus) {
      case WsStatus.up:
        label = connection.activeBaseIsRelay ? 'RELAY' : 'LAN';
        color = connection.activeBaseIsRelay ? tokens.accent : tokens.stRunning;
        break;
      case WsStatus.connecting:
        label = '…';
        color = tokens.dim;
        break;
      case WsStatus.down:
        label = 'OFFLINE';
        color = tokens.stEnded;
        break;
    }
    return Container(
      margin: const EdgeInsets.only(right: 4),
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
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
            decoration: BoxDecoration(
              color: color,
              shape: BoxShape.circle,
              boxShadow: [BoxShadow(color: color, blurRadius: 6)],
            ),
          ),
          const SizedBox(width: 4),
          Text(
            label,
            style: hubMono(size: 10, weight: FontWeight.w600, color: color, letterSpacing: 0.5),
          ),
        ],
      ),
    );
  }

  /// Compact chip next to the connection pill — replaces the old dismissible
  /// limit banner. Purely informational chrome now, so no dismiss affordance.
  Widget _limitChip(BuildContext context, LimitState limit) {
    final tokens = context.tokens;
    final label =
        'LIMIT ${limit.state.toUpperCase()}'
        '${limit.resetsAt != null ? ' · resets ${formatRelativeTime(limit.resetsAt!)}' : ''}';
    return Container(
      margin: const EdgeInsets.only(right: 4),
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        border: Border.all(color: tokens.border),
        borderRadius: BorderRadius.circular(kRadiusChip),
      ),
      child: Text(
        label,
        style: hubMono(size: 10, weight: FontWeight.w600, color: tokens.stWarn, letterSpacing: 0.5),
      ),
    );
  }

  Widget _themeToggle(BuildContext context) {
    final isDark = context.watch<ThemeController>().value == ThemeMode.dark;
    return IconButton(
      tooltip: 'Toggle theme',
      onPressed: () => context.read<ThemeController>().toggle(),
      icon: Text(isDark ? '☀' : '☾', style: TextStyle(fontSize: 16, color: context.tokens.text)),
    );
  }

  Widget _bannerAction(BuildContext context, String label, VoidCallback onTap) {
    final tokens = context.tokens;
    return GestureDetector(
      onTap: onTap,
      child: Text(
        label,
        style: hubSans(size: 11, weight: FontWeight.w700, color: tokens.accent, letterSpacing: 0.33),
      ),
    );
  }

  Widget _permissionBanner(BuildContext context, HubStore store, List<Permission> pending) {
    final tokens = context.tokens;
    final oldest = pending.first;
    final label =
        '${oldest.toolName} — ${_sessionLabel(store, oldest.sessionId)}'
        '${pending.length > 1 ? ' (+${pending.length - 1} more)' : ''}';
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: tokens.warnBg,
        border: Border.all(color: tokens.warnBorder),
        borderRadius: BorderRadius.circular(kRadiusCard),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Permission: $label', style: hubSans(size: 12, color: tokens.stWarn)),
          const SizedBox(height: 6),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              _bannerAction(context, 'DENY', () => _decideOldest(context, oldest, 'deny')),
              const SizedBox(width: 14),
              _bannerAction(context, 'ALLOW', () => _decideOldest(context, oldest, 'allow')),
              const SizedBox(width: 14),
              _bannerAction(
                context,
                'VIEW',
                () => Navigator.of(
                  context,
                ).push(MaterialPageRoute(builder: (_) => const PermissionsScreen())),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _navItem(BuildContext context, {required IconData icon, required String label, required int index}) {
    final tokens = context.tokens;
    final active = _selectedIndex == index;
    final color = active ? tokens.accent : tokens.dim;
    return Expanded(
      child: InkWell(
        onTap: () => setState(() => _selectedIndex = index),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(0, 9, 0, 11),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 21, color: color),
              const SizedBox(height: 3),
              Text(label, style: hubSans(size: 10, weight: FontWeight.w600, color: color)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _navAction(
    BuildContext context, {
    required IconData icon,
    required String label,
    required VoidCallback onTap,
  }) {
    final tokens = context.tokens;
    return Expanded(
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(0, 9, 0, 11),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 21, color: tokens.dim),
              const SizedBox(height: 3),
              Text(label, style: hubSans(size: 10, weight: FontWeight.w600, color: tokens.dim)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _bottomNav(BuildContext context) {
    final tokens = context.tokens;
    return Container(
      decoration: BoxDecoration(
        color: tokens.navBg,
        border: Border(top: BorderSide(color: tokens.border)),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            _navItem(context, icon: Icons.view_agenda_outlined, label: 'Sessions', index: 0),
            _navItem(context, icon: Icons.chat_bubble_outline, label: 'Chat', index: 1),
            _navItem(context, icon: Icons.menu_book_outlined, label: 'KB', index: 2),
            _navAction(
              context,
              icon: Icons.add,
              label: 'New',
              onTap: () => Navigator.of(
                context,
              ).push(MaterialPageRoute(builder: (_) => const NewSessionScreen())),
            ),
          ],
        ),
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
          if (limit != null && limit.state != 'ok') _limitChip(context, limit),
          _connectionPill(context, connection),
          _themeToggle(context),
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
          if (pending.isNotEmpty) _permissionBanner(context, store, pending),
          Expanded(child: IndexedStack(index: _selectedIndex, children: _tabs)),
        ],
      ),
      bottomNavigationBar: _bottomNav(context),
    );
  }
}
