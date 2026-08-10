import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api_client.dart';
import 'connection.dart';
import 'models.dart';
import 'store.dart';
import 'theme.dart';

const _pushChannel = MethodChannel('cc_hub/push');

/// Wires the native `openPermission` invocation (warm launch — the user taps
/// a `PERMISSION_REQUEST` push while the Flutter engine is already running)
/// to the in-app permission popup. iOS-only; on other platforms this channel
/// simply never receives a call.
void setupPushActionListener({
  required ApiClient api,
  required HubStore store,
  required GlobalKey<NavigatorState> navigatorKey,
}) {
  _pushChannel.setMethodCallHandler((call) async {
    if (call.method != 'openPermission') return null;
    final requestId = _parseRequestId(call.arguments);
    if (requestId != null) {
      _showPermissionPopup(api: api, store: store, navigatorKey: navigatorKey, requestId: requestId);
    }
    return null;
  });
}

/// Claims (reads + clears, native-side one-shot) a permission requestId
/// stashed by AppDelegate when a permission push was tapped while the app
/// was cold or backgrounded. Call on startup and on every app resume.
/// Best-effort: any platform error (nothing pending, channel unavailable) is
/// swallowed.
Future<void> checkPendingPermissionOnResume({
  required ApiClient api,
  required HubStore store,
  required GlobalKey<NavigatorState> navigatorKey,
}) async {
  try {
    final result = await _pushChannel.invokeMethod<Object?>('takePendingPermission');
    final requestId = _parseRequestId(result);
    if (requestId != null) {
      _showPermissionPopup(api: api, store: store, navigatorKey: navigatorKey, requestId: requestId);
    }
  } catch (_) {
    // No pending permission, or the platform channel isn't wired (non-iOS).
  }
}

int? _parseRequestId(Object? value) {
  if (value is int) return value;
  if (value is String) return int.tryParse(value);
  return null;
}

void _showPermissionPopup({
  required ApiClient api,
  required HubStore store,
  required GlobalKey<NavigatorState> navigatorKey,
  required int requestId,
}) {
  final context = navigatorKey.currentContext;
  if (context != null) {
    _openDialog(context, api: api, store: store, requestId: requestId);
    return;
  }
  // Cold-launch race: the Navigator isn't mounted yet. Retry after the first
  // frame, by which point _HubServicesRoot's MaterialApp has built.
  WidgetsBinding.instance.addPostFrameCallback((_) {
    final retryContext = navigatorKey.currentContext;
    if (retryContext != null) {
      _openDialog(retryContext, api: api, store: store, requestId: requestId);
    }
  });
}

void _openDialog(
  BuildContext context, {
  required ApiClient api,
  required HubStore store,
  required int requestId,
}) {
  showDialog<void>(
    context: context,
    barrierDismissible: true,
    builder: (_) => _PermissionPopup(requestId: requestId, api: api, store: store),
  );
}

