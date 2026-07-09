import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api_client.dart';
import '../connection.dart';
import '../relative_time.dart';
import '../store.dart';

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
      await context.read<ApiClient>().sendChat(body, to: _recipient, urgent: _urgent);
      if (!mounted) return;
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

  @override
  Widget build(BuildContext context) {
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
          Expanded(
            child: !_loadedHistory && messages.isEmpty
                ? const Center(child: CircularProgressIndicator())
                : messages.isEmpty
                ? const Center(child: Text('No messages yet'))
                : ListView.builder(
                    reverse: true,
                    padding: const EdgeInsets.all(8),
                    itemCount: messages.length,
                    itemBuilder: (context, index) {
                      final m = messages[index];
                      return ListTile(
                        dense: true,
                        title: Text('${m.fromName} → ${m.toName ?? 'all'}'),
                        subtitle: Text(m.body),
                        trailing: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            if (m.urgent != 0)
                              const Icon(Icons.priority_high, size: 16, color: Colors.red),
                            Text(
                              formatRelativeTime(m.createdAt),
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ),
                      );
                    },
                  ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Column(
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: DropdownButton<String?>(
                          isExpanded: true,
                          value: _recipient,
                          hint: const Text('Broadcast'),
                          items: [
                            const DropdownMenuItem(value: null, child: Text('Broadcast')),
                            ...recipients.map(
                              (r) => DropdownMenuItem(value: r, child: Text(r)),
                            ),
                          ],
                          onChanged: (value) => setState(() => _recipient = value),
                        ),
                      ),
                      Checkbox(
                        value: _urgent,
                        onChanged: (v) => setState(() => _urgent = v ?? false),
                      ),
                      const Text('Urgent'),
                    ],
                  ),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _bodyController,
                          decoration: const InputDecoration(hintText: 'Message'),
                          maxLines: 3,
                          minLines: 1,
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
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
