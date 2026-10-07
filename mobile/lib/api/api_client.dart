import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final apiClientProvider = Provider<ApiClient>((ref) {
  return ApiClient();
});

class ApiClient extends ChangeNotifier {
  final Dio _dio;

  static const baseUrl = String.fromEnvironment(
    'AUDITSHOCK_API_URL',
    defaultValue: 'https://auditshock-api.austintaylorodell.workers.dev/v1',
  );
  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  ApiClient({Dio? dio})
    : _dio =
          dio ??
          Dio(
            BaseOptions(
              baseUrl: baseUrl,
              connectTimeout: const Duration(seconds: 15),
              receiveTimeout: const Duration(seconds: 60),
            ),
          ) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onError: (error, handler) async {
          try {
            if (error.response?.statusCode == 401) {
              final token = await _storage.read(key: 'auth_token');
              // A delayed response from an old session must not erase a new one.
              if (token != null &&
                  error.requestOptions.headers['Authorization'] ==
                      'Bearer $token') {
                await _storage.delete(key: 'auth_token');
                notifyListeners();
              }
            }
          } finally {
            handler.next(error);
          }
        },
        onRequest: (options, handler) async {
          final token = await _storage.read(key: 'auth_token');
          if (token != null) {
            options.headers['Authorization'] = 'Bearer $token';
          }
          return handler.next(options);
        },
      ),
    );
  }

  Future<bool> get isLoggedIn async {
    final token = await _storage.read(key: 'auth_token');
    return token != null && token.isNotEmpty;
  }

  Future<void> requestOtp(String email) async {
    await _dio.post('/auth/request-otp', data: {'email': email});
  }

  Future<void> verifyOtp(String email, String code) async {
    final response = await _dio.post(
      '/auth/verify-otp',
      data: {'email': email, 'code': code},
    );
    final newToken = response.data['token'];
    if (newToken is! String || newToken.isEmpty) {
      throw const FormatException('The server returned an invalid session.');
    }
    await _storage.write(key: 'auth_token', value: newToken);
  }

  Future<void> logout() async {
    try {
      await _dio.post('/auth/logout');
    } catch (_) {
      // Local sign out remains available if the server is unreachable.
    } finally {
      await _storage.delete(key: 'auth_token');
      notifyListeners();
    }
  }

  Future<List<dynamic>> listAudits() async {
    final response = await _dio.get('/audits');
    return response.data['audits'] as List<dynamic>;
  }

  Future<String> createAudit({
    required String name,
    String? start,
    String? end,
  }) async {
    final response = await _dio.post(
      '/audits',
      data: {
        'name': name,
        'policy_period_start': ?start,
        'policy_period_end': ?end,
      },
    );
    return response.data['auditId'];
  }

  Future<String> uploadDocumentBytes(
    String auditId,
    List<int> bytes,
    String fileName,
  ) async {
    final formData = FormData.fromMap({
      'file': MultipartFile.fromBytes(bytes, filename: fileName),
    });
    final response = await _dio.post(
      '/audits/$auditId/documents',
      data: formData,
    );
    return response.data['docId'];
  }

  Future<void> updateAudit(String auditId, Map<String, dynamic> values) async {
    await _dio.patch('/audits/$auditId', data: values);
  }

  Future<void> reviewPayment(
    String auditId,
    String paymentId,
    Map<String, dynamic> values,
  ) async {
    await _dio.patch('/audits/$auditId/payments/$paymentId', data: values);
  }

  Future<void> reviewCoverage(
    String auditId,
    String coverageId,
    Map<String, dynamic> values,
  ) async {
    await _dio.post(
      '/audits/$auditId/coverage/$coverageId/confirm',
      data: values,
    );
  }

  Future<void> enterDocumentCoverage(
    String auditId,
    String documentId,
    Map<String, dynamic> values,
  ) async {
    await _dio.post(
      '/audits/$auditId/documents/$documentId/coverage',
      data: values,
    );
  }

  Future<List<int>> downloadDocument(String auditId, String documentId) async {
    final response = await _dio.get<List<int>>(
      '/audits/$auditId/documents/$documentId/content',
      options: Options(responseType: ResponseType.bytes),
    );
    return response.data!;
  }

  Future<void> confirmDocument(String auditId, String documentId) async {
    await _dio.post(
      '/audits/$auditId/documents/$documentId/confirm',
      data: {'confirmed': true},
    );
  }

  Future<void> analyzeAudit(String auditId) async {
    await _dio.post('/audits/$auditId/analyze');
  }

  Future<String> getAuditStatus(String auditId) async {
    final response = await _dio.get('/audits/$auditId/status');
    return response.data['status'];
  }

  Future<Map<String, dynamic>> getAuditResults(String auditId) async {
    final response = await _dio.get('/audits/$auditId/results');
    return response.data;
  }
}