Permission? _findById(List<Permission> list, int id) {
  for (final p in list) {
    if (p.id == id) return p;
  }
  return null;
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

String _statusLabel(Permission perm) {
  switch (perm.status) {
    case 'allowed':
      return 'Already decided — allowed${perm.decidedBy != null ? ' by ${perm.decidedBy}' : ''}';
    case 'denied':
      return 'Already decided — denied${perm.decidedBy != null ? ' by ${perm.decidedBy}' : ''}';
    case 'timeout':
      return 'Expired — answer in the terminal';
    default:
      return perm.status;
  }
}

/// Large modal popup shown when a permission push notification is tapped.
/// Fetches the request fresh (the store's `pending` list may not have it yet
/// on a cold launch, since the WS hasn't connected) and lets the user
/// Allow/Deny without leaving the dialog.
class _PermissionPopup extends StatefulWidget {
  final int requestId;
  final ApiClient api;
  final HubStore store;

  const _PermissionPopup({required this.requestId, required this.api, required this.store});

  @override
  State<_PermissionPopup> createState() => _PermissionPopupState();
}

class _PermissionPopupState extends State<_PermissionPopup> {
  Permission? _permission;
  bool _loading = true;
  bool _deciding = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final cached = _findById(widget.store.pending, widget.requestId);
    if (cached != null && mounted) {
      setState(() {
        _permission = cached;
        _loading = false;
      });
    }
    try {
      final list = await widget.api.listPermissions();
      if (!mounted) return;
      final match = _findById(list, widget.requestId);
      setState(() {
        _permission = match ?? _permission;
        _loading = false;
        if (match == null && _permission == null) _error = 'Permission request not found';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        if (_permission == null) _error = '$e';
      });
    }
  }

  Future<void> _decide(String behavior) async {
    final perm = _permission;
    if (perm == null || _deciding) return;
    setState(() => _deciding = true);
    try {
      final updated = await widget.api.decidePermission(perm.id, behavior);
      widget.store.removePending(perm.id);
      if (!mounted) return;
      setState(() {
        _permission = updated;
        _deciding = false;
      });
    } on ApiException catch (e) {
      if (e.statusCode == 409) widget.store.removePending(perm.id);
      if (!mounted) return;
      setState(() => _deciding = false);
      showErrorSnack(context, e.message);
    } catch (e) {
      if (!mounted) return;
      setState(() => _deciding = false);
      showErrorSnack(context, '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final media = MediaQuery.of(context);
    return Dialog(
      insetPadding: EdgeInsets.symmetric(horizontal: media.size.width * 0.06, vertical: 24),
      backgroundColor: tokens.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(kRadiusCard)),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: media.size.height * 0.8),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: _loading
              ? const Padding(
                  padding: EdgeInsets.symmetric(vertical: 24),
                  child: Center(child: CircularProgressIndicator()),
                )
              : _content(tokens),
        ),
      ),
    );
  }

  Widget _content(HubTokens tokens) {
    final perm = _permission;
    if (perm == null) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Permission request', style: hubSans(size: 17, weight: FontWeight.w700, color: tokens.text)),
          const SizedBox(height: 12),
          Text(
            _error ?? 'Not found — it may already be resolved.',
            style: hubSans(size: 13, color: tokens.dim),
          ),
          const SizedBox(height: 20),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Close')),
          ),
        ],
      );
    }

    final instanceLabel = widget.store.sessions[perm.sessionId]?.instanceName ?? perm.sessionId;

    return SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(instanceLabel, style: hubMono(size: 11, color: tokens.dim)),
          const SizedBox(height: 4),
          Text(
            perm.toolName,
            style: hubSans(size: 20, weight: FontWeight.w700, color: tokens.text),
          ),
          const SizedBox(height: 12),
          if (perm.toolInput != null && perm.toolInput!.isNotEmpty)
            Container(
              width: double.infinity,
              constraints: const BoxConstraints(maxHeight: 300),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: tokens.surface2, borderRadius: BorderRadius.circular(kRadiusCard)),
              child: SingleChildScrollView(
                child: Text(_prettyToolInput(perm.toolInput), style: hubMono(size: 12, color: tokens.dim)),
              ),
            ),
          const SizedBox(height: 20),
          if (perm.status == 'pending') ...[
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _deciding ? null : () => _decide('deny'),
                    style: OutlinedButton.styleFrom(
                      foregroundColor: tokens.stEnded,
                      side: BorderSide(color: tokens.stEnded),
                      padding: const EdgeInsets.symmetric(vertical: 14),
                    ),
                    child: const Text('Deny'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton(
                    onPressed: _deciding ? null : () => _decide('allow'),
                    style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
                    child: const Text('Allow'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.center,
              child: TextButton(
                onPressed: _deciding ? null : () => Navigator.of(context).pop(),
                child: const Text('Dismiss'),
              ),
            ),
          ] else ...[
            Text(_statusLabel(perm), style: hubSans(size: 13, weight: FontWeight.w600, color: tokens.dim)),
            const SizedBox(height: 16),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Close')),
            ),
          ],
        ],
      ),
    );
  }
}
