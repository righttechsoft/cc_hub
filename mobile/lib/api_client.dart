import 'connection.dart';
import 'models.dart';

/// Thin 1:1 wrappers over [ConnectionManager.request] for the cc_hub mobile
/// API (`/api/v1/*`). Entity responses parse into models.dart types; ad hoc
/// response envelopes (health, session detail, prompt result, limit) use
/// Dart records instead of one-off wrapper classes.
///
/// Non-2xx responses throw [ApiException] or [AuthException] — see
/// [ConnectionManager.request].
class ApiClient {
  final ConnectionManager connection;

  ApiClient(this.connection);

  Future<({String status, int uptimeMs, LimitState limit})> health() async {
    final json = await connection.request('GET', '/health');
    return (
      status: json['status'] as String? ?? 'unknown',
      uptimeMs: (json['uptimeMs'] as num?)?.toInt() ?? 0,
      limit: LimitState.fromJson(json['limit'] as Map<String, dynamic>? ?? {}),
    );
  }

  Future<List<Session>> listSessions({List<String>? status}) async {
    final query = (status != null && status.isNotEmpty) ? {'status': status.join(',')} : null;
    final json = await connection.request('GET', '/sessions', query: query);
    return _list(json['sessions']).map((e) => Session.fromJson(e)).toList();
  }

  Future<({Session session, List<dynamic> pendingPrompts, List<SessionEvent> events})> getSession(
    String id,
  ) async {
    final json = await connection.request('GET', '/sessions/$id');
    return (
      session: Session.fromJson(json['session'] as Map<String, dynamic>? ?? {}),
      pendingPrompts: (json['pendingPrompts'] as List<dynamic>?) ?? const [],
      events: _list(json['events']).map((e) => SessionEvent.fromJson(e)).toList(),
    );
  }

  /// `GET /sessions/:id/transcript` — pass [tailBytes] for the first load,
  /// [afterByte] (the previous response's byteOffset) for incremental
  /// refetches. A 409 `no_transcript` response is a normal, typed outcome
  /// (`available: false`) rather than a thrown exception — callers decide
  /// whether to fall back to the event timeline; any other error (404,
  /// network) still throws as usual.
  Future<({List<TranscriptEntry> entries, int byteOffset, bool truncatedHead, bool available})> getTranscript(
    String sessionId, {
    int? afterByte,
    int? tailBytes,
  }) async {
    final query = <String, String>{
      if (afterByte != null) 'afterByte': afterByte.toString(),
      if (afterByte == null && tailBytes != null) 'tailBytes': tailBytes.toString(),
    };
    try {
      final json = await connection.request(
        'GET',
        '/sessions/$sessionId/transcript',
        query: query.isEmpty ? null : query,
      );
      return (
        entries: _list(json['entries']).map((e) => TranscriptEntry.fromJson(e)).toList(),
        byteOffset: (json['byteOffset'] as num?)?.toInt() ?? 0,
        truncatedHead: json['truncatedHead'] == true,
        available: true,
      );
    } on ApiException catch (e) {
      if (e.code == 'no_transcript') {
        return (entries: <TranscriptEntry>[], byteOffset: 0, truncatedHead: false, available: false);
      }
      rethrow;
    }
  }

  Future<List<SessionEvent>> getEvents(String id, {int? afterId, int? limit}) async {
    final query = <String, String>{
      if (afterId != null) 'afterId': afterId.toString(),
      if (limit != null) 'limit': limit.toString(),
    };
    final json = await connection.request(
      'GET',
      '/sessions/$id/events',
      query: query.isEmpty ? null : query,
    );
    return _list(json['events']).map((e) => SessionEvent.fromJson(e)).toList();
  }

  /// POST /sessions — new endpoint, may not exist on an older live hub yet.
  Future<bool> newSession(String cwd, String prompt, {String? permissionMode}) async {
    final json = await connection.request(
      'POST',
      '/sessions',
      jsonBody: {
        'cwd': cwd,
        'prompt': prompt,
        'permissionMode': ?permissionMode,
      },
    );
    return json['spawned'] == true;
  }

