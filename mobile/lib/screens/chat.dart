import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api_client.dart';
import '../connection.dart';
import '../models.dart';
import '../relative_time.dart';
import '../store.dart';
import '../theme.dart';
import '../widgets/accent_square_button.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _bodyController = TextEditingController();
  String? _recipient; // null = broadcast
  bool _urgent = false;
  bool _sending = false;
  bool _loadedHistory = false;

  // Messages this screen itself sent this session — rendered as "own"
  // (right/accent) bubbles. cc_hub's chat is N-instance broadcast/direct
  // messaging, not a 1:1 user/assistant thread, so there's no server-side
  // "this is you" identity to key off; this is a display-only, best-effort
  // stand-in for that, scoped entirely to this screen.
  final Set<int> _ownMessageIds = {};

  @override
  void initState() {
    super.initState();
    _loadHistory();
  }

  Future<void> _loadHistory() async {
    try {
      final messages = await context.read<ApiClient>().listMessages(limit: 50);
      if (!mounted) return;
      context.read<HubStore>().mergeMessages(messages);
    } catch (_) {
      // Best-effort; live messages still arrive via WS.
    } finally {
      if (mounted) setState(() => _loadedHistory = true);
    }
  }

  Future<void> _send() async {
    final body = _bodyController.text.trim();
    if (body.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      final sent = await context.read<ApiClient>().sendChat(body, to: _recipient, urgent: _urgent);
      if (!mounted) return;
      _ownMessageIds.add(sent.id);
      _bodyController.clear();
      setState(() => _urgent = false);
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  void dispose() {
    _bodyController.dispose();
    super.dispose();
  }

  Widget _bubble(BuildContext context, Message m) {
    final tokens = context.tokens;
    final own = _ownMessageIds.contains(m.id);
    final urgent = m.urgent != 0;

    return Align(
      alignment: own ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.82),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
          decoration: BoxDecoration(
            color: own ? tokens.accent : tokens.surface,
            border: own ? null : Border.all(color: tokens.border),
            borderRadius: BorderRadius.only(
              topLeft: const Radius.circular(14),
              topRight: const Radius.circular(14),
              bottomRight: Radius.circular(own ? 4 : 14),
              bottomLeft: Radius.circular(own ? 14 : 4),
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '${m.fromName} → ${m.toName ?? 'all'}${urgent ? ' · urgent' : ''}',
                style: hubSans(
                  size: 10,
                  weight: FontWeight.w600,
                  color: own ? tokens.accentInk.withValues(alpha: 0.75) : tokens.dim,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                m.body,
                style: hubSans(
                  size: 12.5,
                  color: own ? tokens.accentInk : tokens.text,
                  height: 1.45,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                formatRelativeTime(m.createdAt),
                style: hubMono(
                  size: 9.5,
                  color: own ? tokens.accentInk.withValues(alpha: 0.75) : tokens.faint,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final store = context.watch<HubStore>();
    final messages = store.messages;
    final recipients =
        store.sessions.values
            .map((s) => s.instanceName)
            .whereType<String>()
            .where((n) => n.isNotEmpty)
            .toSet()
            .toList()
          ..sort();

    return Scaffold(
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Chat',
                  style: hubSans(
                    size: 19,
                    weight: FontWeight.w700,
                    color: tokens.text,
                    letterSpacing: -0.19,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  'Messages between your Claude Code instances',
                  style: hubSans(size: 12, color: tokens.dim),
                ),
              ],
            ),
          ),
          Expanded(
            child: !_loadedHistory && messages.isEmpty
                ? const Center(child: CircularProgressIndicator())
                : messages.isEmpty
                ? Center(child: Text('No messages yet', style: hubSans(size: 13, color: tokens.dim)))
                : ListView.separated(
                    reverse: true,
                    padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
                    itemCount: messages.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 10),
                    itemBuilder: (context, index) => _bubble(context, messages[index]),
                  ),
          ),
          Container(
            padding: const EdgeInsets.fromLTRB(12, 9, 12, 9),
            decoration: BoxDecoration(
              color: tokens.navBg,
              border: Border(top: BorderSide(color: tokens.border)),
            ),
            child: SafeArea(
              top: false,
              child: Column(
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: DropdownButton<String?>(
                          isExpanded: true,
                          value: _recipient,
                          hint: Text('Broadcast', style: hubSans(size: 12.5, color: tokens.faint)),
                          underline: Container(height: 1, color: tokens.border),
                          items: [
                            DropdownMenuItem(
                              value: null,
                              child: Text('Broadcast', style: hubSans(size: 12.5, color: tokens.text)),
                            ),
                            ...recipients.map(
                              (r) => DropdownMenuItem(
                                value: r,
                                child: Text(r, style: hubSans(size: 12.5, color: tokens.text)),
                              ),
                            ),
                          ],
                          onChanged: (value) => setState(() => _recipient = value),
                        ),
                      ),
                      Checkbox(value: _urgent, onChanged: (v) => setState(() => _urgent = v ?? false)),
                      Text('Urgent', style: hubSans(size: 12, color: tokens.dim)),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _bodyController,
                          decoration: const InputDecoration(hintText: 'Ask about a session…'),
                          maxLines: 3,
                          minLines: 1,
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
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
