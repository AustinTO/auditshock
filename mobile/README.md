# AuditShock client

Flutter client for the authenticated AuditShock API. Set a different API origin with `--dart-define=AUDITSHOCK_API_URL=https://your-worker.example/v1`.

Run `flutter analyze` and `flutter test` before distribution. Upload a ledger and coverage documents, run analysis, then review policy assumptions, actual work dates, coverage fields and matching vendors in the dashboard. Inspect the original source documents before confirming extracted information. Run analysis again after completing reviews. The dashboard displays estimates only when the server supplies them.

## Android release signing

Release builds require `android/key.properties` containing:

```properties
storeFile=/absolute/path/to/release.jks
storePassword=your-store-password
keyAlias=your-key-alias
keyPassword=your-key-password
```

The properties and keystore are ignored by version control. A release build fails when these settings are absent. The Android application ID is `com.puphr.auditshock`. Configure signing through a secure CI secret or local file.

Native device interaction, Apple signing, and store publication require platform-specific validation beyond the widget/API tests.
