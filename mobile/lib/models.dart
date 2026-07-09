// Typed models mirroring cc_hub server API/DB shapes.
//
// Conventions carried over from the server (see cc_hub CLAUDE.md):
// - All timestamps are epoch-ms integers.
// - SQLite booleans are 0/1 integers, not bools.
// - JSON keys are snake_case.

int? _toInt(dynamic v) => (v as num?)?.toInt();

int _toIntOr(dynamic v, int fallback) => (v as num?)?.toInt() ?? fallback;

String _toStringOr(dynamic v, String fallback) => (v as String?) ?? fallback;

class Session {
  final String id;
  final int instanceId;
  final String cwd;
  final String? transcriptPath;
  final String status; // "active" | "idle" | "ended" | "interrupted" | "continuing"
  final int startedAt;
  final int lastEventAt;
  final int? endedAt;
  final String? lastPrompt;
  final int autoContinue; // 0/1
  final int continuesToday;
  final String? instanceName;

  Session({
    required this.id,
    required this.instanceId,
    required this.cwd,
    this.transcriptPath,
    required this.status,
    required this.startedAt,
    required this.lastEventAt,
    this.endedAt,
    this.lastPrompt,
    required this.autoContinue,
    required this.continuesToday,
    this.instanceName,
  });

  factory Session.fromJson(Map<String, dynamic> json) {
    return Session(
      id: json['id'] as String,
      instanceId: _toIntOr(json['instance_id'], 0),
      cwd: _toStringOr(json['cwd'], ''),
      transcriptPath: json['transcript_path'] as String?,
      status: _toStringOr(json['status'], 'idle'),
      startedAt: _toIntOr(json['started_at'], 0),
      lastEventAt: _toIntOr(json['last_event_at'], 0),
      endedAt: _toInt(json['ended_at']),
      lastPrompt: json['last_prompt'] as String?,
      autoContinue: _toIntOr(json['auto_continue'], 0),
      continuesToday: _toIntOr(json['continues_today'], 0),
      instanceName: json['instance_name'] as String?,
    );
  }
}

class Permission {
  final int id;
  final String sessionId;
  final String toolName;
  final String? toolInput; // JSON string
  final String status; // "pending" | "allowed" | "denied" | "timeout"
  final String? decidedBy;
  final String? decisionMessage;
  final int createdAt;
  final int? decidedAt;

  Permission({
    required this.id,
    required this.sessionId,
    required this.toolName,
    this.toolInput,
    required this.status,
    this.decidedBy,
    this.decisionMessage,
    required this.createdAt,
    this.decidedAt,
  });

  factory Permission.fromJson(Map<String, dynamic> json) {
    return Permission(
      id: _toIntOr(json['id'], 0),
      sessionId: _toStringOr(json['session_id'], ''),
      toolName: _toStringOr(json['tool_name'], ''),
      toolInput: json['tool_input'] as String?,
      status: _toStringOr(json['status'], 'pending'),
      decidedBy: json['decided_by'] as String?,
      decisionMessage: json['decision_message'] as String?,
      createdAt: _toIntOr(json['created_at'], 0),
      decidedAt: _toInt(json['decided_at']),
    );
  }
}

class Message {
  final int id;
  final String fromName;
  final String? toName; // null = broadcast
  final String body;
  final int urgent; // 0/1
  final int createdAt;

  Message({
    required this.id,
    required this.fromName,
    this.toName,
    required this.body,
    required this.urgent,
    required this.createdAt,
  });

  factory Message.fromJson(Map<String, dynamic> json) {
    return Message(
      id: _toIntOr(json['id'], 0),
      fromName: _toStringOr(json['from_name'], ''),
      toName: json['to_name'] as String?,
      body: _toStringOr(json['body'], ''),
      urgent: _toIntOr(json['urgent'], 0),
      createdAt: _toIntOr(json['created_at'], 0),
    );
  }
}

class SessionEvent {
  final int id;
  final String sessionId;
  final String? instanceName;
  final String type;
  final String? payload; // JSON string
  final int createdAt;

  SessionEvent({
    required this.id,
    required this.sessionId,
    this.instanceName,
    required this.type,
    this.payload,
    required this.createdAt,
  });

  factory SessionEvent.fromJson(Map<String, dynamic> json) {
    return SessionEvent(
      id: _toIntOr(json['id'], 0),
      sessionId: _toStringOr(json['session_id'], ''),
      instanceName: json['instance_name'] as String?,
      type: _toStringOr(json['type'], ''),
      payload: json['payload'] as String?,
      createdAt: _toIntOr(json['created_at'], 0),
    );
  }
}

class LimitState {
  final String state; // "ok" | "limited" | "waiting_reset" | "continuing" | "unknown"
  final num? utilization;
  final int? resetsAt;
  final int? lastPollAt;
  final String? error;

  LimitState({
    required this.state,
    this.utilization,
    this.resetsAt,
    this.lastPollAt,
    this.error,
  });

  factory LimitState.fromJson(Map<String, dynamic> json) {
    return LimitState(
      state: _toStringOr(json['state'], 'unknown'),
      utilization: json['utilization'] as num?,
      resetsAt: _toInt(json['resets_at']),
      lastPollAt: _toInt(json['last_poll_at']),
      error: json['error'] as String?,
    );
  }
}

class KbNote {
  final int id;
  final String title;
  final String body;
  final String tags;
  final String authorName;
  final int createdAt;
  final int updatedAt;

  KbNote({
    required this.id,
    required this.title,
    required this.body,
    required this.tags,
    required this.authorName,
    required this.createdAt,
    required this.updatedAt,
  });

  factory KbNote.fromJson(Map<String, dynamic> json) {
    return KbNote(
      id: _toIntOr(json['id'], 0),
      title: _toStringOr(json['title'], ''),
      body: _toStringOr(json['body'], ''),
      tags: _toStringOr(json['tags'], ''),
      authorName: _toStringOr(json['author_name'], ''),
      createdAt: _toIntOr(json['created_at'], 0),
      updatedAt: _toIntOr(json['updated_at'], 0),
    );
  }
}

class KbSearchResult {
  final int id;
  final String title;
  final String tags;
  final String snippet;
  final num rank;

  KbSearchResult({
    required this.id,
    required this.title,
    required this.tags,
    required this.snippet,
    required this.rank,
  });

  factory KbSearchResult.fromJson(Map<String, dynamic> json) {
    return KbSearchResult(
      id: _toIntOr(json['id'], 0),
      title: _toStringOr(json['title'], ''),
      tags: _toStringOr(json['tags'], ''),
      snippet: _toStringOr(json['snippet'], ''),
      rank: (json['rank'] as num?) ?? 0,
    );
  }
}
