import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api_client.dart';
import '../connection.dart';
import '../models.dart';
import '../relative_time.dart';
import '../store.dart';
import '../widgets/status_chip.dart';

class _TimelineEvent {
  final String type;
  final String? payload;
  final int createdAt;

  const _TimelineEvent({required this.type, this.payload, required this.createdAt});
}

/// Session detail: header (live status via store), event timeline (backfill
/// + live via store.eventFrames), prompt composer, auto-continue switch.
class SessionDetailScreen extends StatefulWidget {
  final String sessionId;

  const SessionDetailScreen({super.key, required this.sessionId});

  @override
  State<SessionDetailScreen> createState() => _SessionDetailScreenState();
}

class _SessionDetailScreenState extends State<SessionDetailScreen> {
  Session? _session; // fields not carried by WS frames (cwd, autoContinue, ...)
  List<_TimelineEvent> _events = [];
  bool _loading = true;
  String? _loadError;
  bool _autoContinueBusy = false;
  bool _sending = false;

  final _promptController = TextEditingController();
  final _scrollController = ScrollController();
  StreamSubscription<Map<String, dynamic>>? _eventSub;

  @override
  void initState() {
    super.initState();
    _eventSub = context
        .read<HubStore>()
        .eventFrames
        .where((f) => f['sessionId'] == widget.sessionId)
        .listen(_onLiveEvent);
    _load();
  }

  Future<void> _load() async {
    try {
      final detail = await context.read<ApiClient>().getSession(widget.sessionId);
      if (!mounted) return;
      setState(() {
        _session = detail.session;
        _events = detail.events
            .map((e) => _TimelineEvent(type: e.type, payload: e.payload, createdAt: e.createdAt))
            .toList();
        _loading = false;
      });
      _scrollToBottomSoon();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _loadError = '$e';
      });
    }
  }

  void _onLiveEvent(Map<String, dynamic> data) {
    final createdAt = (data['createdAt'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch;
    setState(() {
      _events = [
        ..._events,
        _TimelineEvent(
          type: data['eventType'] as String? ?? 'event',
          payload: data['payload'] as String?,
          createdAt: createdAt,
        ),
      ];
    });
    _scrollToBottomSoon();
  }

  void _scrollToBottomSoon() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    });
  }

  Future<void> _send() async {
    final prompt = _promptController.text.trim();
    if (prompt.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      final result = await context.read<ApiClient>().sendPrompt(widget.sessionId, prompt);
      if (!mounted) return;
      _promptController.clear();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(result.delivery == 'queued' ? 'Queued — runs at next turn end' : 'Spawned'),
        ),
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _toggleAutoContinue(bool value) async {
    setState(() => _autoContinueBusy = true);
    try {
      final enabled = await context.read<ApiClient>().setAutoContinue(widget.sessionId, value);
      final current = _session;
      if (!mounted || current == null) return;
      setState(() {
        _session = Session(
          id: current.id,
          instanceId: current.instanceId,
          cwd: current.cwd,
          transcriptPath: current.transcriptPath,
          status: current.status,
          startedAt: current.startedAt,
          lastEventAt: current.lastEventAt,
          endedAt: current.endedAt,
          lastPrompt: current.lastPrompt,
          autoContinue: enabled ? 1 : 0,
          continuesToday: current.continuesToday,
          instanceName: current.instanceName,
        );
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _autoContinueBusy = false);
    }
  }

  @override
  void dispose() {
    _eventSub?.cancel();
    _promptController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<HubStore>();
    final session = _session;
    final liveStatus = store.sessions[widget.sessionId]?.status ?? session?.status;

    return Scaffold(
      appBar: AppBar(
        title: Text(session?.instanceName ?? widget.sessionId),
        actions: [
          if (session != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('Auto'),
                  Switch(
                    value: session.autoContinue != 0,
                    onChanged: _autoContinueBusy ? null : _toggleAutoContinue,
                  ),
                ],
              ),
            ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _loadError != null
              ? Center(child: Text('Failed to load: $_loadError'))
              : Column(
                  children: [
                    if (session != null)
                      Padding(
                        padding: const EdgeInsets.all(12),
                        child: Row(
                          children: [
                            StatusChip(status: liveStatus ?? session.status),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                session.cwd,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ),
                      ),
                    Expanded(
                      child: _events.isEmpty
                          ? const Center(child: Text('No events yet'))
                          : ListView.builder(
                              controller: _scrollController,
                              itemCount: _events.length,
                              itemBuilder: (context, index) {
                                final e = _events[index];
                                return ListTile(
                                  dense: true,
                                  title: Text(e.type, style: const TextStyle(fontWeight: FontWeight.bold)),
                                  subtitle: Text(
                                    e.payload ?? '',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  trailing: Text(
                                    formatRelativeTime(e.createdAt),
                                    style: Theme.of(context).textTheme.bodySmall,
                                  ),
                                );
                              },
                            ),
                    ),
                    SafeArea(
                      top: false,
                      child: Padding(
                        padding: const EdgeInsets.all(8),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            Expanded(
                              child: TextField(
                                controller: _promptController,
                                maxLength: 8000,
                                maxLines: 4,
                                minLines: 1,
                                decoration: const InputDecoration(hintText: 'Prompt'),
                              ),
                            ),
                            IconButton(
                              icon: _sending
                                  ? const SizedBox(
                                      width: 20,
                                      height: 20,
                                      child: CircularProgressIndicator(strokeWidth: 2),
                                    )
                                  : const Icon(Icons.send),
                              onPressed: _sending ? null : _send,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
    );
  }
}
