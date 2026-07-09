import 'dart:async';

import 'package:flutter/foundation.dart';

import 'models.dart';

/// In-memory app state kept in sync purely by [applyFrame] (fed every
/// decoded WS frame by ConnectionManager's `onFrame`) plus the one-shot
/// [setPending] call wiring does right after each WS connect (`hello` does
/// not include permissions).
class HubStore extends ChangeNotifier {
  Map<String, Session> sessions = {};
  List<Permission> pending = [];
  List<Message> messages = []; // newest first
  LimitState? limit;

  static const int _maxMessages = 200;

  /// Wired by app startup to `ApiClient.listSessions`. Used to resync the
  /// session map when a `session_status` frame names a session we don't
  /// have yet (e.g. a session created before this app connected). Guarded
  /// so a burst of frames for unknown sessions triggers one fetch, not N.
  Future<List<Session>> Function()? refreshSessions;
  bool _refreshInFlight = false;

  /// Raw `session_event` payloads (`{sessionId,eventType,payload,createdAt}`),
  /// for a future session detail screen. Not replayed for late subscribers.
  Stream<Map<String, dynamic>> get eventFrames => _eventFrames.stream;
  final StreamController<Map<String, dynamic>> _eventFrames =
      StreamController<Map<String, dynamic>>.broadcast();

  void applyFrame(Map<String, dynamic> frame) {
    final data = frame['data'];
    final dataMap = data is Map<String, dynamic> ? data : <String, dynamic>{};

    switch (frame['type']) {
      case 'hello':
        _applyHello(dataMap);
        break;
      case 'session_status':
        _applySessionStatus(dataMap);
        break;
      case 'session_event':
        _applySessionEvent(dataMap);
        break;
      case 'message':
        _applyMessage(dataMap);
        break;
      case 'permission_request':
        _applyPermissionRequest(dataMap);
        break;
      case 'permission_decided':
        _applyPermissionDecided(dataMap);
        break;
      case 'limit_state':
        _applyLimitState(dataMap);
        break;
      default:
        return; // unknown/ping/pong — nothing to apply, no notify
    }
    notifyListeners();
  }

  void _applyHello(Map<String, dynamic> data) {
    final list = (data['sessions'] as List<dynamic>? ?? [])
        .whereType<Map<String, dynamic>>()
        .map(Session.fromJson)
        .toList();
    sessions = {for (final s in list) s.id: s};
    final limitJson = data['limit'];
    limit = limitJson is Map<String, dynamic> ? LimitState.fromJson(limitJson) : null;
  }

  void _applySessionStatus(Map<String, dynamic> data) {
    final id = data['sessionId'] as String?;
    if (id == null) return;
    final existing = sessions[id];
    if (existing == null) {
      _triggerSessionsRefresh();
      return;
    }
    final status = data['status'] as String? ?? existing.status;
    sessions = {...sessions, id: _withStatus(existing, status)};
  }

  Session _withStatus(Session s, String status) => Session(
        id: s.id,
        instanceId: s.instanceId,
        cwd: s.cwd,
        transcriptPath: s.transcriptPath,
        status: status,
        startedAt: s.startedAt,
        lastEventAt: s.lastEventAt,
        endedAt: s.endedAt,
        lastPrompt: s.lastPrompt,
        autoContinue: s.autoContinue,
        continuesToday: s.continuesToday,
        instanceName: s.instanceName,
      );

  void _triggerSessionsRefresh() {
    if (_refreshInFlight) return;
    final fn = refreshSessions;
    if (fn == null) return;
    _refreshInFlight = true;
    fn().then((list) {
      sessions = {for (final s in list) s.id: s};
      notifyListeners();
    }).catchError((_) {
      // Best-effort; a later session_status frame can retry.
    }).whenComplete(() {
      _refreshInFlight = false;
    });
  }

  void _applySessionEvent(Map<String, dynamic> data) {
    final id = data['sessionId'] as String?;
    final createdAt = (data['createdAt'] as num?)?.toInt();
    if (id != null && createdAt != null) {
      final existing = sessions[id];
      if (existing != null) {
        sessions = {
          ...sessions,
          id: Session(
            id: existing.id,
            instanceId: existing.instanceId,
            cwd: existing.cwd,
            transcriptPath: existing.transcriptPath,
            status: existing.status,
            startedAt: existing.startedAt,
            lastEventAt: createdAt,
            endedAt: existing.endedAt,
            lastPrompt: existing.lastPrompt,
            autoContinue: existing.autoContinue,
            continuesToday: existing.continuesToday,
            instanceName: existing.instanceName,
          ),
        };
      }
    }
    _eventFrames.add(data);
  }

  void _applyMessage(Map<String, dynamic> data) {
    messages = [Message.fromJson(data), ...messages];
    if (messages.length > _maxMessages) {
      messages = messages.sublist(0, _maxMessages);
    }
  }

  void _applyPermissionRequest(Map<String, dynamic> data) {
    final perm = Permission.fromJson(data);
    if (pending.any((p) => p.id == perm.id)) return;
    pending = [...pending, perm];
  }

  void _applyPermissionDecided(Map<String, dynamic> data) {
    final perm = Permission.fromJson(data);
    pending = pending.where((p) => p.id != perm.id).toList();
  }

  void _applyLimitState(Map<String, dynamic> data) {
    limit = LimitState.fromJson(data);
  }

  /// One-shot refetch of pending permissions, called by wiring right after
  /// each WS connect (`hello` doesn't carry permissions).
  void setPending(List<Permission> perms) {
    pending = perms;
    notifyListeners();
  }

  /// Removes a single permission locally (e.g. after a 409 "already decided"
  /// response) without waiting for the `permission_decided` frame.
  void removePending(int id) {
    pending = pending.where((p) => p.id != id).toList();
    notifyListeners();
  }

  /// Replaces the session map wholesale — used by the Sessions screen's
  /// pull-to-refresh (`ApiClient.listSessions`).
  void setSessions(List<Session> list) {
    sessions = {for (final s in list) s.id: s};
    notifyListeners();
  }

  /// Merges a fetched message page into the live list, deduping by id, and
  /// re-applies the newest-first cap. Used when Chat opens and backfills
  /// history alongside whatever already arrived live.
  void mergeMessages(List<Message> fetched) {
    final byId = {for (final m in messages) m.id: m};
    for (final m in fetched) {
      byId[m.id] = m;
    }
    final merged = byId.values.toList()..sort((a, b) => b.id.compareTo(a.id));
    messages = merged.length > _maxMessages ? merged.sublist(0, _maxMessages) : merged;
    notifyListeners();
  }

  @override
  void dispose() {
    _eventFrames.close();
    super.dispose();
  }
}
