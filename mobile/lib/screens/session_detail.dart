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
import '../widgets/accent_square_button.dart';
import '../widgets/mini_toggle.dart';
import '../widgets/status_chip.dart';

class _TimelineEvent {
  final String type;
  final String? payload;
  final int createdAt;

  const _TimelineEvent({required this.type, this.payload, required this.createdAt});
}

/// Best-effort human-readable one-liner for an event's JSON payload (the
/// `prompt` or `message` field, if present) — display-only, never affects
/// what's fetched or stored.
String? _humanSummary(String? payload) {
  if (payload == null || payload.isEmpty) return null;
  try {
    final decoded = jsonDecode(payload);
    if (decoded is Map) {
      final prompt = decoded['prompt'];
      if (prompt is String && prompt.trim().isNotEmpty) return prompt;
      final message = decoded['message'];
      if (message is String && message.trim().isNotEmpty) return message;
    }
  } catch (_) {
    // Not JSON / not decodable — no summary available.
  }
  return null;
}

Color _toneColor(String type, HubTokens tokens) {
  switch (type) {
    case 'UserPromptSubmit':
      return tokens.accent;
    case 'Notification':
      return tokens.stWarn;
    case 'Stop':
      return tokens.dim;
    default:
      return tokens.dim;
  }
}

/// Session detail: header (live status via store), event timeline (backfill
/// + live via store.eventFrames), prompt composer, auto-continue toggle.
///
/// Timeline renders newest-first (matches the design): the underlying
/// [_events] list still stores oldest-at-0/newest-appended-last exactly as
/// before, only the ListView's `reverse: true` flag changes how it's drawn,
/// so "newest" now visually means "top" and the jump button scrolls to
/// offset 0 instead of the end.
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
      _scrollToNewestSoon();
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
    _scrollToNewestSoon();
  }

  void _scrollToNewestSoon() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.animateTo(0, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
    });
  }

  void _jumpToNewest() {
    if (!_scrollController.hasClients) return;
    _scrollController.animateTo(0, duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
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

  Widget _header(BuildContext context, Session? session, String? liveStatus) {
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              InkWell(
                onTap: () => Navigator.of(context).pop(),
                borderRadius: BorderRadius.circular(kRadiusCard),
                child: SizedBox(
                  width: 30,
                  height: 30,
                  child: Icon(Icons.arrow_back, size: 18, color: tokens.text),
                ),
              ),
              Expanded(
                child: Text(
                  session?.instanceName ?? widget.sessionId,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: hubSans(
                    size: 16,
                    weight: FontWeight.w700,
                    color: tokens.text,
                    letterSpacing: -0.16,
                  ),
                ),
              ),
              if (session != null) ...[
                const SizedBox(width: 8),
                Text('Auto', style: hubSans(size: 11, color: tokens.dim)),
                const SizedBox(width: 8),
                MiniToggle(
                  value: session.autoContinue != 0,
                  onChanged: _autoContinueBusy ? null : _toggleAutoContinue,
                ),
              ],
            ],
          ),
          if (session != null) ...[
            const SizedBox(height: 9),
            Row(
              children: [
                StatusChip(status: liveStatus ?? session.status, style: StatusChipStyle.pill),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    session.cwd,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: hubMono(size: 11, color: tokens.dim),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _eventRow(BuildContext context, _TimelineEvent e) {
    final tokens = context.tokens;
    final tone = _toneColor(e.type, tokens);
    final summary = e.type == 'Stop' ? null : _humanSummary(e.payload);

    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 14,
            child: Column(
              children: [
                const SizedBox(height: 4),
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(color: tone, borderRadius: BorderRadius.circular(3)),
                ),
                const SizedBox(height: 3),
                Expanded(child: Container(width: 2, color: tokens.border)),
              ],
            ),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      Expanded(
                        child: Text(
                          e.type,
                          style: hubSans(size: 13, weight: FontWeight.w700, color: tone),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(formatRelativeTime(e.createdAt), style: hubMono(size: 10, color: tokens.faint)),
                    ],
                  ),
                  if (e.type == 'Stop')
                    Padding(
                      padding: const EdgeInsets.only(top: 3),
                      child: Text('null', style: hubMono(size: 11, color: tokens.faint)),
                    )
                  else if (summary != null) ...[
                    Padding(
                      padding: const EdgeInsets.only(top: 5),
                      child: Container(
                        width: double.infinity,
                        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 7),
                        decoration: BoxDecoration(
                          color: tokens.surface,
                          border: Border.all(color: tokens.border),
                          borderRadius: BorderRadius.circular(kRadiusCard),
                        ),
                        child: Text(
                          summary,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: hubSans(size: 12, color: tokens.text, height: 1.4),
                        ),
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                        e.payload ?? '',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: hubMono(size: 9.5, color: tokens.faint),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _composer(BuildContext context) {
    final tokens = context.tokens;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 9, 12, 12),
      decoration: BoxDecoration(color: tokens.navBg, border: Border(top: BorderSide(color: tokens.border))),
      child: SafeArea(
        top: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: TextField(
                    controller: _promptController,
                    maxLength: 8000,
                    maxLines: 4,
                    minLines: 1,
                    buildCounter: (context, {required currentLength, required isFocused, maxLength}) => null,
                    decoration: const InputDecoration(hintText: 'Prompt'),
                  ),
                ),
                const SizedBox(width: 9),
                AccentSquareButton(
                  size: 38,
                  radius: kRadiusSend,
                  onTap: _sending ? null : _send,
                  child: _sending
                      ? SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: tokens.accentInk),
                        )
                      : Icon(Icons.arrow_forward, size: 17, color: tokens.accentInk),
                ),
              ],
            ),
            const SizedBox(height: 4),
            ValueListenableBuilder<TextEditingValue>(
              valueListenable: _promptController,
              builder: (context, value, _) => Text(
                '${value.text.length}/8000',
                style: hubMono(size: 9.5, color: tokens.faint),
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
    final session = _session;
    final liveStatus = store.sessions[widget.sessionId]?.status ?? session?.status;

    return Scaffold(
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _loadError != null
          ? Center(
              child: Text(
                'Failed to load: $_loadError',
                style: hubSans(size: 13, color: tokens.dim),
              ),
            )
          : Column(
              children: [
                _header(context, session, liveStatus),
                Expanded(
                  child: Stack(
                    children: [
                      _events.isEmpty
                          ? Center(
                              child: Text('No events yet', style: hubSans(size: 13, color: tokens.dim)),
                            )
                          : ListView.builder(
                              reverse: true,
                              controller: _scrollController,
                              padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
                              itemCount: _events.length,
                              itemBuilder: (context, index) => _eventRow(context, _events[index]),
                            ),
                      if (_events.isNotEmpty)
                        Positioned(
                          right: 14,
                          bottom: 14,
                          child: GestureDetector(
                            onTap: _jumpToNewest,
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
                              decoration: BoxDecoration(
                                color: tokens.accent,
                                borderRadius: BorderRadius.circular(999),
                                boxShadow: [
                                  BoxShadow(
                                    color: Colors.black.withValues(alpha: 0.35),
                                    blurRadius: 16,
                                    offset: const Offset(0, 6),
                                  ),
                                ],
                              ),
                              child: Text(
                                '↑ Newest',
                                style: hubSans(
                                  size: 11,
                                  weight: FontWeight.w700,
                                  color: tokens.accentInk,
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                _composer(context),
              ],
            ),
    );
  }
}
