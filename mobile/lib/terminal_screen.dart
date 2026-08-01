import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:xterm/xterm.dart';

import 'connection.dart';
import 'store.dart';
import 'theme.dart';

/// Read-only mirror of a live Claude Code terminal, streamed over the
/// existing `/ws` connection. Protocol: `attach_subscribe {cwd}` on open,
/// `attach_unsubscribe` on close; the hub replies with `attach_output`
/// frames (`{cwd,b64}`, raw terminal bytes — first one is a scrollback
/// replay) and `attach_status` frames tracked centrally in [HubStore.attachedCwds].
///
/// View-only: no keystrokes are ever sent back (prompts go through the
/// existing composer elsewhere) — [TerminalView] is built `readOnly: true`.
/// Scrolling still works; that's TerminalView's own scroll handling, not
/// gated by readOnly.
class TerminalScreen extends StatefulWidget {
  final String cwd;
  final String? instanceName;

  const TerminalScreen({super.key, required this.cwd, this.instanceName});

  @override
  State<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends State<TerminalScreen> {
  late final Terminal _terminal;
  late final ConnectionManager _connection;
  StreamSubscription<Map<String, dynamic>>? _outputSub;
  WsStatus _lastWsStatus = WsStatus.down;

  @override
  void initState() {
    super.initState();
    _terminal = Terminal(maxLines: 5000);
    _connection = context.read<ConnectionManager>();
    _lastWsStatus = _connection.wsStatus;
    _connection.addListener(_onConnectionChanged);
    _outputSub = context
        .read<HubStore>()
        .attachOutputFrames
        .where((f) => f['cwd'] == widget.cwd)
        .listen(_onOutput);
    _subscribe();
  }

  void _subscribe() {
    _connection.sendFrame({
      'type': 'attach_subscribe',
      'data': {'cwd': widget.cwd},
    });
  }

  /// Re-subscribes on a down/connecting -> up transition, i.e. a reconnect —
  /// the hub has no memory of a dropped socket's subscription.
  void _onConnectionChanged() {
    final status = _connection.wsStatus;
    if (status == WsStatus.up && _lastWsStatus != WsStatus.up) {
      _subscribe();
    }
    _lastWsStatus = status;
  }

  void _onOutput(Map<String, dynamic> data) {
    final b64 = data['b64'] as String?;
    if (b64 == null) return;
    try {
      _terminal.write(utf8.decode(base64Decode(b64), allowMalformed: true));
    } catch (_) {
      // Malformed frame — drop it, the next one keeps the stream going.
    }
  }

  @override
  void dispose() {
    _connection.sendFrame({'type': 'attach_unsubscribe'});
    _connection.removeListener(_onConnectionChanged);
    _outputSub?.cancel();
    super.dispose();
  }

  Widget _header(BuildContext context, HubTokens tokens, String title, bool attached) {
    return Container(
      padding: const EdgeInsets.fromLTRB(4, 4, 12, 10),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: tokens.border))),
      child: Row(
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
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: hubSans(size: 16, weight: FontWeight.w700, color: tokens.text, letterSpacing: -0.16),
            ),
          ),
          const SizedBox(width: 8),
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              color: attached ? tokens.stRunning : tokens.faint,
              shape: BoxShape.circle,
            ),
          ),
          const SizedBox(width: 5),
          Text(
            attached ? 'LIVE' : 'DETACHED',
            style: hubMono(
              size: 10,
              weight: FontWeight.w600,
              color: attached ? tokens.stRunning : tokens.faint,
              letterSpacing: 0.5,
            ),
          ),
        ],
      ),
    );
  }

  Widget _detachedBanner(HubTokens tokens) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      color: tokens.warnBg,
      child: Text(
        'terminal detached — showing last output',
        style: hubSans(size: 11, color: tokens.stWarn),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final store = context.watch<HubStore>();
    final attached = store.attachedCwds.contains(widget.cwd);
    final title = (widget.instanceName != null && widget.instanceName!.isNotEmpty)
        ? widget.instanceName!
        : widget.cwd;

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            _header(context, tokens, title, attached),
            if (!attached) _detachedBanner(tokens),
            Expanded(child: TerminalView(_terminal, readOnly: true)),
          ],
        ),
      ),
    );
  }
}
