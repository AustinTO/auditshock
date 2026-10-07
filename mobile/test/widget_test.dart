import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:auditshock/api/api_client.dart';
import 'package:auditshock/main.dart';
import 'package:auditshock/screens/dashboard_screen.dart';
import 'package:auditshock/screens/upload_screen.dart';
import 'package:auditshock/screens/review_dialog.dart';

class FakeApiClient extends ApiClient {
  @override
  Future<List<dynamic>> listAudits() async => [];
  @override
  Future<bool> get isLoggedIn async => false;
  @override
  Future<String> createAudit({
    required String name,
    String? start,
    String? end,
  }) async => throw StateError('Offline');
}

class PendingAnalysisClient extends FakeApiClient {
  final pending = Completer<void>();
  int analysisRequests = 0;
  @override
  Future<void> analyzeAudit(String auditId) {
    analysisRequests++;
    return pending.future;
  }
}

void main() {
  testWidgets('Unauthenticated users see login', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiClientProvider.overrideWithValue(FakeApiClient())],
        child: const AuditShockApp(),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Secure Login'), findsOneWidget);
    expect(find.text('SEND CODE'), findsOneWidget);
  });

  testWidgets('Audit creation failure is recoverable', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [apiClientProvider.overrideWithValue(FakeApiClient())],
        child: const MaterialApp(home: StartScreen()),
      ),
    );
    await tester.tap(find.text('START NEW AUDIT'));
    await tester.pumpAndSettle();
    expect(find.text('Unable to create audit. Please retry.'), findsOneWidget);
    expect(
      tester.widget<ElevatedButton>(find.byType(ElevatedButton)).onPressed,
      isNotNull,
    );
  });

  testWidgets('Results never fabricate a zero premium', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dashboardFutureProvider('a').overrideWith(
            (ref) async => {
              'audit': {'status': 'COMPLETE'},
              'vendors': [],
              'findings': [
                {
                  'kind': 'MISSING_DOCUMENTATION',
                  'vendor_id': 'v',
                  'data_json': '{"estimate":null}',
                },
              ],
            },
          ),
        ],
        child: const MaterialApp(home: DashboardScreen(auditId: 'a')),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Analysis complete'), findsOneWidget);
    expect(find.text('\$0.00'), findsNothing);
    expect(
      find.textContaining('Premium impact is unavailable'),
      findsOneWidget,
    );
  });
  testWidgets('Needs input preserves real findings and estimate', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dashboardFutureProvider('a').overrideWith(
            (ref) async => {
              'audit': {'status': 'NEEDS_INPUT'},
              'vendors': [],
              'findings': [
                {
                  'kind': 'MISSING_WORK_DATES',
                  'vendor_id': 'v',
                  'data_json':
                      '{"estimate":{"estimatedPremiumImpactCents":12345},"reviewRequired":true}',
                },
              ],
            },
          ),
        ],
        child: const MaterialApp(home: DashboardScreen(auditId: 'a')),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Review required'), findsOneWidget);
    expect(find.text('MISSING WORK DATES'), findsOneWidget);
    expect(
      find.textContaining('Estimated premium impact: \$123.45'),
      findsOneWidget,
    );
  });
  testWidgets('Home retains existing audits and offers sign out', (
    tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          recentAuditsProvider.overrideWith(
            (ref) async => [
              {
                'id': 'existing-audit',
                'name': '2026 policy audit',
                'status': 'NEEDS_INPUT',
                'created_at': '2026-10-07',
              },
            ],
          ),
        ],
        child: const MaterialApp(home: StartScreen()),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('2026 policy audit'), findsOneWidget);
    expect(find.byTooltip('Sign out'), findsOneWidget);
    expect(find.textContaining('NEEDS_INPUT'), findsOneWidget);
  });
  testWidgets('Upload remains usable on a small screen with large text', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(320, 480));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      const ProviderScope(
        child: MaterialApp(
          home: MediaQuery(
            data: MediaQueryData(textScaler: TextScaler.linear(2)),
            child: UploadScreen(auditId: 'a'),
          ),
        ),
      ),
    );
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.text('RUN ANALYSIS'));
    expect(tester.takeException(), isNull);
  });

  testWidgets('Repeated analysis is disabled until the request finishes', (
    tester,
  ) async {
    final api = PendingAnalysisClient();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          dashboardFutureProvider('a').overrideWith(
            (ref) async => {
              'audit': {'status': 'NEEDS_INPUT'},
              'vendors': [],
              'findings': [],
            },
          ),
        ],
        child: const MaterialApp(home: DashboardScreen(auditId: 'a')),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('RUN ANALYSIS AGAIN'));
    await tester.pump();
    final button = tester.widget<TextButton>(
      find.widgetWithText(TextButton, 'STARTING ANALYSIS...'),
    );
    expect(button.onPressed, isNull);
    expect(api.analysisRequests, 1);
    api.pending.complete();
    await tester.pumpAndSettle();
    expect(find.text('RUN ANALYSIS AGAIN'), findsOneWidget);
  });
  testWidgets('Back navigation cannot dismiss an in-flight review', (
    tester,
  ) async {
    final pending = Completer<void>();
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => showReviewDialog(
                context,
                title: 'Review document',
                instruction: 'Review the original',
                fields: {},
                initial: {},
                save: (_, _) => pending.future,
              ),
              child: const Text('Open review'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open review'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm review'));
    await tester.pump();
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('Saving...'), findsOneWidget);
    pending.complete();
    await tester.pumpAndSettle();
    expect(find.text('Review document'), findsNothing);
  });
  testWidgets(
    'Failed extraction offers source entry instead of generic confirmation',
    (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dashboardFutureProvider('a').overrideWith(
              (ref) async => {
                'audit': {'status': 'NEEDS_INPUT'},
                'vendors': [
                  {'id': 'v', 'canonical_name': 'Acme'},
                ],
                'findings': [],
                'documents': [
                  {
                    'id': 'd',
                    'original_filename': 'certificate.pdf',
                    'processing_status': 'NEEDS_REVIEW',
                    'review_error': 'AI_UNAVAILABLE',
                  },
                ],
              },
            ),
          ],
          child: const MaterialApp(home: DashboardScreen(auditId: 'a')),
        ),
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Enter coverage from source'),
        300,
      );
      expect(
        find.textContaining('Automatic extraction failed'),
        findsOneWidget,
      );
      expect(find.text('Review'), findsNothing);
      await tester.tap(find.text('Enter coverage from source'));
      await tester.pumpAndSettle();
      expect(find.text('Named insured'), findsOneWidget);
      expect(find.byType(DropdownButtonFormField<String>), findsOneWidget);
      expect(
        find.text('Workers’ compensation section present'),
        findsOneWidget,
      );
      expect(
        find.text('Workers’ compensation coverage indicated'),
        findsOneWidget,
      );
    },
  );
}