  Future<({String delivery, int? pendingPromptId})> sendPrompt(String id, String prompt) async {
    final json = await connection.request(
      'POST',
      '/sessions/$id/prompt',
      jsonBody: {'prompt': prompt},
    );
    return (
      delivery: json['delivery'] as String? ?? '',
      pendingPromptId: (json['pendingPromptId'] as num?)?.toInt(),
    );
  }

  Future<bool> setAutoContinue(String id, bool enabled) async {
    final json = await connection.request(
      'POST',
      '/sessions/$id/auto-continue',
      jsonBody: {'enabled': enabled},
    );
    final value = json['auto_continue'];
    if (value is bool) return value;
    if (value is num) return value != 0;
    return enabled;
  }

  Future<List<Permission>> pendingPermissions() => listPermissions(status: 'pending');

  /// [status] omitted returns all permissions (used for the decided-history
  /// list); pass 'pending' for just the outstanding ones.
  Future<List<Permission>> listPermissions({String? status}) async {
    final json = await connection.request(
      'GET',
      '/permissions',
      query: status != null ? {'status': status} : null,
    );
    return _list(json['permissions']).map((e) => Permission.fromJson(e)).toList();
  }

  Future<Permission> decidePermission(int id, String behavior, {String? message}) async {
    final json = await connection.request(
      'POST',
      '/permissions/$id/decision',
      jsonBody: {
        'behavior': behavior,
        'message': ?message,
      },
    );
    return Permission.fromJson(json['permission'] as Map<String, dynamic>? ?? {});
  }

  Future<List<Message>> listMessages({int? limit, int? beforeId}) async {
    final query = <String, String>{
      if (limit != null) 'limit': limit.toString(),
      if (beforeId != null) 'beforeId': beforeId.toString(),
    };
    final json = await connection.request('GET', '/messages', query: query.isEmpty ? null : query);
    return _list(json['messages']).map((e) => Message.fromJson(e)).toList();
  }

  Future<Message> sendChat(String body, {String? to, bool? urgent}) async {
    final json = await connection.request(
      'POST',
      '/messages',
      jsonBody: {
        'body': body,
        'to': ?to,
        'urgent': ?urgent,
      },
    );
    return Message.fromJson(json['message'] as Map<String, dynamic>? ?? {});
  }

  Future<List<KbSearchResult>> kbSearch(String q, {int? limit}) async {
    final query = <String, String>{
      'q': q,
      if (limit != null) 'limit': limit.toString(),
    };
    final json = await connection.request('GET', '/kb/search', query: query);
    return _list(json['results']).map((e) => KbSearchResult.fromJson(e)).toList();
  }

  Future<KbNote> kbGet(int id) async {
    final json = await connection.request('GET', '/kb/$id');
    return KbNote.fromJson(json['note'] as Map<String, dynamic>? ?? {});
  }

  Future<KbNote> kbAdd(String title, String body, {String? tags}) async {
    final json = await connection.request(
      'POST',
      '/kb',
      jsonBody: {
        'title': title,
        'body': body,
        'tags': ?tags,
      },
    );
    return KbNote.fromJson(json['note'] as Map<String, dynamic>? ?? {});
  }

  Future<({LimitState state, List<dynamic> events})> getLimit() async {
    final json = await connection.request('GET', '/limit');
    return (
      state: LimitState.fromJson(json['state'] as Map<String, dynamic>? ?? {}),
      events: (json['events'] as List<dynamic>?) ?? const [],
    );
  }

  Future<void> registerPush(String token) async {
    await connection.request(
      'POST',
      '/push/register',
      jsonBody: {'token': token, 'platform': 'ios'},
    );
  }

  List<Map<String, dynamic>> _list(dynamic value) {
    if (value is! List) return const [];
    return value.whereType<Map<String, dynamic>>().toList();
  }
}
