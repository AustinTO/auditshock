import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:file_picker/file_picker.dart';
import 'package:go_router/go_router.dart';
import '../api/api_client.dart';
import '../theme.dart';

class UploadScreen extends ConsumerStatefulWidget {
  final String auditId;
  const UploadScreen({super.key, required this.auditId});

  @override
  ConsumerState<UploadScreen> createState() => _UploadScreenState();
}

class _UploadScreenState extends ConsumerState<UploadScreen> {
  bool _isUploading = false;

  Future<void> _pickAndUpload() async {
    if (_isUploading) return;
    setState(() => _isUploading = true);
    try {
      final files = await FilePicker.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['pdf', 'csv', 'png', 'jpg', 'jpeg', 'txt', 'md'],
      );
      if (!mounted || files.isEmpty) return;
      final api = ref.read(apiClientProvider);
      for (final file in files) {
        final size = await file.length();
        if (size == null || size == 0 || size > 10 * 1024 * 1024) {
          throw StateError('Select a non-empty document up to 10 MB.');
        }
        await api.uploadDocumentBytes(
          widget.auditId,
          await file.readAsBytes(),
          file.name,
        );
        if (!mounted) return;
      }
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Documents uploaded successfully.')),
        );
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Upload failed. Check the file size and your connection, then retry.',
            ),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isUploading = false);
    }
  }

  Future<void> _analyze() async {
    if (_isUploading) return;
    setState(() => _isUploading = true);
    try {
      await ref.read(apiClientProvider).analyzeAudit(widget.auditId);
      if (mounted) {
        context.go('/dashboard/${widget.auditId}');
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Analysis could not start. Please retry.'),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _isUploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Add Documents')),
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              AuditShockTheme.backgroundDark,
              AuditShockTheme.surfaceDark,
            ],
          ),
        ),
        child: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(24.0),
              child: _isUploading
                  ? const CircularProgressIndicator(
                      color: AuditShockTheme.primaryTeal,
                    )
                  : SingleChildScrollView(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          const SizedBox(height: 24),
                          Card(
                            elevation: 0,
                            color: AuditShockTheme.surfaceDark.withValues(
                              alpha: 0.5,
                            ),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(24),
                              side: const BorderSide(
                                color: AuditShockTheme.primaryPurple,
                                width: 2,
                              ),
                            ),
                            child: Padding(
                              padding: const EdgeInsets.all(40.0),
                              child: Column(
                                children: [
                                  const Icon(
                                    Icons.cloud_upload_outlined,
                                    size: 64,
                                    color: AuditShockTheme.primaryTeal,
                                  ),
                                  const SizedBox(height: 24),
                                  const Text(
                                    'Upload Audit Documents',
                                    style: TextStyle(
                                      fontSize: 20,
                                      fontWeight: FontWeight.bold,
                                      color: Colors.white,
                                    ),
                                    textAlign: TextAlign.center,
                                  ),
                                  const SizedBox(height: 8),
                                  const Text(
                                    'Select Policies, COIs, and Vendor Ledgers.',
                                    style: TextStyle(
                                      color: AuditShockTheme.textMuted,
                                    ),
                                    textAlign: TextAlign.center,
                                  ),
                                  const SizedBox(height: 32),
                                  ElevatedButton.icon(
                                    onPressed: _pickAndUpload,
                                    icon: const Icon(Icons.folder_open),
                                    label: const Text('PICK FILES'),
                                  ),
                                ],
                              ),
                            ),
                          ),
                          const SizedBox(height: 24),
                          ElevatedButton(
                            style: ElevatedButton.styleFrom(
                              backgroundColor: AuditShockTheme.primaryTeal,
                            ),
                            onPressed: _analyze,
                            child: const Text(
                              'RUN ANALYSIS',
                              style: TextStyle(
                                color: AuditShockTheme.backgroundDark,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          const SizedBox(height: 24),
                        ],
                      ),
                    ),
            ),
          ),
        ),
      ),
    );
  }
}
