import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'api_client.dart';
import 'connection.dart';
import 'restart_widget.dart';
import 'screens/home.dart';
import 'screens/setup.dart';
import 'settings.dart';
import 'store.dart';
import 'theme.dart';
import 'theme_controller.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final themeController = await ThemeController.load();
  runApp(
    ChangeNotifierProvider<ThemeController>.value(
      value: themeController,
      child: const RestartWidget(child: AppRoot()),
    ),
  );
}

/// Loads persisted settings once per (re)start and decides between the
/// setup flow and the fully wired main app.
///
/// Each branch owns its own [MaterialApp] (and therefore its own Navigator).
/// This matters for the wired branch: [_HubServicesRoot] must put its
/// [MultiProvider] *above* that MaterialApp's Navigator, or screens reached
/// via `Navigator.push` — SessionDetail, NewSession, Permissions, the KB
/// note sheet, Settings — sit in the Navigator's overlay as siblings of the
/// first route's content, not as descendants of it, so they can't see a
/// Provider planted only inside that first route.
///
/// [ThemeController] lives above [RestartWidget] (provided in [main]) so the
/// dark/light choice survives a Setup-save restart untouched; every
/// MaterialApp branch below just reads it for `theme`/`darkTheme`/`themeMode`.
class AppRoot extends StatefulWidget {
  const AppRoot({super.key});

  @override
  State<AppRoot> createState() => _AppRootState();
}

class _AppRootState extends State<AppRoot> {
  late final Future<AppSettings?> _settingsFuture;

  @override
  void initState() {
    super.initState();
    _settingsFuture = AppSettings.load();
  }

  @override
  Widget build(BuildContext context) {
    final themeMode = context.watch<ThemeController>().value;
    return FutureBuilder<AppSettings?>(
      future: _settingsFuture,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return MaterialApp(
            title: 'cc_hub',
            theme: buildTheme(dark: false),
            darkTheme: buildTheme(dark: true),
            themeMode: themeMode,
            home: const Scaffold(body: Center(child: CircularProgressIndicator())),
          );
        }
        final settings = snapshot.data;
        if (settings == null) {
          return MaterialApp(
            title: 'cc_hub',
            theme: buildTheme(dark: false),
            darkTheme: buildTheme(dark: true),
            themeMode: themeMode,
            home: const SetupScreen(),
          );
        }
        return _HubServicesRoot(settings: settings);
      },
    );
  }
}

/// Owns the ConnectionManager/ApiClient/HubStore for one set of AppSettings,
/// provides them via MultiProvider, and wraps its own MaterialApp so the
/// provider scope sits above that MaterialApp's Navigator (see [AppRoot]).
/// [RestartWidget] is what produces a fresh instance after Setup saves.
class _HubServicesRoot extends StatefulWidget {
  final AppSettings settings;

  const _HubServicesRoot({required this.settings});

  @override
  State<_HubServicesRoot> createState() => _HubServicesRootState();
}

class _HubServicesRootState extends State<_HubServicesRoot> with WidgetsBindingObserver {
  late final ConnectionManager _connection;
  late final ApiClient _api;
  late final HubStore _store;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _connection = ConnectionManager(widget.settings);
    _api = ApiClient(_connection);
    _store = HubStore()..refreshSessions = _api.listSessions;
    _connection.onFrame = _store.applyFrame;
    _connection.onWsConnected = _refreshPending;
    _connection.connectWs();
  }

  Future<void> _refreshPending() async {
    try {
      _store.setPending(await _api.pendingPermissions());
    } catch (_) {
      // Best-effort; the next WS connect (or a manual refresh) retries.
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    _connection.preferLan();
    if (_connection.wsStatus == WsStatus.down) {
      _connection.connectWs();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _connection.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final themeMode = context.watch<ThemeController>().value;
    return MultiProvider(
      providers: [
        ChangeNotifierProvider<ConnectionManager>.value(value: _connection),
        Provider<ApiClient>.value(value: _api),
        ChangeNotifierProvider<HubStore>.value(value: _store),
      ],
      child: MaterialApp(
        title: 'cc_hub',
        theme: buildTheme(dark: false),
        darkTheme: buildTheme(dark: true),
        themeMode: themeMode,
        home: const HomeScreen(),
      ),
    );
  }
}
