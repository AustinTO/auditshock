import 'dart:convert';
import 'dart:typed_data';
import 'package:auditshock/api/api_client.dart';
import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

class RecordingAdapter implements HttpClientAdapter {
  RequestOptions? request;
  int statusCode = 200;
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    request = options;
    return ResponseBody.fromString(
      jsonEncode({'auditId': 'audit-1', 'docId': 'doc-1'}),
      statusCode,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test(
    'Create audit omits absent optional dates required by server schema',
    () async {
      final adapter = RecordingAdapter();
      final dio = Dio(BaseOptions(baseUrl: 'https://example.test/v1'))
        ..httpClientAdapter = adapter;
      expect(
        await ApiClient(dio: dio).createAudit(name: 'Fixture audit'),
        'audit-1',
      );
      expect(adapter.request!.data, {'name': 'Fixture audit'});
    },
  );

  test(
    'Web-compatible upload includes bytes instead of relying on a disk path',
    () async {
      final adapter = RecordingAdapter();
      final dio = Dio(BaseOptions(baseUrl: 'https://example.test/v1'))
        ..httpClientAdapter = adapter;
      expect(
        await ApiClient(dio: dio).uploadDocumentBytes(
          'audit-1',
          utf8.encode('vendor,amount\nAcme,100'),
          'ledger.csv',
        ),
        'doc-1',
      );
      final file = (adapter.request!.data as FormData).files.single.value;
      expect(file.filename, 'ledger.csv');
      expect(file.length, utf8.encode('vendor,amount\nAcme,100').length);
    },
  );
  test('Unauthorized response clears expired local session', () async {
    FlutterSecureStorage.setMockInitialValues({'auth_token': 'expired'});
    final adapter = RecordingAdapter()..statusCode = 401;
    final dio = Dio(BaseOptions(baseUrl: 'https://example.test/v1'))
      ..httpClientAdapter = adapter;
    final api = ApiClient(dio: dio);
    await expectLater(api.listAudits(), throwsA(isA<DioException>()));
    expect(await api.isLoggedIn, isFalse);
  });

  test('Sign out clears local session when server request fails', () async {
    FlutterSecureStorage.setMockInitialValues({'auth_token': 'expired'});
    final adapter = RecordingAdapter()..statusCode = 500;
    final dio = Dio(BaseOptions(baseUrl: 'https://example.test/v1'))
      ..httpClientAdapter = adapter;
    final api = ApiClient(dio: dio);
    await api.logout();
    expect(adapter.request!.path, '/auth/logout');
    expect(await api.isLoggedIn, isFalse);
  });
  test('An old unauthorized response preserves a newer session', () async {
    FlutterSecureStorage.setMockInitialValues({'auth_token': 'old-session'});
    final adapter = RecordingAdapter()..statusCode = 401;
    final dio = Dio(BaseOptions(baseUrl: 'https://example.test/v1'))
      ..httpClientAdapter = adapter;
    final api = ApiClient(dio: dio);
    dio.interceptors.add(
      InterceptorsWrapper(
        onError: (error, handler) async {
          handler.next(error);
        },
        onRequest: (options, handler) async {
          await const FlutterSecureStorage().write(
            key: 'auth_token',
            value: 'new-session',
          );
          handler.next(options);
        },
      ),
    );
    await expectLater(api.listAudits(), throwsA(isA<DioException>()));
    expect(
      await const FlutterSecureStorage().read(key: 'auth_token'),
      'new-session',
    );
  });

  test(
    'Unauthorized response notifies the router to recheck its session',
    () async {
      FlutterSecureStorage.setMockInitialValues({'auth_token': 'expired'});
      final adapter = RecordingAdapter()..statusCode = 401;
      final dio = Dio(BaseOptions(baseUrl: 'https://example.test/v1'))
        ..httpClientAdapter = adapter;
      final api = ApiClient(dio: dio);
      var invalidations = 0;
      api.addListener(() => invalidations++);
      await expectLater(api.listAudits(), throwsA(isA<DioException>()));
      expect(invalidations, 1);
    },
  );
  test(
    'Manual coverage recovery submits reviewed source data to its document',
    () async {
      final adapter = RecordingAdapter();
      final dio = Dio(BaseOptions(baseUrl: 'https://example.test/v1'))
        ..httpClientAdapter = adapter;
      final values = {
        'vendor_id': 'vendor-1',
        'named_insured': 'Acme',
        'effective_date': '2026-01-01',
        'expiration_date': '2026-12-31',
        'wc_section_present': true,
        'wc_coverage_indicated': true,
      };
      await ApiClient(
        dio: dio,
      ).enterDocumentCoverage('audit-1', 'doc-1', values);
      expect(adapter.request!.method, 'POST');
      expect(adapter.request!.path, '/audits/audit-1/documents/doc-1/coverage');
      expect(adapter.request!.data, values);
    },
  );
}
