import 'package:cc_hub_mobile/store.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _frame(String type, Map<String, dynamic> data) => {
      'type': type,
      'data': data,
    };

const _helloSession = {
  'id': 's1',
  'instance_id': 1,
  'cwd': '/a',
  'status': 'idle',
  'started_at': 1,
  'last_event_at': 2,
  'auto_continue': 0,
  'continues_today': 0,
};

void main() {
  group('HubStore.applyFrame', () {
    test('hello replaces sessions and limit', () {
      final store = HubStore();

      store.applyFrame(_frame('hello', {
        'sessions': [_helloSession],
        'limit': {'state': 'ok'},
      }));

      expect(store.sessions.length, 1);
      expect(store.sessions['s1']?.status, 'idle');
      expect(store.limit?.state, 'ok');
    });

    test('session_status patches a known session', () {
      final store = HubStore();
      store.applyFrame(_frame('hello', {
        'sessions': [_helloSession],
        'limit': null,
      }));

      store.applyFrame(_frame('session_status', {'sessionId': 's1', 'status': 'active'}));

      expect(store.sessions['s1']?.status, 'active');
    });

    test('session_status for an unknown session id refreshes exactly once for a burst', () async {
      final store = HubStore();
      var refreshCalls = 0;
      store.refreshSessions = () async {
        refreshCalls++;
        await Future<void>.delayed(const Duration(milliseconds: 10));
        return [];
      };

      store.applyFrame(_frame('session_status', {'sessionId': 'unknown-1', 'status': 'active'}));
      store.applyFrame(_frame('session_status', {'sessionId': 'unknown-2', 'status': 'idle'}));
      store.applyFrame(_frame('session_status', {'sessionId': 'unknown-3', 'status': 'idle'}));

      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(refreshCalls, 1);
    });

    test('message prepends newest-first and caps at 200', () {
      final store = HubStore();

      for (var i = 0; i < 205; i++) {
        store.applyFrame(_frame('message', {
          'id': i,
          'from_name': 'a',
          'body': 'msg $i',
          'urgent': 0,
          'created_at': i,
        }));
      }

      expect(store.messages.length, 200);
      expect(store.messages.first.id, 204);
      expect(store.messages.last.id, 5);
    });

    test('permission_request adds and dedupes by id', () {
      final store = HubStore();
      final perm = {
        'id': 1,
        'session_id': 's1',
        'tool_name': 'Bash',
        'status': 'pending',
        'created_at': 1,
      };

      store.applyFrame(_frame('permission_request', perm));
      store.applyFrame(_frame('permission_request', perm));

      expect(store.pending.length, 1);
    });

    test('permission_decided removes from pending', () {
      final store = HubStore();
      store.applyFrame(_frame('permission_request', {
        'id': 1,
        'session_id': 's1',
        'tool_name': 'Bash',
        'status': 'pending',
        'created_at': 1,
      }));

      store.applyFrame(_frame('permission_decided', {
        'id': 1,
        'session_id': 's1',
        'tool_name': 'Bash',
        'status': 'allowed',
        'created_at': 1,
        'decided_at': 2,
      }));

      expect(store.pending, isEmpty);
    });

    test('limit_state replaces limit', () {
      final store = HubStore();

      store.applyFrame(_frame('limit_state', {'state': 'limited', 'utilization': 99}));

      expect(store.limit?.state, 'limited');
      expect(store.limit?.utilization, 99);
    });

    test('unknown frame type is ignored without notifying', () {
      final store = HubStore();
      var notified = 0;
      store.addListener(() => notified++);

      store.applyFrame(_frame('pong', {}));

      expect(notified, 0);
    });
  });

  group('HubStore.setPending', () {
    test('replaces the pending list and notifies', () {
      final store = HubStore();
      var notified = 0;
      store.addListener(() => notified++);

      store.setPending([]);

      expect(notified, 1);
      expect(store.pending, isEmpty);
    });
  });
}
