import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../api/api_client.dart';
import 'review_dialog.dart';

final dashboardFutureProvider = FutureProvider.autoDispose
    .family<Map<String, dynamic>, String>((ref, auditId) async {
      final result = await ref.read(apiClientProvider).getAuditResults(auditId);
      if (result['audit']['status'] == 'PROCESSING') {
        final timer = Timer(const Duration(seconds: 3), ref.invalidateSelf);
        ref.onDispose(timer.cancel);
      }
      return result;
    });

class DashboardScreen extends ConsumerStatefulWidget {
  final String auditId;
  const DashboardScreen({super.key, required this.auditId});

  @override
  ConsumerState<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends ConsumerState<DashboardScreen> {
  bool _analyzing = false;
  String get auditId => widget.auditId;

  Map<String, String> strings(Map row, Iterable<String> keys) => {
    for (final key in keys) key: row[key]?.toString() ?? '',
  };

  Future<void> review(
    BuildContext context,
    String title,
    String instruction,
    Map<String, String> fields,
    Map row,
    Future<void> Function(Map<String, String>, Map<String, bool>) save, {
    Map<String, bool> checks = const {},
    Map<String, Map<String, String>> choices = const {},
  }) async {
    final saved = await showReviewDialog(
      context,
      title: title,
      instruction: instruction,
      fields: fields,
      initial: strings(row, fields.keys),
      checks: checks,
      choices: choices,
      save: save,
    );
    if (saved && mounted) ref.invalidate(dashboardFutureProvider(auditId));
  }

  @override
  Widget build(BuildContext context) {
    final results = ref.watch(dashboardFutureProvider(auditId));
    final api = ref.read(apiClientProvider);
    void refresh() => ref.invalidate(dashboardFutureProvider(auditId));
    return Scaffold(
      appBar: AppBar(
        title: const Text('Results Dashboard'),
        actions: [
          IconButton(
            tooltip: 'Your audits',
            icon: const Icon(Icons.home),
            onPressed: () => context.go('/'),
          ),
          IconButton(
            tooltip: 'Add documents',
            icon: const Icon(Icons.upload_file),
            onPressed: () => context.go('/upload/$auditId'),
          ),
          IconButton(
            tooltip: 'Refresh results',
            icon: const Icon(Icons.refresh),
            onPressed: refresh,
          ),
        ],
      ),
      body: results.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('Unable to load results. Check your connection.'),
              TextButton(onPressed: refresh, child: const Text('Retry')),
              TextButton(
                onPressed: () => context.go('/login'),
                child: const Text('Sign in'),
              ),
            ],
          ),
        ),
        data: (data) {
          final audit = data['audit'] as Map<String, dynamic>;
          final vendors = data['vendors'] as List? ?? [];
          final findings = data['findings'] as List? ?? [];
          final payments = data['payments'] as List? ?? [];
          final coverages = data['coverages'] as List? ?? [];
          final documents = data['documents'] as List? ?? [];
          final status = audit['status'];
          if (status == 'PROCESSING') {
            return const Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  CircularProgressIndicator(),
                  SizedBox(height: 20),
                  Text('Analysis is running...'),
                ],
              ),
            );
          }
          return ListView(
            padding: const EdgeInsets.all(24),
            children: [
              Text(
                status == 'COMPLETE'
                    ? 'Analysis complete'
                    : status == 'NEEDS_INPUT'
                    ? 'Review required'
                    : 'Audit status: $status',
                style: const TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 12),
              const Text(
                'Confirm the policy period and premium assumptions, review work dates and original coverage documents, then run analysis again. Estimates describe potential exposure under those assumptions and require professional review.',
              ),
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: () => review(
                  context,
                  'Policy and assumptions',
                  'Enter inclusive policy dates as YYYY-MM-DD and the workers’ compensation rate in dollars per \$100. Full vendor payments are the exposure basis. Confirm only after reviewing your policy.',
                  {
                    'policy_period_start': 'Policy start (YYYY-MM-DD)',
                    'policy_period_end': 'Policy end (YYYY-MM-DD)',
                    'rate': 'Rate dollars per \$100',
                  },
                  {
                    ...audit,
                    'rate': audit['wc_rate_micros_per_100'] == null
                        ? ''
                        : (audit['wc_rate_micros_per_100'] as num) / 1000000,
                  },
                  (fields, _) async {
                    final rate = double.tryParse(fields['rate']!);
                    if (rate == null || !rate.isFinite || rate < 0) {
                      throw const FormatException('Invalid rate');
                    }
                    await api.updateAudit(auditId, {
                      'policy_period_start': fields['policy_period_start'],
                      'policy_period_end': fields['policy_period_end'],
                      'exposure_basis': 'FULL_VENDOR_PAYMENTS',
                      'wc_rate_micros_per_100': (rate * 1000000).round(),
                      'assumptions_confirmed': true,
                    });
                  },
                ),
                child: const Text('REVIEW POLICY AND ASSUMPTIONS'),
              ),
              TextButton(
                onPressed: _analyzing
                    ? null
                    : () async {
                        if (_analyzing) return;
                        setState(() => _analyzing = true);
                        try {
                          await api.analyzeAudit(auditId);
                          if (mounted) refresh();
                        } catch (_) {
                          if (context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(
                                content: Text(
                                  'Analysis could not start. Complete document review and retry.',
                                ),
                              ),
                            );
                          }
                        } finally {
                          if (mounted) setState(() => _analyzing = false);
                        }
                      },
                child: Text(
                  _analyzing ? 'STARTING ANALYSIS...' : 'RUN ANALYSIS AGAIN',
                ),
              ),
              const SizedBox(height: 24),
              Text('${vendors.length} vendors • ${findings.length} findings'),
              ...findings.map((finding) {
                Map details = {};
                try {
                  details = jsonDecode(finding['data_json'] ?? '{}') as Map;
                } catch (_) {
                  /* Legacy result without structured details. */
                }
                final estimate = details['estimate'] as Map?;
                final premium =
                    estimate?['estimatedPremiumImpactCents'] as num?;
                return Card(
                  child: ListTile(
                    title: Text(
                      (finding['kind'] ?? 'Review required')
                          .toString()
                          .replaceAll('_', ' '),
                    ),
                    subtitle: Text(
                      [
                        'Vendor: ${vendors.where((v) => v['id'] == finding['vendor_id']).map((v) => v['canonical_name'] ?? v['normalized_name']).firstOrNull ?? finding['vendor_id']}',
                        if (premium != null)
                          'Estimated premium impact: \$${(premium / 100).toStringAsFixed(2)}'
                        else
                          'Premium impact is unavailable until a rate and exposure assumptions are confirmed.',
                        if (details['reviewRequired'] == true)
                          'Original documents require human review.',
                        if (details['payments'] != null)
                          'Payment coverage: ${jsonEncode(details['payments'])}',
                      ].join('\n'),
                    ),
                  ),
                );
              }),
              if (findings.isEmpty)
                const Text(
                  'No findings recorded yet. This does not establish insurance coverage.',
                ),
              const SizedBox(height: 24),
              const Text(
                'Payment work dates',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
              ),
              ...payments.map(
                (payment) => Card(
                  child: ListTile(
                    title: Text('Payment ${payment['id']}'),
                    subtitle: Text(
                      '${payment['work_start_date'] ?? 'Start missing'} – ${payment['work_end_date'] ?? 'End missing'}',
                    ),
                    trailing: const Icon(Icons.edit),
                    onTap: () => review(
                      context,
                      'Review work dates',
                      'Use the actual period when the work was performed, not the payment date. Enter YYYY-MM-DD.',
                      {
                        'work_start_date': 'Work start',
                        'work_end_date': 'Work end',
                      },
                      payment,
                      (fields, _) =>
                          api.reviewPayment(auditId, payment['id'], fields),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 24),
              const Text(
                'Coverage review',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
              ),
              ...coverages.map(
                (coverage) => Card(
                  child: ListTile(
                    title: Text(coverage['named_insured'] ?? 'Unnamed insured'),
                    subtitle: Text(
                      '${coverage['review_status']} • ${coverage['effective_date']} – ${coverage['expiration_date']}',
                    ),
                    trailing: const Icon(Icons.edit),
                    onTap: () => review(
                      context,
                      'Confirm coverage and vendor',
                      'Inspect the original certificate before confirming. Select the matching vendor. Dates use YYYY-MM-DD.',
                      {
                        'vendor_id': 'Vendor',
                        'named_insured': 'Named insured',
                        'effective_date': 'Effective date',
                        'expiration_date': 'Expiration date',
                      },
                      coverage,
                      (
                        fields,
                        checks,
                      ) => api.reviewCoverage(auditId, coverage['id'], {
                        ...fields,
                        'wc_section_present':
                            checks['Workers’ compensation section present'],
                        'wc_coverage_indicated':
                            checks['Workers’ compensation coverage indicated'],
                      }),
                      choices: {
                        'vendor_id': {
                          for (final vendor in vendors)
                            vendor['id'].toString():
                                (vendor['canonical_name'] ??
                                        vendor['normalized_name'] ??
                                        'Unknown vendor')
                                    .toString(),
                        },
                      },
                      checks: {
                        'Workers’ compensation section present':
                            coverage['wc_section_present'] == 1,
                        'Workers’ compensation coverage indicated':
                            coverage['wc_coverage_indicated'] == 1,
                      },
                    ),
                  ),
                ),
              ),
              ...vendors.map(
                (vendor) => ListTile(
                  title: Text(
                    vendor['canonical_name'] ??
                        vendor['normalized_name'] ??
                        'Unknown vendor',
                  ),
                ),
              ),
              const SizedBox(height: 24),
              const Text(
                'Document review',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
              ),
              ...documents.map(
                (document) => Card(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      ListTile(
                        title: Text(
                          document['original_filename'] ?? 'Document',
                        ),
                        subtitle: Text(
                          [
                            document['processing_status'] ?? '',
                            if (document['review_error'] != null)
                              'Automatic extraction failed. Inspect the original document and enter its coverage details manually.',
                          ].join('\n'),
                        ),
                        onTap: () async {
                          try {
                            final bytes = await api.downloadDocument(
                              auditId,
                              document['id'],
                            );
                            if (!context.mounted) return;
                            await FilePicker.saveFile(
                              fileName:
                                  document['original_filename'] ?? 'document',
                              bytes: Uint8List.fromList(bytes),
                              mimeType:
                                  document['mime_type'] ??
                                  'application/octet-stream',
                            );
                          } catch (_) {
                            if (context.mounted) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(
                                  content: Text(
                                    'Unable to save the original document. Please retry.',
                                  ),
                                ),
                              );
                            }
                          }
                        },
                        leading: const Icon(Icons.download),
                        trailing:
                            document['processing_status'] == 'NEEDS_REVIEW' &&
                                document['review_error'] == null
                            ? TextButton(
                                onPressed: () => review(
                                  context,
                                  'Confirm original document review',
                                  'Inspect the original uploaded document before confirming. This confirms review of extraction only; coverage must be confirmed separately above.',
                                  const {},
                                  document,
                                  (_, _) => api.confirmDocument(
                                    auditId,
                                    document['id'],
                                  ),
                                ),
                                child: const Text('Review'),
                              )
                            : null,
                      ),
                      if (document['review_error'] != null)
                        TextButton(
                          onPressed: () => review(
                            context,
                            'Enter coverage from source',
                            'Download and inspect the original certificate, then enter its coverage details. Select the matching vendor and confirm the workers’ compensation information. Dates use YYYY-MM-DD.',
                            {
                              'vendor_id': 'Vendor',
                              'named_insured': 'Named insured',
                              'effective_date': 'Effective date',
                              'expiration_date': 'Expiration date',
                            },
                            const {},
                            (fields, checks) => api.enterDocumentCoverage(
                              auditId,
                              document['id'],
                              {
                                ...fields,
                                'wc_section_present':
                                    checks['Workers’ compensation section present'],
                                'wc_coverage_indicated':
                                    checks['Workers’ compensation coverage indicated'],
                              },
                            ),
                            choices: {
                              'vendor_id': {
                                for (final vendor in vendors)
                                  vendor['id'].toString():
                                      (vendor['canonical_name'] ??
                                              vendor['normalized_name'] ??
                                              'Unknown vendor')
                                          .toString(),
                              },
                            },
                            checks: const {
                              'Workers’ compensation section present': false,
                              'Workers’ compensation coverage indicated': false,
                            },
                          ),
                          child: const Text('Enter coverage from source'),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
