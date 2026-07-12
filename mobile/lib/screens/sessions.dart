import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api_client.dart';
import '../connection.dart';
import '../models.dart';
import '../relative_time.dart';
import '../store.dart';
import '../theme.dart';
import '../widgets/status_chip.dart';
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

  /// running block (active, continuing) -> idle block (idle, interrupted) ->
  /// ended last.
  int _groupRank(String status) {
    switch (status) {
      case 'active':
      case 'continuing':
        return 0;
      case 'idle':
      case 'interrupted':
        return 1;
      case 'ended':
        return 2;
      default:
        return 1;
    }
  }

  Future<void> _refresh(BuildContext context) async {
    final connection = context.read<ConnectionManager>();
    final api = context.read<ApiClient>();
    connection.preferLan();
    try {
      final list = await api.listSessions();
      if (context.mounted) context.read<HubStore>().setSessions(list);
    } catch (e) {
      if (context.mounted) {
        showErrorSnack(context, e is ApiException ? e.message : '$e');
      }
    }
  }

  Widget _row(BuildContext context, Session s) {
    final tokens = context.tokens;
    final title = (s.instanceName != null && s.instanceName!.isNotEmpty)
        ? s.instanceName!
        : _cwdBasename(s.cwd);
    final statusColor = StatusChip.colorFor(s.status, tokens);

    return InkWell(
      onTap: () => Navigator.of(
        context,
      ).push(MaterialPageRoute(builder: (_) => SessionDetailScreen(sessionId: s.id))),
      child: Container(
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: tokens.border))),
        child: Stack(
          children: [
            Positioned(left: 0, top: 0, bottom: 0, width: 3, child: Container(color: statusColor)),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: hubSans(size: 14, weight: FontWeight.w600, color: tokens.text),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          s.cwd,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: hubMono(size: 10.5, color: tokens.dim),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 11),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      StatusChip(status: s.status, style: StatusChipStyle.label),
                      const SizedBox(height: 4),
                      Text(
                        formatRelativeTime(s.lastEventAt),
                        style: hubMono(size: 10, color: tokens.faint),
                      ),
                    ],
                  ),
                ],
              ),
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
    final sessions = store.sessions.values.toList()
      ..sort((a, b) {
        final rankCompare = _groupRank(a.status).compareTo(_groupRank(b.status));
        if (rankCompare != 0) return rankCompare;
        return b.lastEventAt.compareTo(a.lastEventAt);
      });

    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () => _refresh(context),
        child: sessions.isEmpty
            ? ListView(
                children: [
                  const SizedBox(height: 120),
                  Center(
                    child: Text('No sessions yet', style: hubSans(size: 13, color: tokens.dim)),
                  ),
                ],
              )
            : ListView.builder(
                itemCount: sessions.length,
                itemBuilder: (context, index) => _row(context, sessions[index]),
              ),
      ),
    );
  }
}
