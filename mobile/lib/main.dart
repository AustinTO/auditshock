import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'api/api_client.dart';
import 'screens/upload_screen.dart';
import 'screens/dashboard_screen.dart';
import 'screens/login_screen.dart';
import 'theme.dart';

void main() {
  runApp(const ProviderScope(child: AuditShockApp()));
}

final routerProvider = Provider<GoRouter>((ref) {
  final router = GoRouter(
    initialLocation: '/',
    refreshListenable: ref.read(apiClientProvider),
    redirect: (context, state) async {
      final isLoggedIn = await ref.read(apiClientProvider).isLoggedIn;
      final isLoggingIn = state.matchedLocation == '/login';

      if (!isLoggedIn && !isLoggingIn) return '/login';
      if (isLoggedIn && isLoggingIn) return '/';
      return null;
    },
    routes: [
      GoRoute(path: '/login', builder: (context, state) => const LoginScreen()),
      GoRoute(path: '/', builder: (context, state) => const StartScreen()),
      GoRoute(
        path: '/upload/:auditId',
        builder: (context, state) =>
            UploadScreen(auditId: state.pathParameters['auditId']!),
      ),
      GoRoute(
        path: '/dashboard/:auditId',
        builder: (context, state) =>
            DashboardScreen(auditId: state.pathParameters['auditId']!),
      ),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});

class AuditShockApp extends ConsumerWidget {
  const AuditShockApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);
    return MaterialApp.router(
      title: 'AuditShock',
      theme: AuditShockTheme.darkTheme,
      routerConfig: router,
    );
  }
}

final recentAuditsProvider = FutureProvider.autoDispose<List<dynamic>>(
  (ref) => ref.read(apiClientProvider).listAudits(),
);

class StartScreen extends ConsumerStatefulWidget {
  const StartScreen({super.key});
  @override
  ConsumerState<StartScreen> createState() => _StartScreenState();
}

class _StartScreenState extends ConsumerState<StartScreen> {
  bool _creating = false;

  @override
  Widget build(BuildContext context) {
    final audits = ref.watch(recentAuditsProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text('AuditShock'),
        actions: [
          IconButton(
            tooltip: 'Refresh audits',
            onPressed: () => ref.invalidate(recentAuditsProvider),
            icon: const Icon(Icons.refresh),
          ),
          IconButton(
            tooltip: 'Sign out',
            onPressed: () async {
              await ref.read(apiClientProvider).logout();
              ref.invalidate(recentAuditsProvider);
              if (context.mounted) context.go('/login');
            },
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          const Icon(Icons.bolt, size: 64, color: AuditShockTheme.primaryTeal),
          const SizedBox(height: 16),
          const Text(
            "Find workers' comp audit surprises before the auditor does.",
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 24),
          ElevatedButton(
            onPressed: _creating
                ? null
                : () async {
                    setState(() => _creating = true);
                    try {
                      final id = await ref
                          .read(apiClientProvider)
                          .createAudit(name: 'New Audit');
                      ref.invalidate(recentAuditsProvider);
                      if (context.mounted) context.go('/upload/$id');
                    } catch (_) {
                      if (context.mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text(
                              'Unable to create audit. Please retry.',
                            ),
                          ),
                        );
                      }
                    } finally {
                      if (mounted) setState(() => _creating = false);
                    }
                  },
            child: Text(_creating ? 'CREATING AUDIT...' : 'START NEW AUDIT'),
          ),
          const SizedBox(height: 32),
          const Text(
            'Your audits',
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 12),
          audits.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (_, _) => Column(
              children: [
                const Text('Unable to load audits. Retry or sign in again.'),
                TextButton(
                  onPressed: () => ref.invalidate(recentAuditsProvider),
                  child: const Text('Retry'),
                ),
                TextButton(
                  onPressed: () => context.go('/login'),
                  child: const Text('Sign in'),
                ),
              ],
            ),
            data: (items) => items.isEmpty
                ? const Text(
                    'No audits yet. Start a new audit to upload your documents.',
                  )
                : Column(
                    children: items
                        .map(
                          (audit) => Card(
                            child: ListTile(
                              title: Text(audit['name'] ?? 'Audit'),
                              subtitle: Text(
                                '${audit['status']} • ${audit['created_at'] ?? ""}',
                              ),
                              trailing: const Icon(Icons.chevron_right),
                              onTap: () =>
                                  context.go('/dashboard/${audit['id']}'),
                            ),
                          ),
                        )
                        .toList(),
                  ),
          ),
        ],
      ),
    );
  }
}
