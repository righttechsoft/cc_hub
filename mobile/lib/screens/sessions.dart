import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api_client.dart';
import '../connection.dart';
import '../relative_time.dart';
import '../store.dart';
import '../widgets/status_chip.dart';
import 'new_session.dart';
import 'session_detail.dart';

class SessionsScreen extends StatelessWidget {
  const SessionsScreen({super.key});

  String _cwdBasename(String cwd) {
    var trimmed = cwd;
    while (trimmed.length > 1 && (trimmed.endsWith('/') || trimmed.endsWith('\\'))) {
      trimmed = trimmed.substring(0, trimmed.length - 1);
    }
    final idx = trimmed.lastIndexOf(RegExp(r'[\\/]'));
    return idx == -1 ? trimmed : trimmed.substring(idx + 1);
  }

  Future<void> _refresh(BuildContext context) async {
    final connection = context.read<ConnectionManager>();
    final api = context.read<ApiClient>();
    connection.preferLan();
    final list = await api.listSessions();
    if (context.mounted) context.read<HubStore>().setSessions(list);
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<HubStore>();
    final sessions = store.sessions.values.toList()
      ..sort((a, b) => b.lastEventAt.compareTo(a.lastEventAt));

    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () => _refresh(context),
        child: sessions.isEmpty
            ? ListView(
                children: const [
                  SizedBox(height: 120),
                  Center(child: Text('No sessions yet')),
                ],
              )
            : ListView.builder(
                itemCount: sessions.length,
                itemBuilder: (context, index) {
                  final s = sessions[index];
                  final title = (s.instanceName != null && s.instanceName!.isNotEmpty)
                      ? s.instanceName!
                      : _cwdBasename(s.cwd);
                  return ListTile(
                    title: Text(title),
                    subtitle: Text(s.cwd, maxLines: 1, overflow: TextOverflow.ellipsis),
                    trailing: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        StatusChip(status: s.status),
                        const SizedBox(height: 4),
                        Text(
                          formatRelativeTime(s.lastEventAt),
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ],
                    ),
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => SessionDetailScreen(sessionId: s.id)),
                    ),
                  );
                },
              ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => const NewSessionScreen()),
        ),
        child: const Icon(Icons.add),
      ),
    );
  }
}
