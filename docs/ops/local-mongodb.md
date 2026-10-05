# Local MongoDB for Test Data Lab

Migrated on 2026-10-04 (local time). Test Data Lab uses database `qbo-support-lab` on `127.0.0.1:27017` in the existing authenticated `DLsocialMongoDB` Windows service. Its account `test_data_lab` has read/write access only to this database. The listener accepts localhost connections; authentication remains enabled.

The service starts automatically with Windows. Database files are under `D:\DLsocial\mongodb`; D: must be available. The single-member replica set is `dlsocial-local`. This is shared infrastructure with DLsocial, with separate databases and app accounts. Do not stop or reconfigure the service as part of ordinary app startup.

The ignored root `.env` contains the local connection credential. Normal app startup remains `npm run dev`. QuickBooks production access is unchanged and still requires the internet.

## Migration and verification

Fourteen Atlas collections and all 139 source records were copied, including users, saved QuickBooks authorizations, cases/plans, company memberships, checkpoints, and audit history. Records and indexes matched the source snapshot exactly before cutover. A local-only migration audit entry was written and read back through the running app; that entry was absent from Atlas. App health and saved QuickBooks connection-status reads returned HTTP 200. No QuickBooks mutation or new OAuth flow was performed.

Protected source snapshots, checksums, the original environment backup, local credentials, verification receipts, and a post-migration `mongodump` archive are under `%LOCALAPPDATA%\TestDataLab\database-migration-20261004`. Never expose or commit that folder. Atlas remains an old recovery copy; new app writes go only to this PC. Do not switch back to Atlas without reconciling newer local records.

## Backups and recovery

The existing backup script uses a cluster-wide authenticated `mongodump --oplog --gzip` with no database restriction, so any future successful run includes `qbo-support-lab`. The DLsocial operations guide records a Windows task named `DLsocial MongoDB Daily Backup`, scheduled for 03:00 local time, retaining 14 archives under `C:/ProgramData/DLsocial/MongoDB/backups`. This migration could not verify its current task status because Task Scheduler access was denied; scheduled-backup readiness remains unverified. Configuration and credentials remain in the existing protected MongoDB setup.

The migration also created `local-after-migration.archive.gz`, containing just Test Data Lab. To recover, restore a verified archive into an isolated database first, verify records and indexes, and then authorize a cutover. Backups stored on this PC do not protect against loss of the whole PC.
